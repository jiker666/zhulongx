import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAgentStore } from "../src/agent-store.js";

const roots: string[] = [];
const budget = { maxRuntimeMs: 10_000, maxTokens: 1_000, maxCostMicros: 10_000 };

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function store(limits = {}) {
  const root = await mkdtemp(join(tmpdir(), "xuan-agents-")); roots.push(root); return new DurableAgentStore(root, limits);
}

describe("DurableAgentStore", () => {
  it("persists stable agent addresses, tasks and unread results", async () => {
    const first = await store();
    const root = await first.createAgent({ purpose: "addressable", profileId: "general" });
    const child = await first.createAgent({ parentAgentId: root.id, purpose: "joined", profileId: "readonly" });
    expect(child).toMatchObject({ rootAgentId: root.id, parentAgentId: root.id, depth: 1, path: expect.stringContaining(root.path) });
    const task = await first.enqueueTask({ agentId: child.id, kind: "delegation", awaitPolicy: "join", cancelPolicy: "linked", message: "Analyze evidence", context: Array.from({ length: 20 }, (_, index) => `context-${index}`), budget });
    expect(task.context).toHaveLength(12);
    const claimed = await first.claimNext("worker-1", 5_000);
    expect(claimed).toMatchObject({ id: task.id, leaseGeneration: 1, leaseOwner: "worker-1", attempts: 1 });
    const result = await first.settleTask({ taskId: task.id, workerId: "worker-1", generation: 1, status: "succeeded", summary: "Done", artifacts: ["scratch:result.txt"], tokensUsed: 100, costUsedMicros: 20 });
    expect(result).toMatchObject({ unread: true, leaseGeneration: 1, status: "succeeded" });
    expect(await first.acknowledge(task.id)).toMatchObject({ unread: false, acknowledgedAt: expect.any(String) });

    const reopened = new DurableAgentStore(join(first.path, ".."));
    expect((await reopened.snapshot()).agents.map((item) => item.path)).toEqual([root.path, child.path]);
  });

  it("rejects a late worker result after lease generation changes", async () => {
    const value = await store();
    const agent = await value.createAgent({ purpose: "addressable", profileId: "general" });
    const task = await value.followupTask(agent.id, "work", { budget });
    const first = await value.claimNext("old-worker", 1);
    expect(first?.id).toBe(task.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await value.claimNext("new-worker", 5_000);
    expect(second).toMatchObject({ id: task.id, leaseGeneration: 2 });
    await expect(value.settleTask({ taskId: task.id, workerId: "old-worker", generation: 1, status: "succeeded", summary: "late" })).rejects.toThrow("Stale agent task lease");
    await expect(value.settleTask({ taskId: task.id, workerId: "new-worker", generation: 2, status: "succeeded", summary: "current" })).resolves.toMatchObject({ summary: "current" });
  });

  it("supports bounded mailbox delivery, follow-up and interruption", async () => {
    const value = await store({ maxMailboxMessages: 2 });
    const agent = await value.createAgent({ purpose: "addressable", profileId: "general" });
    await value.sendMessage(agent.id, "one"); await value.sendMessage(agent.id, "two"); await value.sendMessage(agent.id, "three");
    expect((await value.drainMessages(agent.id)).map((item) => item.text)).toEqual(["two", "three"]);
    expect(await value.drainMessages(agent.id)).toEqual([]);
    const task = await value.followupTask(agent.id, "next round", { awaitPolicy: "background", budget });
    expect(task).toMatchObject({ status: "queued", awaitPolicy: "background" });
    expect(await value.interruptAgent(agent.id)).toMatchObject({ status: "interrupted" });
    expect((await value.snapshot()).tasks.find((item) => item.id === task.id)?.status).toBe("cancelled");
  });

  it("enforces nesting, task and provider budgets", async () => {
    const value = await store({ maxDepth: 1, maxTasks: 1 });
    const root = await value.createAgent({ purpose: "addressable", profileId: "general" });
    const child = await value.createAgent({ parentAgentId: root.id, purpose: "joined", profileId: "general" });
    await expect(value.createAgent({ parentAgentId: child.id, purpose: "joined", profileId: "general" })).rejects.toThrow("nesting limit");
    const task = await value.followupTask(child.id, "one", { budget: { ...budget, maxTokens: 10 } });
    await expect(value.followupTask(child.id, "two", { budget })).rejects.toThrow("task budget");
    const claimed = await value.claimNext("worker", 5_000);
    await expect(value.settleTask({ taskId: task.id, workerId: "worker", generation: claimed!.leaseGeneration, status: "succeeded", summary: "too costly", tokensUsed: 11 })).rejects.toThrow("provider budget");
  });

  it("recovers from a truncated store file instead of throwing", async () => {
    const first = await store();
    await first.createAgent({ purpose: "addressable", profileId: "general" });
    const { writeFile, readdir } = await import("node:fs/promises");
    await writeFile(first.path, "");
    const reopened = new DurableAgentStore(join(first.path, ".."));
    const snapshot = await reopened.snapshot();
    expect(snapshot.agents).toEqual([]);
    const quarantined = (await readdir(join(first.path, ".."))).filter((name) => name.startsWith("agents.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    const after = await reopened.createAgent({ purpose: "addressable", profileId: "general" });
    expect((await reopened.snapshot()).agents.map((item) => item.id)).toEqual([after.id]);
  });
});
