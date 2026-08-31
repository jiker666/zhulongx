import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain } from "../src/audit.js";
import { appendRunReview, listPersistedRuns, loadDecisionTrace } from "../src/trace.js";
import { projectRunSummary, RUN_SUMMARY_FILE } from "../src/run-summary.js";
import type { RunState } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("decision trace", () => {
  it("lists an existing compact summary without parsing the complete state", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-trace-summary-"));
    roots.push(root);
    const runId = "11111111-1111-4111-8111-111111111111";
    const runRoot = join(root, runId);
    await mkdir(runRoot, { recursive: true });
    await writeFile(join(runRoot, "state.json"), "{ incomplete state", "utf8");
    await writeFile(join(runRoot, RUN_SUMMARY_FILE), JSON.stringify({
      id: runId,
      status: "completed",
      phase: "done",
      task: "Compact summary fixture",
      createdAt: "2026-08-31T00:00:00.000Z",
      turns: 3,
      toolCalls: 4,
      lessons: 1,
    }), "utf8");

    await expect(listPersistedRuns(root)).resolves.toEqual([expect.objectContaining({ id: runId, task: "Compact summary fixture", status: "completed" })]);
  });

  it("builds a hash-verified external trace and attaches human correction", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-trace-"));
    roots.push(root);
    const runId = "22222222-2222-4222-8222-222222222222";
    const runRoot = join(root, runId);
    await mkdir(runRoot, { recursive: true });
    const audit = new AuditChain(join(runRoot, "audit.jsonl"), runId);
    await audit.append("turn.started", { turn: 1 });
    await audit.append("assistant.message", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden chain must never be projected" },
        {
          type: "text",
          text: `I will inspect the bounded artifact. Authorization: Bearer private-value. ${"x".repeat(1400)}`,
        },
      ],
    });
    await audit.append("plan.submitted", { goal: "Inspect evidence", steps: [] });
    const action = await audit.append("policy.decision", { toolName: "file", allowed: true, reason: "Allowed" });
    await audit.append("tool.result", { toolName: "file", isError: false, content: "ELF" });
    await audit.append("decision.checkpoint", { assessment: "Native binary confirmed", nextAction: "Disassemble" });
    await audit.append("hypothesis.updated", {
      updates: [{ hypothesis: "The artifact is native", status: "confirmed", evidence: ["ELF magic"] }],
      ledger: [],
    });
    await audit.append("strategy.revised", {
      revision: { classification: "tool", nextAction: "Use objdump", rationale: "Decompiler unavailable" },
    });
    await audit.flush();
    const now = new Date().toISOString();
    const state = {
      id: runId,
      status: "completed",
      phase: "done",
      task: { task: "Inspect", attachments: [], metadata: { category: "Pwn" } },
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      findings: [],
      lessons: [],
      hypotheses: [],
      strategyRevisions: [],
      strategyRevisionRequired: false,
      sandboxNamespace: runId,
      scratchRoot: join(root, "scratch", runId),
      workspaceMode: "configured",
      appliedExperienceIds: [],
      turns: 2,
      toolCalls: 2,
      imageObservations: 0,
      httpRequests: 0,
      tcpSessions: 0,
      actionsSinceCheckpoint: 0,
      repeatedActions: {},
    } satisfies RunState;
    await writeFile(join(runRoot, "state.json"), JSON.stringify(state), "utf8");
    await writeFile(join(runRoot, RUN_SUMMARY_FILE), JSON.stringify(projectRunSummary(state)), "utf8");

    const review = await appendRunReview(root, runId, {
      sequence: action.sequence,
      verdict: "incorrect",
      note: "The action was allowed but not useful.",
      correction: "Prefer a protection check first.",
    });
    const trace = await loadDecisionTrace(root, runId);
    expect(trace.integrity.valid).toBe(true);
    expect(trace.timeline.map((event) => event.kind)).toEqual([
      "turn",
      "decision",
      "plan",
      "action",
      "observation",
      "checkpoint",
      "hypothesis",
      "revision",
    ]);
    const projected = JSON.stringify(trace.timeline);
    expect(projected).not.toContain("hidden chain");
    expect(projected).not.toContain("private-value");
    const decision = trace.timeline.find((event) => event.kind === "decision");
    expect(decision?.data).toMatchObject({ text: expect.stringContaining("Authorization=[redacted]") });
    expect((decision?.data as { text: string }).text.length).toBeLessThanOrEqual(1200);
    expect(trace.reviews).toContainEqual(review);
    expect((await listPersistedRuns(root))[0]).toMatchObject({ id: runId, category: "Pwn" });
  });
});
