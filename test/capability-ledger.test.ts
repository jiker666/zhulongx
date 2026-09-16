import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityLedger, foldStats, isSolvedState, renderCapabilityContext, type CapabilityRecord } from "../src/capability-ledger.js";
import type { RunState } from "../src/types.js";

function record(overrides: Partial<CapabilityRecord>): CapabilityRecord {
  return {
    runId: "r",
    category: "crypto",
    status: "failed",
    solved: false,
    turns: 10,
    toolCalls: 20,
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("capability ledger", () => {
  it("treats only grounded, non-contradicted completions as solved", () => {
    const base = { status: "completed" as const, submission: "flag{x}" };
    expect(isSolvedState(base)).toBe(true);
    expect(isSolvedState({ ...base, submission: " " })).toBe(false);
    expect(isSolvedState({ ...base, status: "blocked" })).toBe(false);
    expect(isSolvedState({ ...base, submissionValidation: { status: "rejected" } as never })).toBe(false);
    expect(isSolvedState({ ...base, verificationVerdict: { verdict: "contradicted" } as never })).toBe(false);
    expect(isSolvedState({ ...base, verificationVerdict: { verdict: "reproduced" } as never })).toBe(true);
  });

  it("persists records with upsert-by-runId semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuan-capability-"));
    try {
      const ledger = new CapabilityLedger(root);
      await ledger.record({ id: "run-1", status: "running", task: { task: "t", attachments: [], metadata: { category: "Crypto" } } } as unknown as RunState);
      await ledger.record({ id: "run-1", status: "completed", submission: "flag{y}", turns: 3, finishedAt: new Date().toISOString(), task: { task: "t", attachments: [], metadata: { category: "Crypto" } } } as unknown as RunState);
      const stats = await ledger.stats();
      expect(stats.total).toBe(1);
      expect(stats.solved).toBe(1);
      expect(stats.dimensions[0]).toMatchObject({ category: "crypto", runs: 1, solved: 1, solveRate: 1 });

      const reloaded = new CapabilityLedger(root);
      expect((await reloaded.stats()).total).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("folds per-dimension stats and model attribution", () => {
    const stats = foldStats([
      record({ runId: "1", category: "crypto", solved: true, turns: 40, modelId: "glm-5.3-flash" }),
      record({ runId: "2", category: "crypto", solved: false, turns: 120, terminalReason: "ended_without_finish", modelId: "glm-5.3-flash" }),
      record({ runId: "3", category: "crypto", solved: false, turns: 110, terminalReason: "ended_without_finish", modelId: "glm-5.3-flash" }),
      record({ runId: "4", category: "crypto", solved: false, turns: 100, terminalReason: "agent_blocked" }),
      record({ runId: "5", category: "web", solved: true, turns: 20, modelId: "glm-5.3-flash" }),
      record({ runId: "6", category: "web", solved: true, turns: 24, modelId: "glm-5.3-flash" }),
    ]);
    expect(stats.total).toBe(6);
    expect(stats.solved).toBe(3);
    const crypto = stats.dimensions.find((item) => item.category === "crypto");
    expect(crypto).toMatchObject({ runs: 4, solved: 1, solveRate: 0.25, avgTurns: 93, avgTurnsSolved: 40, avgTurnsUnsolved: 110 });
    expect(crypto?.failureModes[0]).toMatchObject({ reason: "ended_without_finish", count: 2 });
    const web = stats.dimensions.find((item) => item.category === "web");
    expect(web?.solveRate).toBe(1);
    expect(stats.models[0]).toMatchObject({ modelId: "glm-5.3-flash", runs: 5, solved: 3 });
  });

  it("renders bounded context only for dimensions with enough history", () => {
    const few = foldStats([
      record({ runId: "1", category: "crypto", solved: true }),
      record({ runId: "2", category: "crypto" }),
    ]);
    expect(renderCapabilityContext("crypto", few)).toBe("");
    expect(renderCapabilityContext(undefined, few)).toBe("");

    const enough = foldStats([
      record({ runId: "1", category: "crypto", solved: true, turns: 40 }),
      ...[2, 3, 4, 5, 6].map((index) => record({ runId: String(index), category: "crypto", turns: 100 + index, terminalReason: index % 2 === 0 ? "ended_without_finish" : "agent_blocked" })),
    ]);
    const context = renderCapabilityContext("Crypto", enough);
    expect(context).toContain("CAPABILITY HISTORY");
    expect(context).toContain("1/6 solved");
    expect(context).toContain("ended_without_finish");
    expect(context).toContain("finish_task");
    expect(context).toContain("historically weak");
    expect(context.length).toBeLessThanOrEqual(900);
  });
});
