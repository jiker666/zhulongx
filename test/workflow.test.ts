import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DurableWorkflowStore, workflowCacheKey, type WorkflowBudget, type WorkflowNodeSpec } from "../src/workflow.js";
import { BoundedWorkflowWorker } from "../src/workflow-worker.js";

const roots: string[] = [];
const budget: WorkflowBudget = { maxNodes: 12, maxRuntimeMs: 10_000, maxNetworkNodes: 2, maxNetworkRequests: 4, maxTokens: 1_000, maxCostMicros: 10_000, maxControllerExpansions: 1 };
const node = (id: string, effect: WorkflowNodeSpec["effect"] = "pure_readonly", dependencies: WorkflowNodeSpec["dependencies"] = []): WorkflowNodeSpec => ({ id, kind: "work", message: id, dependencies, effect, cachePolicy: "none", maxAttempts: 1 });

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function store() { const root = await mkdtemp(join(tmpdir(), "xuan-workflow-")); roots.push(root); return new DurableWorkflowStore(root); }

describe("DurableWorkflowStore", () => {
  it("rejects cycles and keys evidence caches by evidence version", async () => {
    const value = await store();
    await expect(value.create({ name: "cycle", budget, nodes: [node("a", "pure_readonly", [{ nodeId: "b", condition: "success" }]), node("b", "pure_readonly", [{ nodeId: "a", condition: "success" }])] })).rejects.toThrow("acyclic");
    const first = { ...node("cached"), cachePolicy: "evidence" as const, evidenceVersion: "v1" };
    expect(workflowCacheKey(first)).not.toBe(workflowCacheKey({ ...first, evidenceVersion: "v2" }));
  });

  it("honors success and settled dependencies", async () => {
    const value = await store();
    const workflow = await value.create({ name: "dependencies", budget, nodes: [node("source"), node("on-success", "pure_readonly", [{ nodeId: "source", condition: "success" }]), node("on-settled", "pure_readonly", [{ nodeId: "source", condition: "settled" }])] });
    const claimed = await value.claimNext("worker", 5_000); expect(claimed?.node.id).toBe("source");
    await value.settle({ workflowId: workflow.id, nodeId: "source", workerId: "worker", generation: claimed!.node.leaseGeneration, status: "failed", summary: "expected" });
    const next = await value.claimNext("worker", 5_000); expect(next?.node.id).toBe("on-settled");
    expect((await value.get(workflow.id))?.nodes.find((item) => item.id === "on-success")?.status).toBe("skipped");
  });

  it("allows parallel reads but serializes workspace writes", async () => {
    const value = await store();
    await value.create({ name: "effects", budget, nodes: [node("read-1", "workspace_read"), node("read-2", "workspace_read"), node("write", "workspace_write")] });
    const first = await value.claimNext("one", 5_000); const second = await value.claimNext("two", 5_000); const blocked = await value.claimNext("three", 5_000);
    expect([first?.node.id, second?.node.id]).toEqual(["read-1", "read-2"]); expect(blocked).toBeUndefined();
    await value.settle({ workflowId: first!.workflow.id, nodeId: first!.node.id, workerId: "one", generation: first!.node.leaseGeneration, status: "succeeded", summary: "done" });
    await value.settle({ workflowId: second!.workflow.id, nodeId: second!.node.id, workerId: "two", generation: second!.node.leaseGeneration, status: "succeeded", summary: "done" });
    expect((await value.claimNext("three", 5_000))?.node.id).toBe("write");
  });

  it("prevents stale results and never replays an expired side-effect node", async () => {
    const value = await store(); const workflow = await value.create({ name: "leases", budget, nodes: [{ ...node("read"), maxAttempts: 2 }, node("write", "workspace_write", [{ nodeId: "read", condition: "settled" }])] });
    const old = await value.claimNext("old", 1); await new Promise((resolve) => setTimeout(resolve, 5)); const current = await value.claimNext("current", 5_000);
    await expect(value.settle({ workflowId: workflow.id, nodeId: "read", workerId: "old", generation: old!.node.leaseGeneration, status: "succeeded", summary: "late" })).rejects.toThrow("Stale");
    await value.settle({ workflowId: workflow.id, nodeId: "read", workerId: "current", generation: current!.node.leaseGeneration, status: "succeeded", summary: "current" });
    await value.claimNext("writer", 1); await new Promise((resolve) => setTimeout(resolve, 5)); expect(await value.claimNext("other", 5_000)).toBeUndefined();
    expect((await value.get(workflow.id))?.nodes.find((item) => item.id === "write")).toMatchObject({ status: "failed", error: expect.stringContaining("not replayed") });
  });

  it("bounds controller expansion and aggregate network usage", async () => {
    const value = await store();
    const controller: WorkflowNodeSpec = { ...node("controller"), kind: "controller" };
    const workflow = await value.create({ name: "dynamic", budget: { ...budget, maxNetworkRequests: 1 }, nodes: [controller] });
    const claimed = await value.claimNext("worker", 5_000);
    await value.expand({ workflowId: workflow.id, controllerNodeId: "controller", workerId: "worker", generation: claimed!.node.leaseGeneration, nodes: [node("network", "network", [{ nodeId: "controller", condition: "success" }])] });
    await expect(value.expand({ workflowId: workflow.id, controllerNodeId: "controller", workerId: "worker", generation: claimed!.node.leaseGeneration, nodes: [node("extra")] })).rejects.toThrow("expansion budget");
    await value.settle({ workflowId: workflow.id, nodeId: "controller", workerId: "worker", generation: claimed!.node.leaseGeneration, status: "succeeded", summary: "expanded" });
    const network = await value.claimNext("network-worker", 5_000);
    await value.settle({ workflowId: workflow.id, nodeId: "network", workerId: "network-worker", generation: network!.node.leaseGeneration, status: "succeeded", summary: "too many", networkRequests: 2 });
    expect((await value.get(workflow.id))?.status).toBe("failed");
  });

  it("executes a static DAG through the bounded worker", async () => {
    const value = await store(); const workflow = await value.create({ name: "worker", budget, nodes: [node("a"), node("b", "pure_readonly", [{ nodeId: "a", condition: "success" }])] });
    const worker = new BoundedWorkflowWorker(value, { run: async (_workflow, current) => ({ status: "succeeded", summary: current.id }) }, { concurrency: 2, leaseMs: 500, idlePollMs: 10 }); worker.start();
    await expect.poll(async () => (await value.get(workflow.id))?.status).toBe("succeeded"); await worker.close();
  });
});
