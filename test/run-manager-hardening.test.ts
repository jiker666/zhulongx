import { describe, expect, it } from "vitest";
import { installProcessGuards } from "../src/process-guards.js";
import { RunManager } from "../src/run-manager.js";
import type { RunState } from "../src/types.js";

function completedState(id: string): RunState {
  const now = new Date().toISOString();
  return {
    id,
    status: "completed",
    phase: "done",
    task: { task: "test", attachments: [], metadata: {} },
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: id,
    scratchRoot: "/tmp/scratch",
    workspaceMode: "attachments-only",
    appliedExperienceIds: [],
    turns: 0,
    toolCalls: 0,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint: 0,
    repeatedActions: {},
  };
}

interface Gate {
  runtime: unknown;
  release: (count?: number) => void;
  started: () => number;
}

/** Runtime whose runs block until the test releases them (concurrency probe). */
function gatedRuntime(): Gate {
  let running = 0;
  const waiters: Array<() => void> = [];
  const release = (count = 1) => {
    for (let i = 0; i < count && waiters.length > 0; i += 1) waiters.shift()!();
  };
  return {
    release,
    started: () => running,
    runtime: {
      run: async (_request: unknown, options: { id?: string }) => {
        running += 1;
        await new Promise<void>((resolve) => waiters.push(resolve));
        running -= 1;
        return completedState(options.id ?? "run");
      },
    },
  };
}

describe("RunManager one-shot endurance (R18)", () => {
  it("queues excess starts FIFO behind the concurrency ceiling and drains as slots free", async () => {
    const gate = gatedRuntime();
    const manager = new RunManager(gate.runtime as never, { maxConcurrent: 2, retainedRuns: 50 });
    const first = manager.start({ task: "a" });
    const second = manager.start({ task: "b" });
    const third = manager.start({ task: "c" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(gate.started()).toBe(2);
    expect(manager.get(third)?.status).toBe("queued");
    gate.release(1); // first finishes → third launches
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(gate.started()).toBe(2);
    expect(manager.get(third)?.status).toBe("running");
    gate.release(2);
    await Promise.all([manager.wait(first), manager.wait(second), manager.wait(third)]);
    const stats = manager.stats();
    expect(stats).toMatchObject({ total: 3, active: 0, queued: 0 });
  });

  it("evicts terminal handles past retainedRuns so a 10-hour session stays bounded", async () => {
    const runtime = { run: async (_request: unknown, options: { id?: string }) => completedState(options.id ?? "run") };
    const manager = new RunManager(runtime as never, { maxConcurrent: 0, retainedRuns: 3 });
    for (let i = 0; i < 7; i += 1) await manager.wait(manager.start({ task: `t${i}` }));
    expect(manager.list().length).toBeLessThanOrEqual(3);
    expect(manager.stats().evicted).toBeGreaterThanOrEqual(4);
  });

  it("fails a queued run promptly when stopped before launch", async () => {
    const gate = gatedRuntime();
    const manager = new RunManager(gate.runtime as never, { maxConcurrent: 1, retainedRuns: 10 });
    const blocked = manager.start({ task: "occupy" });
    const queued = manager.start({ task: "waiting" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(manager.stop(queued)).toBe(true);
    await expect(manager.wait(queued)).rejects.toThrow(/stopped|queued/i);
    gate.release(1);
    await manager.wait(blocked);
  });
});

describe("process guards (R18)", () => {
  it("installs a heartbeat without touching process exits", async () => {
    const lines: string[] = [];
    installProcessGuards({ logger: (line) => lines.push(line), heartbeatMs: 20, stats: () => ({ probes: 1 }) });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lines.some((line) => line.includes("[guard] heartbeat") && line.includes("probes=1"))).toBe(true);
  });
});
