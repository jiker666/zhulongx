import { newId } from "./state.js";
import type { WebEvaluation, WebReasoningState } from "./types.js";

export function evaluateProgress(state: WebReasoningState, input: { actionId?: string; hypothesisId?: string; newEvidenceIds: string[]; isError: boolean; candidateVerified?: boolean }): WebEvaluation {
  const progress = input.candidateVerified ? 1 : input.newEvidenceIds.length > 0 ? 0.5 : input.isError ? -0.4 : -0.1;
  const noEvidence = input.newEvidenceIds.length === 0;
  state.stagnation.consecutiveNoEvidenceRounds = noEvidence ? state.stagnation.consecutiveNoEvidenceRounds + 1 : 0;
  state.stagnation.consecutiveToolFailures = input.isError ? state.stagnation.consecutiveToolFailures + 1 : 0;
  if (!noEvidence) state.stagnation.lastProgressAt = new Date().toISOString();
  const stagnationDetected = state.stagnation.consecutiveNoEvidenceRounds >= 3 || state.stagnation.consecutiveToolFailures >= 3 || state.stagnation.consecutiveDuplicateActions >= 2;
  state.stagnation.detected = stagnationDetected;
  if (stagnationDetected) state.stagnation.reason = "No new evidence or repeated tool failures";
  else delete state.stagnation.reason;
  const decision = input.candidateVerified ? "complete" : stagnationDetected ? "switch_strategy" : noEvidence ? "continue" : "continue";
  const evaluation: WebEvaluation = { id: newId("eval"), ...(input.actionId ? { actionId: input.actionId } : {}), ...(input.hypothesisId ? { hypothesisId: input.hypothesisId } : {}), decision, rationaleSummary: input.candidateVerified ? "Candidate verification completed." : noEvidence ? "The action did not create new evidence." : "The action created new bounded evidence.", newEvidenceIds: input.newEvidenceIds, changedHypothesisIds: input.hypothesisId ? [input.hypothesisId] : [], progressScore: progress, confidenceDelta: progress * 0.1, stagnationDetected, createdAt: new Date().toISOString() };
  state.evaluations.push(evaluation);
  state.evaluations = state.evaluations.slice(-40);
  return evaluation;
}
