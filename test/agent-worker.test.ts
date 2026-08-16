import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DurableAgentStore } from "../src/agent-store.js";
import { BoundedAgentWorker } from "../src/agent-worker.js";

const roots: string[] = [];
const budget = { maxRuntimeMs: 1_000, maxTokens: 1_000, maxCostMicros: 10_000 };

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "xuan-agent-worker-")); roots.push(root);
  const store = new DurableAgentStore(root);
  const agent = await store.createAgent({ purpose: "addressable", profileId: "general" });
  return { store, agent };
}

describe("BoundedAgentWorker", () => {
  it("runs queued work with bounded concurrency and publishes a durable result", async () => {
    const { store, agent } = await setup();
    const first = await store.followupTask(agent.id, "first", { budget });
    const second = await store.followupTask(agent.id, "second", { budget });
    let active = 0; let peak = 0;
    const worker = new BoundedAgentWorker(store, { run: async (task) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1;
      return { status: "succeeded", summary: task.message };
    } }, { concurrency: 1, leaseMs: 500, idlePollMs: 10 });
    worker.start();
    await expect(store.waitResult(first.id, { timeoutMs: 1_000 })).resolves.toMatchObject({ summary: "first" });
    await expect(store.waitResult(second.id, { timeoutMs: 1_000 })).resolves.toMatchObject({ summary: "second" });
    expect(peak).toBe(1);
    await worker.close();
  });

  it("cancels work that exceeds its runtime budget", async () => {
    const { store, agent } = await setup();
    const task = await store.followupTask(agent.id, "slow", { budget: { ...budget, maxRuntimeMs: 20 } });
    const worker = new BoundedAgentWorker(store, { run: async (_task, signal) => await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }, { concurrency: 1, leaseMs: 500, idlePollMs: 10 });
    worker.start();
    await expect(store.waitResult(task.id, { timeoutMs: 1_000 })).resolves.toMatchObject({ status: "cancelled", summary: "Agent task runtime budget exceeded" });
    await worker.close();
  });

  it("supports aborting a bounded result wait", async () => {
    const { store, agent } = await setup();
    const task = await store.followupTask(agent.id, "queued", { budget });
    const controller = new AbortController();
    const waiting = store.waitResult(task.id, { timeoutMs: 1_000, signal: controller.signal });
    controller.abort(new Error("stop waiting"));
    await expect(waiting).rejects.toThrow("stop waiting");
  });
});
