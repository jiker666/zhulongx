import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveCampaignManager, DurableAdaptiveCampaignStore } from "../src/adaptive-campaign.js";
import type { SharedEvidenceBoard } from "../src/shared-evidence.js";
import type { RunState, TaskRequest } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function state(id: string, request: TaskRequest, status: RunState["status"]): RunState {
  const timestamp = new Date().toISOString();
  return {
    id, status, phase: "done", task: { task: request.task, attachments: [], metadata: request.metadata ?? {} },
    createdAt: timestamp, updatedAt: timestamp, finishedAt: timestamp,
    findings: status === "completed" ? [{ id: "finding-1", title: "Observed bounded behavior", severity: "low", confidence: 0.8, description: "The faux worker produced a reproducible observation", evidence: ["tool.result:1"] }] : [],
    lessons: [], hypotheses: [], strategyRevisions: [], strategyRevisionRequired: false,
    sandboxNamespace: id, scratchRoot: "/tmp/campaign", workspaceMode: "attachments-only", appliedExperienceIds: [],
    ...(status === "completed" ? { submission: "candidate", verification: ["platform verifier accepted the observation"] } : {}),
    ...(status === "completed" ? { independentlyVerified: true } : {}),
    summary: status === "completed" ? "Verified faux result" : "The first path was blocked",
    ...(status === "blocked" ? { stopReason: "No bounded verification was available" } : {}),
    turns: 2, toolCalls: 3, imageObservations: 0, httpRequests: 0, tcpSessions: 0,
    actionsSinceCheckpoint: 0, repeatedActions: {},
  };
}

describe("AdaptiveCampaign", () => {
  it("runs independent lanes, curates public evidence, and escalates only blocked work", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-campaign-")); roots.push(root);
    const store = new DurableAdaptiveCampaignStore(root);
    let runNumber = 0;
    const requests: Array<{ request: TaskRequest; contextSections?: Array<{ name: string; content: string }>; sharedEvidence?: SharedEvidenceBoard }> = [];
    const states = new Map<string, RunState>();
    const runManager = {
      start: vi.fn((request: TaskRequest, options?: { sharedEvidence?: SharedEvidenceBoard; contextSections?: Array<{ name: string; content: string }> }) => {
        const id = `run-${++runNumber}`;
        requests.push({ request, ...(options?.contextSections ? { contextSections: options.contextSections } : {}), ...(options?.sharedEvidence ? { sharedEvidence: options.sharedEvidence } : {}) });
        states.set(id, state(id, request, runNumber === 1 ? "blocked" : "completed"));
        return id;
      }),
      wait: vi.fn(async (id: string) => states.get(id)!),
      stop: vi.fn(() => true),
    };
    const manager = new AdaptiveCampaignManager({ store, runManager, leaseMs: 500, idlePollMs: 1 });
    const started = await manager.start({ name: "faux adaptive", tasks: ["analyze artifact"], raceAgents: 2, concurrency: 2 });
    await vi.waitFor(async () => expect((await manager.get(started.id))?.status).toBe("completed"), { timeout: 2_000 });
    const campaign = await manager.get(started.id);
    expect(campaign).toMatchObject({ status: "completed", verifiedRuns: 2, succeeded: 2, blocked: 1, currentTier: 1 });
    expect(campaign?.items.filter((item) => item.tier === 1)).toHaveLength(1);
    expect(campaign?.curation.length).toBeGreaterThanOrEqual(2);
    expect(campaign?.events.some((event) => event.type === "campaign.task.queued" && event.detail?.includes("Tier 1"))).toBe(true);
    expect(requests[0]?.contextSections?.map((section) => section.name)).toEqual(["campaign-board", "campaign-curator", "claimed-investigation"]);
    expect(requests[0]?.sharedEvidence).toBeDefined();
    expect(requests[0]?.request.metadata).toMatchObject({ campaignId: started.id, campaignTier: "0" });
  });

  it("protects task claims with lease generations and redacts sensitive curation", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-campaign-store-")); roots.push(root);
    const store = new DurableAdaptiveCampaignStore(root, { maxEvents: 12 });
    const campaign = await store.create({ name: "bounded", tasks: [{ task: "Authorization: Bearer hidden" }], concurrency: 1, raceAgents: 1, budget: { maxRuntimeMs: 10_000, maxWorkers: 1, maxItems: 10, maxRuns: 10 }, tiers: [{ tier: 0, label: "one", maxAttempts: 1 }] });
    const first = await store.claimNext(campaign.id, "worker-a", 1);
    expect(first).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.claimNext(campaign.id, "worker-b", 500);
    expect(second?.leaseGeneration).toBe(2);
    await expect(store.settle({ campaignId: campaign.id, itemId: first!.id, workerId: "worker-a", generation: 1, status: "succeeded", summary: "late" })).rejects.toThrow("Stale campaign work lease");
    await store.addCuration(campaign.id, { itemId: second!.id, summary: "Authorization: Bearer hidden", evidence: [{ kind: "fact", claim: "Cookie: session=hidden", evidence: ["access_token=hidden"], confidence: 0.8 }], proposedTasks: [] });
    expect(JSON.stringify(await store.get(campaign.id))).not.toContain("hidden");
  });

  it("resumes queued campaigns after a manager restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-campaign-resume-")); roots.push(root);
    const store = new DurableAdaptiveCampaignStore(root);
    const campaign = await store.create({ name: "resume", tasks: [{ task: "continue" }], concurrency: 1, raceAgents: 1, budget: { maxRuntimeMs: 10_000, maxWorkers: 1, maxItems: 4, maxRuns: 4 }, tiers: [{ tier: 0, label: "one", maxAttempts: 1 }] });
    const timestamp = new Date().toISOString();
    const runManager = {
      start: vi.fn((request: TaskRequest) => { runManager.states.set("run-resume", state("run-resume", request, "completed")); return "run-resume"; }),
      wait: vi.fn(async () => runManager.states.get("run-resume")!),
      stop: vi.fn(() => true),
      states: new Map<string, RunState>(),
    };
    const manager = new AdaptiveCampaignManager({ store, runManager, idlePollMs: 1 });
    await manager.resumePending();
    await vi.waitFor(async () => expect((await manager.get(campaign.id))?.status).toBe("completed"), { timeout: 2_000 });
    expect(runManager.start).toHaveBeenCalledOnce();
    expect((await store.get(campaign.id))?.updatedAt).not.toBe(timestamp);
  });
});
