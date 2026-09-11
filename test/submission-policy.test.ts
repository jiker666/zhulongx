import { describe, expect, it } from "vitest";
import { renderRunHandoff } from "../src/handoff.js";
import { submissionPolicyFor, validateSubmission } from "../src/submission-policy.js";
import type { RunState } from "../src/types.js";

describe("submission policy", () => {
  it("accepts a strict candidate only when tool output and verification agree", () => {
    const validation = validateSubmission({
      policy: "strict",
      status: "completed",
      candidate: "flag{grounded}",
      observedOutputs: ["command output: flag{grounded}"],
      independentObservedOutputs: ["independent replay output: flag{grounded}"],
      verification: ["Independent replay returned flag{grounded}"],
      independentlyVerified: true,
    });

    expect(validation).toMatchObject({ status: "accepted", grounded: true, verificationMentionsCandidate: true });
  });

  it("keeps hallucinated and identifier-like candidates pending or rejected", () => {
    expect(validateSubmission({
      policy: "strict",
      status: "completed",
      candidate: "flag{invented}",
      observedOutputs: ["command output did not contain a result"],
      independentObservedOutputs: ["independent replay did not contain a result"],
      verification: ["The model believes flag{invented} is correct"],
      independentlyVerified: true,
    }).status).toBe("pending");

    expect(validateSubmission({
      policy: "strict",
      status: "completed",
      candidate: "550e8400-e29b-41d4-a716-446655440000",
      observedOutputs: ["550e8400-e29b-41d4-a716-446655440000"],
      independentObservedOutputs: ["Independent replay returned 550e8400-e29b-41d4-a716-446655440000"],
      verification: ["Independent replay returned 550e8400-e29b-41d4-a716-446655440000"],
      independentlyVerified: true,
    }).status).toBe("rejected");
  });

  it("does not treat one successful tool result as independent verification", () => {
    expect(validateSubmission({
      policy: "strict",
      status: "completed",
      candidate: "flag{single-observation}",
      observedOutputs: ["solver output: flag{single-observation}"],
      independentObservedOutputs: [],
      verification: ["Independent replay returned flag{single-observation}"],
      independentlyVerified: true,
    }).status).toBe("pending");
  });

  it("defaults automated question-bank tasks to strict and keeps other tasks compatible", () => {
    expect(submissionPolicyFor({ metadata: { source: "question-bank" } })).toBe("strict");
    expect(submissionPolicyFor({ metadata: {} })).toBe("advisory");
    expect(submissionPolicyFor({ metadata: { submissionPolicy: "strict" } })).toBe("strict");
  });
});

describe("run handoff", () => {
  it("renders bounded continuation data without copying the submission value", () => {
    const state = {
      id: "handoff-test",
      status: "blocked",
      phase: "done",
      task: { task: "Continue an authorized offline analysis", attachments: [], metadata: {} },
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
      findings: [],
      lessons: [],
      hypotheses: [],
      strategyRevisions: [],
      strategyRevisionRequired: false,
      sandboxNamespace: "handoff-test",
      scratchRoot: "C:/scratch/handoff-test",
      workspaceMode: "configured",
      appliedExperienceIds: [],
      submission: "flag{private-answer}",
      summary: "A bounded check stopped before final verification.",
      nextSteps: ["Re-run the smallest independent check"],
      remainingRisks: ["The candidate is not yet grounded"],
      turns: 2,
      toolCalls: 1,
      imageObservations: 0,
      httpRequests: 0,
      tcpSessions: 0,
      actionsSinceCheckpoint: 0,
      repeatedActions: {},
    } as RunState;

    const handoff = renderRunHandoff(state);
    expect(handoff).toContain("Re-run the smallest independent check");
    expect(handoff).toContain("Submission present: yes (value omitted)");
    expect(handoff).not.toContain("flag{private-answer}");
  });
});
