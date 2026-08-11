import { newId } from "./state.js";
import type { WebReflection, WebReasoningState } from "./types.js";

export function createReflection(state: WebReasoningState, now = new Date().toISOString()): WebReflection {
  const reflection: WebReflection = {
    id: newId("reflection"),
    knownFacts: state.observations.slice(-8).map((item) => item.summary).slice(0, 8),
    unsupportedAssumptions: state.hypotheses.filter((item) => ["created", "queued", "testing", "weakened"].includes(item.status)).map((item) => item.statement).slice(0, 8),
    failedApproaches: state.actions.filter((item) => ["failed", "policy_rejected", "skipped_duplicate"].includes(item.status)).map((item) => item.failureSummary ?? item.objective).slice(-8),
    unresolvedQuestions: state.hypotheses.filter((item) => item.status !== "confirmed" && item.status !== "rejected").map((item) => item.requiredEvidence[0] ?? item.title).slice(0, 8),
    missingEvidence: state.hypotheses.flatMap((item) => item.requiredEvidence).slice(0, 8),
    relatedEvidenceIds: state.observations.flatMap((item) => item.evidenceIds).slice(-16),
    relatedHypothesisIds: state.unresolvedHypothesisIds.slice(-8),
    relatedActionIds: state.actions.slice(-8).map((item) => item.id),
    createdAt: now,
  };
  if (reflection.unresolvedQuestions[0]) reflection.recommendedNextObjective = reflection.unresolvedQuestions[0];
  state.reflections.push(reflection);
  state.reflections = state.reflections.slice(-12);
  return reflection;
}
