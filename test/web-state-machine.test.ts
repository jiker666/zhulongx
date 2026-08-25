import { describe, expect, it } from "vitest";
import {
  canTransition,
  createWebAgentState,
  normalizeWebAgentState,
  roleForPhase,
  transitionWebPhase,
} from "../src/agents/web/web-state-machine.js";
import { renderWebOrchestrationContext } from "../src/agents/web/web-orchestrator.js";
import { HypothesisManager } from "../src/web-reasoning/hypothesis-manager.js";
import { candidateIdForSubmission, driveWebPhase, suggestNextWebPhase } from "../src/web-reasoning/phase-driver.js";
import { createInitialWebReasoningState } from "../src/web-reasoning/state.js";
import type { WebObservation, WebReasoningState } from "../src/web-reasoning/types.js";
import type { WebPhase } from "../src/agents/web/types.js";
import type { RunState } from "../src/types.js";

const T0 = "2026-01-01T00:00:00.000Z";

function run(): RunState {
  const now = new Date().toISOString();
  return { id: "00000000-0000-4000-8000-000000000000", status: "running", phase: "planning", task: { task: "authorized task", attachments: [], metadata: {} }, createdAt: now, updatedAt: now, findings: [], lessons: [], hypotheses: [], strategyRevisions: [], strategyRevisionRequired: false, sandboxNamespace: "test", scratchRoot: "/tmp/test", workspaceMode: "configured", appliedExperienceIds: [], turns: 0, toolCalls: 0, imageObservations: 0, httpRequests: 0, tcpSessions: 0, actionsSinceCheckpoint: 0, repeatedActions: {} };
}

function observation(type: WebObservation["type"], summary: string): WebObservation {
  return { id: `o_${type}_${summary}`, type, summary, source: "tool", evidenceIds: [], confidence: 0.9, normalizedKey: `${type}:${summary}`, createdAt: T0, updatedAt: T0 };
}

function reasoningState() {
  return createInitialWebReasoningState({ isWeb: true, confidence: 1, reasons: [], source: "url" }, 10);
}

/** Evidence needed to walk RECON -> ENUMERATION -> FINGERPRINT -> VULNERABILITY_ANALYSIS. */
function seedSurfaceEvidence(reasoning: WebReasoningState): void {
  reasoning.observations.push(
    observation("response", "200 /"),
    observation("endpoint", "/login"),
    observation("technology", "server=nginx"),
  );
}

/** Drive the phase machine until it reaches `target`, so steps are not duplicated. */
async function driveUntil(state: RunState, reasoning: WebReasoningState, target: WebPhase, limit = 8): Promise<void> {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (state.webAgent?.phase === target) return;
    await driveWebPhase(state, reasoning, undefined, T0);
  }
  throw new Error(`Phase machine did not reach ${target} (stuck at ${state.webAgent?.phase})`);
}

describe("Web phase state machine normalization", () => {
  it("does not reset a persisted phase across renders", () => {
    const state = run();
    state.webAgent = {
      phase: "EXPLOITATION",
      activeRole: "exploit",
      failureCount: 0,
      repeatedActionCount: 0,
      history: [
        { phase: "RECON", enteredAt: T0, reason: "surface mapped" },
        { phase: "EXPLOITATION", enteredAt: T0, reason: "hypothesis supported" },
      ],
    };
    const context = renderWebOrchestrationContext({ task: state.task, run: state });
    expect(context).toContain("Current phase: EXPLOITATION");
    // Rendering again must not fall back to a fresh INIT/RECON.
    const again = renderWebOrchestrationContext({ task: state.task, run: state });
    expect(again).toContain("Current phase: EXPLOITATION");
    expect(again).not.toContain("Current phase: INIT");
  });

  it("keeps EXPLOITATION authoritative even when history is stale at INIT", () => {
    const fallback = createWebAgentState(T0);
    const stale = {
      phase: "EXPLOITATION",
      activeRole: "recon", // deliberately inconsistent role
      history: [{ phase: "INIT", enteredAt: T0, reason: "old" }],
    };
    const result = normalizeWebAgentState(stale, fallback);
    expect(result.phase).toBe("EXPLOITATION");
    expect(result.activeRole).toBe("exploit"); // roleForPhase(EXPLOITATION), not the persisted one
    expect(result.history.at(-1)?.phase).toBe("EXPLOITATION"); // restore record appended
    expect(result.history[0]!.phase).toBe("INIT"); // stale but valid history is preserved
    expect(result.history.length).toBe(2);
  });

  it("repairs malformed history fields and drops invalid phases", () => {
    const fallback = createWebAgentState(T0);
    const result = normalizeWebAgentState({
      phase: "FINGERPRINT",
      history: [
        { phase: "BOGUS", enteredAt: "bad" }, // invalid phase -> dropped
        { phase: "RECON", enteredAt: 123, reason: 42 }, // bad fields -> repaired
        { phase: "FINGERPRINT" }, // missing enteredAt -> repaired with stable fallback
      ],
    }, fallback);
    expect(result.phase).toBe("FINGERPRINT");
    expect(result.activeRole).toBe(roleForPhase("FINGERPRINT"));
    expect(result.history.every((record) => typeof record.phase === "string" && typeof record.enteredAt === "string" && typeof record.reason === "string")).toBe(true);
    expect(result.history.find((record) => record.phase === "RECON")?.reason).toBe("");
    expect(result.history.at(-1)?.phase).toBe("FINGERPRINT");
  });

  it("is deterministic across repeated normalization of the same input", () => {
    const fallback = createWebAgentState(T0);
    const input = {
      phase: "EXPLOITATION",
      activeRole: "recon",
      failureCount: 2,
      repeatedActionCount: 1,
      history: [
        { phase: "RECON", enteredAt: T0, reason: "start" },
        { phase: "EXPLOITATION", enteredAt: T0 },
      ],
    };
    const first = normalizeWebAgentState(input, fallback);
    const second = normalizeWebAgentState(input, fallback);
    expect(first).toEqual(second);
  });

  it("falls back to INIT for an invalid persisted phase", () => {
    const fallback = createWebAgentState(T0);
    const result = normalizeWebAgentState({ phase: "garbage", history: [] }, fallback);
    expect(result.phase).toBe("INIT");
    expect(result.activeRole).toBe("recon");
    expect(result.history.length).toBe(1);
    expect(result.history[0]!.phase).toBe("INIT");
  });

  it("rejects illegal phase transitions", () => {
    const state = createWebAgentState(T0);
    expect(canTransition("INIT", "RECON")).toBe(true); // legal forward step
    expect(canTransition("INIT", "EXPLOITATION")).toBe(false); // skipping stages is illegal
    expect(() => transitionWebPhase(state, "EXPLOITATION", "cannot skip ahead", T0)).toThrow();
  });
});

describe("Web phase machine evidence-driven advance", () => {
  it("advances INIT to RECON when reasoning initializes", async () => {
    const state = run();
    const reasoning = reasoningState();
    const result = await driveWebPhase(state, reasoning, undefined, T0);
    expect(result.transitioned).toBe(true);
    expect(result.to).toBe("RECON");
    expect(state.webAgent?.phase).toBe("RECON");
    expect(state.webAgent?.activeRole).toBe("recon");
  });

  it("keeps RECON active until baseline response evidence exists", async () => {
    const state = run();
    const reasoning = reasoningState();
    await driveWebPhase(state, reasoning, undefined, T0);
    expect(suggestNextWebPhase(reasoning, state)).toBeUndefined();
    reasoning.observations.push(observation("response", "200 /"));
    const result = await driveWebPhase(state, reasoning, undefined, T0);
    expect(result.to).toBe("ENUMERATION");
  });

  it("advances to VULNERABILITY_ANALYSIS once technology evidence exists", async () => {
    const state = run();
    const reasoning = reasoningState();
    seedSurfaceEvidence(reasoning);
    await driveUntil(state, reasoning, "VULNERABILITY_ANALYSIS");
    expect(state.webAgent?.phase).toBe("VULNERABILITY_ANALYSIS");
  });

  it("drives the full pipeline to COMPLETE on accumulated evidence", async () => {
    const state = run();
    const reasoning = reasoningState();
    const manager = new HypothesisManager(reasoning);

    seedSurfaceEvidence(reasoning);
    await driveUntil(state, reasoning, "VULNERABILITY_ANALYSIS");

    const hypothesis = manager.create({ category: "input_handling", title: "Reflection", statement: "The parameter is reflected unsafely", priority: 5, requiredEvidence: ["controlled comparison"], sourceObservationIds: [] });
    manager.addSupportingEvidence(hypothesis.id, "ev1");
    await driveUntil(state, reasoning, "EXPLOITATION");

    state.submission = "web-result";
    await driveUntil(state, reasoning, "RESULT_DISCOVERY");
    await driveUntil(state, reasoning, "VERIFICATION");

    // Only submission-specific verification evidence may complete VERIFICATION:
    // an evidence record from the verifier source carrying verificationIds bound to
    // the exact candidate id of the current submission.
    state.evidence = [{
      id: "ev_verify",
      summary: "Independently verified the submission by replaying the authorized action and confirming the returned result",
      source: "verifier",
      lifecycle: "used",
      observationIds: [],
      hypothesisIds: [hypothesis.id],
      actionIds: [],
      candidateIds: [candidateIdForSubmission("web-result")],
      verificationIds: ["verification_replay"],
      createdAt: T0,
      updatedAt: T0,
    }];
    await driveWebPhase(state, reasoning, undefined, T0);
    expect(state.webAgent?.phase).toBe("COMPLETE");
  });

  it("never marks COMPLETE while submission verification is missing", async () => {
    const state = run();
    const reasoning = reasoningState();
    const manager = new HypothesisManager(reasoning);

    seedSurfaceEvidence(reasoning);
    await driveUntil(state, reasoning, "VULNERABILITY_ANALYSIS");

    const hypothesis = manager.create({ category: "input_handling", title: "Reflection", statement: "The parameter is reflected unsafely", priority: 5, requiredEvidence: ["controlled comparison"], sourceObservationIds: [] });
    manager.addSupportingEvidence(hypothesis.id, "ev1");
    await driveUntil(state, reasoning, "EXPLOITATION");

    state.submission = "web-result";
    await driveUntil(state, reasoning, "VERIFICATION");

    // A confirmed vulnerability hypothesis is not submission verification.
    reasoning.confirmedHypothesisIds.push(hypothesis.id);
    await driveWebPhase(state, reasoning, undefined, T0);
    expect(state.webAgent?.phase).toBe("VERIFICATION");
    expect(state.webAgent?.phase).not.toBe("COMPLETE");
  });

  it("does not let an old candidate's verification complete a new submission", async () => {
    const state = run();
    const reasoning = reasoningState();
    const manager = new HypothesisManager(reasoning);

    seedSurfaceEvidence(reasoning);
    await driveUntil(state, reasoning, "VULNERABILITY_ANALYSIS");

    const hypothesis = manager.create({ category: "input_handling", title: "Reflection", statement: "The parameter is reflected unsafely", priority: 5, requiredEvidence: ["controlled comparison"], sourceObservationIds: [] });
    manager.addSupportingEvidence(hypothesis.id, "ev1");
    await driveUntil(state, reasoning, "EXPLOITATION");

    state.submission = "old-result";
    await driveUntil(state, reasoning, "VERIFICATION");

    // Verification bound to the OLD candidate id.
    state.evidence = [{
      id: "ev_old_verify",
      summary: "Independently verified the old candidate",
      source: "verifier",
      lifecycle: "used",
      observationIds: [],
      hypothesisIds: [hypothesis.id],
      actionIds: [],
      candidateIds: [candidateIdForSubmission("old-result")],
      verificationIds: ["verification_old"],
      createdAt: T0,
      updatedAt: T0,
    }];

    // A NEW submission must not inherit the old candidate's verification: switch the
    // submission FIRST, then drive, so only candidate-bound evidence for the new value
    // may complete it.
    state.submission = "new-result";
    await driveWebPhase(state, reasoning, undefined, T0);
    expect(state.webAgent?.phase).toBe("VERIFICATION");
    expect(state.webAgent?.phase).not.toBe("COMPLETE");

    // Binding verification to the NEW candidate id completes the run.
    state.evidence.push({
      id: "ev_new_verify",
      summary: "Independently verified the new candidate",
      source: "verifier",
      lifecycle: "used",
      observationIds: [],
      hypothesisIds: [hypothesis.id],
      actionIds: [],
      candidateIds: [candidateIdForSubmission("new-result")],
      verificationIds: ["verification_new"],
      createdAt: T0,
      updatedAt: T0,
    });
    await driveWebPhase(state, reasoning, undefined, T0);
    expect(state.webAgent?.phase).toBe("COMPLETE");
  });
});
