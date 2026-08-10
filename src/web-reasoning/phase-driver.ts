import { createHash } from "node:crypto";
import type { AuditChain } from "../audit.js";
import type { RunState } from "../types.js";
import { createWebAgentState, canTransition, transitionWebPhase } from "../agents/web/web-state-machine.js";
import type { WebPhase } from "../agents/web/types.js";
import type { WebObservationType, WebReasoningState } from "./types.js";

export interface PhaseAdvanceSignal {
  target: WebPhase;
  reason: string;
  confidence: number;
}

const SURFACE_OBSERVATION_TYPES: readonly WebObservationType[] = ["target", "url", "endpoint", "response"];

function hasObservation(state: WebReasoningState, types: readonly WebObservationType[]): boolean {
  return state.observations.some((observation) => types.includes(observation.type));
}

function hasGraphNode(state: WebReasoningState, type: string): boolean {
  return state.knowledgeGraph?.nodes.some((node) => node.type === type) ?? false;
}

function hasSurfaceEvidence(state: WebReasoningState): boolean {
  return hasObservation(state, SURFACE_OBSERVATION_TYPES) || (state.webIntelligence?.responseSnapshots.length ?? 0) > 0;
}

function hasEndpointEvidence(state: WebReasoningState): boolean {
  return hasObservation(state, ["endpoint"]) || hasGraphNode(state, "endpoint");
}

function hasTechnologyEvidence(state: WebReasoningState): boolean {
  return hasObservation(state, ["technology"]) || hasGraphNode(state, "technology");
}

function hasSupportedHypothesis(state: WebReasoningState): boolean {
  return state.confirmedHypothesisIds.length > 0
    || state.hypotheses.some((hypothesis) => hypothesis.status === "supported" || hypothesis.status === "confirmed");
}

function hasCandidate(run: RunState, state: WebReasoningState): boolean {
  return Boolean(run.submission) || hasGraphNode(state, "candidate");
}

/** Deterministic candidate id for a submission. Shared with the controller so the
 *  finish_task evidence binds to the exact candidate that was submitted. */
export function candidateIdForSubmission(submission: unknown): string {
  return `candidate_${createHash("sha256").update(String(submission)).digest("hex").slice(0, 16)}`;
}

function hasIndependentVerification(state: WebReasoningState, run: RunState): boolean {
  if (!run.submission) return false;
  const candidateId = candidateIdForSubmission(run.submission);
  // A confirmed vulnerability hypothesis is NOT submission-specific verification.
  // Verification must be precisely bound to the CURRENT submission's candidate:
  // an old candidate's verification must never let a different (new) submission
  // reach COMPLETE.
  const verifiedEvidence = (run.evidence ?? []).filter((evidence) => evidence.verificationIds.length > 0);
  if (verifiedEvidence.some((evidence) => evidence.candidateIds.includes(candidateId))) return true;
  // A verification_result observation qualifies only when it attaches to evidence
  // that is itself bound to the current candidate.
  return state.observations.some((observation) =>
    observation.type === "verification_result" &&
    observation.evidenceIds.some((evidenceId) =>
      verifiedEvidence.some((evidence) => evidence.id === evidenceId && evidence.candidateIds.includes(candidateId)),
    ),
  );
}

/**
 * Recommend the next Web phase from evidence already collected. Forward moves are
 * conservative: a phase only advances once the evidence that justifies the next one
 * exists. Retreats only fire when a later phase loses the evidence that justified it.
 * Returns undefined when the current phase should keep working.
 */
export function suggestNextWebPhase(state: WebReasoningState, run: RunState): PhaseAdvanceSignal | undefined {
  const current = run.webAgent?.phase ?? "INIT";
  if (current === "COMPLETE" || current === "FAILED") return undefined;

  switch (current) {
    case "INIT":
      return { target: "RECON", reason: "Web reasoning initialized; begin bounded surface mapping", confidence: 1 };
    case "RECON":
      if (hasSurfaceEvidence(state)) return { target: "ENUMERATION", reason: "Baseline response evidence collected; enumerate observed routes and parameters", confidence: 0.85 };
      break;
    case "ENUMERATION":
      if (hasEndpointEvidence(state)) return { target: "FINGERPRINT", reason: "Endpoints enumerated; classify the stack from response evidence", confidence: 0.85 };
      break;
    case "FINGERPRINT":
      if (hasTechnologyEvidence(state)) return { target: "VULNERABILITY_ANALYSIS", reason: "Technologies identified from response evidence; analyze plausible vulnerabilities", confidence: 0.85 };
      break;
    case "VULNERABILITY_ANALYSIS":
      if (hasSupportedHypothesis(state)) return { target: "EXPLOITATION", reason: "A hypothesis is supported by evidence; move to bounded exploitation", confidence: 0.9 };
      break;
    case "EXPLOITATION":
      if (hasCandidate(run, state)) return { target: "FLAG_SEARCH", reason: "A candidate was produced; search for the flag or final artifact", confidence: 0.8 };
      break;
    case "FLAG_SEARCH":
      if (run.submission) return { target: "VERIFICATION", reason: "A submission exists; verify it against collected evidence", confidence: 0.8 };
      break;
    case "VERIFICATION":
      if (hasIndependentVerification(state, run)) return { target: "COMPLETE", reason: "The candidate is independently verified by evidence", confidence: 0.95 };
      break;
  }

  if (current === "EXPLOITATION" && !hasSupportedHypothesis(state)) return { target: "VULNERABILITY_ANALYSIS", reason: "No hypothesis remains supported; return to analysis", confidence: 0.9 };
  if (current === "FLAG_SEARCH" && !hasCandidate(run, state)) return { target: "EXPLOITATION", reason: "No candidate exists; resume exploitation", confidence: 0.9 };
  if (current === "VERIFICATION" && !run.submission) return { target: "FLAG_SEARCH", reason: "No submission exists; resume flag search", confidence: 0.9 };
  return undefined;
}

export interface WebPhaseDriveResult {
  transitioned: boolean;
  from?: WebPhase;
  to?: WebPhase;
  reason?: string;
}

/**
 * Apply the recommended phase transition onto run.webAgent and record it in the audit
 * chain. Real transitions are temporal mutations, so `now` should be supplied by the
 * caller; the default only exists as a safety fallback.
 */
export async function driveWebPhase(
  run: RunState,
  state: WebReasoningState,
  audit?: AuditChain,
  now = new Date().toISOString(),
): Promise<WebPhaseDriveResult> {
  if (!run.webAgent) run.webAgent = createWebAgentState();
  const signal = suggestNextWebPhase(state, run);
  if (!signal) return { transitioned: false };
  const current = run.webAgent.phase;
  if (signal.target === current || !canTransition(current, signal.target)) return { transitioned: false };
  run.webAgent = transitionWebPhase(run.webAgent, signal.target, signal.reason, now);
  await audit?.append("WEB_PHASE_TRANSITIONED", {
    from: current,
    to: signal.target,
    reason: signal.reason,
    confidence: signal.confidence,
    history: run.webAgent.history.map(({ phase, enteredAt, completedAt }) => ({ phase, enteredAt, completedAt })),
  });
  return { transitioned: true, from: current, to: signal.target, reason: signal.reason };
}
