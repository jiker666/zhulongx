import { describe, expect, it } from "vitest";
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

describe("RunManager attachment isolation", () => {
  it("stages supplied attachments by default while preserving explicit workspace overrides", async () => {
    const calls: Array<{ workspaceMode?: string }> = [];
    const runtime = {
      run: async (_request: unknown, options: { workspaceMode?: string; id?: string }) => {
        calls.push(options.workspaceMode === undefined ? {} : { workspaceMode: options.workspaceMode });
        return completedState(options.id ?? "run");
      },
    } as never;
    const manager = new RunManager(runtime);

    const isolated = manager.start({ task: "inspect", attachments: ["input.zip"] });
    await manager.wait(isolated);
    const configured = manager.start({ task: "inspect", attachments: ["input.zip"] }, { workspaceMode: "configured" });
    await manager.wait(configured);

    expect(calls).toEqual([{ workspaceMode: "attachments-only" }, { workspaceMode: "configured" }]);
  });
});
