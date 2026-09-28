import { describe, expect, it } from "vitest";
import { renderRunHandoff } from "../src/handoff.js";
import { RunObserver } from "../src/observer.js";
import type { RunState } from "../src/types.js";

function state(actionsSinceCheckpoint = 0): RunState {
  const now = new Date().toISOString();
  return {
    id: "observer",
    status: "running",
    phase: "exploration",
    task: { task: "t", attachments: [], metadata: {} },
    createdAt: now,
    updatedAt: now,
    findings: [],
    lessons: [],
    hypotheses: [],
    strategyRevisions: [],
    strategyRevisionRequired: false,
    sandboxNamespace: "observer",
    scratchRoot: "/tmp/observer",
    workspaceMode: "configured",
    appliedExperienceIds: [],
    turns: 0,
    toolCalls: 0,
    imageObservations: 0,
    httpRequests: 0,
    tcpSessions: 0,
    actionsSinceCheckpoint,
    repeatedActions: {},
  };
}

const RUNTIME = { maxRepeatedAction: 2, maxActionsWithoutCheckpoint: 4 };

describe("run observer", () => {
  it("records repeated identical actions once with growing occurrences", () => {
    const run = state();
    const observer = new RunObserver(run, RUNTIME);
    const emitted = [];
    for (let index = 0; index < 5; index += 1) {
      emitted.push(...observer.observe({ toolName: "run_command", args: { program: "python3", args: ["solve.py"] }, isError: false }));
    }
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    const anomalies = run.observerAnomalies ?? [];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ kind: "repeated_action", occurrences: 3 });
    expect(renderRunHandoff(run)).toContain("[repeated_action]");
  });

  it("keeps read tools on a higher bar and records repeated failures", () => {
    const run = state();
    const observer = new RunObserver(run, RUNTIME);
    for (let index = 0; index < 4; index += 1) {
      observer.observe({ toolName: "read_file", args: { path: "notes.txt" }, isError: false });
    }
    expect(run.observerAnomalies ?? []).toHaveLength(0);
    for (let index = 0; index < 6; index += 1) {
      observer.observe({ toolName: "read_file", args: { path: "notes.txt" }, isError: false });
    }
    expect(run.observerAnomalies?.some((item) => item.kind === "repeated_read")).toBe(true);

    for (let index = 0; index < 3; index += 1) {
      observer.observe({ toolName: "run_command", args: { program: "nmap", args: ["-p", "80"] }, isError: true });
    }
    const failure = run.observerAnomalies?.find((item) => item.kind === "repeated_failure");
    expect(failure).toMatchObject({ occurrences: 1 });
  });

  it("flags long checkpoint gaps and resets on checkpoint, ignoring control tools", () => {
    const run = state(8);
    const observer = new RunObserver(run, RUNTIME);
    const gap = observer.observe({ toolName: "run_command", args: { program: "python3", args: ["a.py"] }, isError: false });
    expect(gap.some((item) => item.kind === "checkpoint_gap")).toBe(true);

    run.actionsSinceCheckpoint = 0;
    observer.observe({ toolName: "checkpoint", args: {}, isError: false });
    for (let index = 0; index < 50; index += 1) {
      observer.observe({ toolName: "record_finding", args: { title: `f${index}` }, isError: false });
      observer.observe({ toolName: "submit_plan", args: { goal: `g${index}` }, isError: false });
    }
    expect(run.observerAnomalies?.filter((item) => item.kind === "checkpoint_gap")).toHaveLength(1);
    expect(run.observerAnomalies?.some((item) => item.kind === "repeated_action")).toBe(false);
  });

  it("bounds stored anomalies", () => {
    const run = state();
    const observer = new RunObserver(run, RUNTIME);
    for (let tool = 0; tool < 40; tool += 1) {
      for (let index = 0; index < 3; index += 1) {
        observer.observe({ toolName: "run_command", args: { program: "python3", args: [`tool${tool}.py`] }, isError: false });
      }
    }
    expect((run.observerAnomalies ?? []).length).toBeLessThanOrEqual(12);
    expect((run.observerAnomalies ?? []).every((item) => item.kind === "repeated_action" && item.occurrences >= 1)).toBe(true);
  });

  it("hands over an auto-captured evidence tail when nothing was persisted (9841)", () => {
    const run = state();
    run.evidenceTail = [
      { tool: "write_scratch_file", summary: "Wrote 3882 bytes to scratch:exploit4.py" },
      { tool: "run_command", summary: "leak 0x7f4148768083 shown_rbp 0x7ffc2bd74e20 libc aligned" },
    ];
    const handoff = renderRunHandoff(run);
    expect(handoff).toContain("auto-captured");
    expect(handoff).toContain("[run_command] leak 0x7f4148768083");
    expect(handoff).toContain("Wrote 3882 bytes to scratch:exploit4.py");
  });
});
