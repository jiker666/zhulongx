import { describe, expect, it } from "vitest";
import { projectActionTransactions, projectDecisionLoop, projectObservatory, projectSafetyEnvelope } from "./projection";
import type { RunState } from "../../types/api";

const state = (overrides: Partial<RunState> = {}): RunState => ({
  id: "run-1", status: "running", phase: "analysis", task: { task: "inspect", metadata: {}, attachments: [] }, createdAt: "2026-01-01", updatedAt: "2026-01-01", findings: [], lessons: [], hypotheses: [], strategyRevisions: [], turns: 2, toolCalls: 1, httpRequests: 0, tcpSessions: 0, ...overrides,
});

const event = (type: string, sequence: number, data: Record<string, unknown>, correlationId = "call-1") => ({ sequence, timestamp: `2026-01-01T00:00:0${sequence}.000Z`, type, correlationId, data });

describe("decision observatory projection", () => {
  it("groups correlated request, policy, and result events into one transaction", () => {
    const transactions = projectActionTransactions([
      event("tool.requested", 1, { toolCallId: "call-1", toolName: "http_request" }),
      event("policy.decision", 2, { toolCallId: "call-1", toolName: "http_request", allowed: true }),
      event("tool.result", 3, { toolCallId: "call-1", toolName: "http_request", isError: false, evidenceIds: ["E1"] }),
    ]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ toolName: "http_request", status: "success", evidenceIds: ["E1"] });
    expect(transactions[0].requested?.sequence).toBe(1);
  });

  it("projects safety values only from the real run.started scope and policy payload", () => {
    const result = projectSafetyEnvelope([
      event("run.started", 1, { scope: { mode: "controlled", allowedHosts: ["app.example.test"], allowedPrograms: ["rg"], workspaceRoot: "inputs" }, budgets: { maxToolCalls: 60 } }, "run-1"),
      event("policy.decision", 2, { toolName: "http_request", allowed: false, reason: "outside scope" }),
    ]);
    expect(result).toMatchObject({ mode: "controlled", hosts: ["app.example.test"], programs: ["rg"], currentPolicy: "blocked", reason: "outside scope" });
    expect(result.budgets).toEqual({ maxToolCalls: 60 });
  });

  it("uses the web reasoning phase as the single active decision-loop node", () => {
    const loop = projectDecisionLoop(state({ webReasoning: { phase: "evaluating", observations: [], hypotheses: [], actions: [], stagnation: { consecutiveNoEvidenceRounds: 0, consecutiveDuplicateActions: 0, consecutiveToolFailures: 0, detected: false } } }));
    expect(loop.filter((item) => item.active).map((item) => item.key)).toEqual(["evaluate"]);
    expect(loop.find((item) => item.key === "observe")?.complete).toBe(true);
  });

  it("keeps recovery and evidence conflict grounded in state", () => {
    const result = projectObservatory(state({ strategyRevisionRequired: true, strategyRevisions: [{ id: "revision-1", classification: "tool", planChanges: ["use existing evidence"], nextAction: "inspect browser state", rationale: "the request failed", createdAt: "2026-01-01" }], webReasoning: { phase: "reflecting", observations: [], actions: [], hypotheses: [{ id: "H1", title: "Boundary", statement: "Role boundary exists", status: "weakened", confidence: .6, supportingEvidenceIds: ["E1"], contradictingEvidenceIds: ["E2"], attemptedActionIds: [] }], stagnation: { consecutiveNoEvidenceRounds: 3, consecutiveDuplicateActions: 0, consecutiveToolFailures: 0, detected: true, reason: "No new evidence" } } }), [event("strategy.revised", 1, { revision: { id: "revision-1" }, resolvedFailure: { toolName: "http_request", reason: "timeout" } })]);
    expect(result.recoveryRequired).toBe(true);
    expect(result.latestRevision?.nextAction).toBe("inspect browser state");
    expect(result.hypotheses[0].supporting).toEqual(["E1"]);
    expect(result.hypotheses[0].contradicting).toEqual(["E2"]);
    expect(result.stagnation.detected).toBe(true);
  });
});
