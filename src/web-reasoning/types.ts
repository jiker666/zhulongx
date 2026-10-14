import type { EvidenceRecord, NormalizedTask, RunState } from "../types.js";

export type WebReasoningPhase =
  | "initializing" | "observing" | "hypothesizing" | "planning" | "acting"
  | "evaluating" | "reflecting" | "verifying" | "completing" | "completed" | "blocked";

export interface WebTaskDetectionReason { signal: string; detail: string; weight: number; }
export interface WebTaskClassification {
  isWeb: boolean;
  confidence: number;
  reasons: WebTaskDetectionReason[];
  source: "explicit_metadata" | "url" | "description" | "attachment" | "benchmark" | "combined" | "none";
}

export type WebObservationType = "target" | "url" | "endpoint" | "parameter" | "method" | "response" | "header" | "cookie_metadata" | "technology" | "artifact" | "tool_result" | "redirect" | "content_type" | "error_signal" | "timing_signal" | "verification_result";
export interface WebObservation {
  id: string; type: WebObservationType; summary: string;
  source: "task" | "tool" | "provider" | "benchmark" | "verifier" | "system";
  evidenceIds: string[]; toolCallId?: string; actionId?: string; confidence: number;
  normalizedKey: string; createdAt: string; updatedAt: string;
}

export type WebHypothesisStatus = "created" | "queued" | "testing" | "supported" | "confirmed" | "weakened" | "rejected" | "blocked" | "expired";
export type WebHypothesisCategory = "surface_mapping" | "authentication" | "authorization" | "session" | "input_handling" | "server_side_processing" | "file_handling" | "client_side_behavior" | "information_disclosure" | "business_logic" | "configuration" | "unknown";
export interface WebHypothesis {
  id: string; category: WebHypothesisCategory; title: string; statement: string; status: WebHypothesisStatus;
  confidence: number; priority: number; supportingEvidenceIds: string[]; contradictingEvidenceIds: string[];
  sourceObservationIds: string[]; requiredEvidence: string[]; attemptedActionIds: string[];
  createdAt: string; updatedAt: string; closedAt?: string;
}

export type WebActionKind = "inspect_task" | "inspect_existing_evidence" | "invoke_tool" | "compare_responses" | "create_hypothesis" | "test_hypothesis" | "verify_candidate" | "switch_strategy" | "request_missing_input" | "complete" | "blocked";
export type WebActionStatus = "proposed" | "approved" | "policy_rejected" | "executing" | "succeeded" | "failed" | "aborted" | "timed_out" | "skipped_duplicate";
export interface WebReasoningActionProposal {
  id: string; kind: WebActionKind; objective: string; rationaleSummary: string; hypothesisId?: string;
  evidenceIds: string[]; requestedTool?: string; requestedArguments?: Record<string, unknown>;
  expectedSignal: string; failureSignal: string; priority: number; estimatedCost: number; deduplicationKey: string;
}
export interface WebReasoningAction {
  id: string; proposalId: string; kind: WebActionKind; objective: string; rationaleSummary: string;
  hypothesisId?: string; toolName?: string; toolCallId?: string; argumentsFingerprint?: string;
  deduplicationKey: string; status: WebActionStatus; evidenceIds: string[]; startedAt?: string;
  /** Mutation epoch (R17): how many state-changing calls had run when this action executed. A read taken in an older epoch never blocks a re-read. */
  stateEpoch?: number;
  completedAt?: string; failureCode?: string; failureSummary?: string;
}

export type WebEvaluationDecision = "continue" | "switch_strategy" | "verify" | "complete" | "blocked" | "request_input";
export interface WebEvaluation {
  id: string; actionId?: string; hypothesisId?: string; decision: WebEvaluationDecision;
  rationaleSummary: string; newEvidenceIds: string[]; changedHypothesisIds: string[];
  progressScore: number; confidenceDelta: number; stagnationDetected: boolean; createdAt: string;
}
export interface WebReflection {
  id: string; knownFacts: string[]; unsupportedAssumptions: string[]; failedApproaches: string[];
  unresolvedQuestions: string[]; missingEvidence: string[]; recommendedNextObjective?: string;
  relatedEvidenceIds: string[]; relatedHypothesisIds: string[]; relatedActionIds: string[]; createdAt: string;
}
export interface WebStagnationState {
  consecutiveNoEvidenceRounds: number; consecutiveDuplicateActions: number; consecutiveToolFailures: number;
  lastProgressAt?: string; detected: boolean; reason?: string;
}
export interface WebReasoningBudgetState { remainingRounds: number; finalizationReserve: number; actionsUsed: number; }
export interface WebReasoningState {
  schemaVersion: number; enabled: boolean; phase: WebReasoningPhase; taskClassification: WebTaskClassification;
  observations: WebObservation[]; hypotheses: WebHypothesis[]; plans: WebPlan[]; actions: WebReasoningAction[];
  evaluations: WebEvaluation[]; reflections: WebReflection[]; activeHypothesisIds: string[];
  unresolvedHypothesisIds: string[]; rejectedHypothesisIds: string[]; confirmedHypothesisIds: string[];
  lastActionId?: string; nextRecommendedAction?: WebReasoningActionProposal; stagnation: WebStagnationState;
  budget: WebReasoningBudgetState; createdAt: string; updatedAt: string;
  mutationEpoch?: number;
  knowledgeGraph?: WebKnowledgeGraphState;
  roleCoordination?: WebRoleCoordinationState;
  browser?: import("./browser/types.js").BrowserIntelligenceState;
  webIntelligence?: import("./javascript/types.js").WebIntelligenceState;
}
export type JsonSafeValue = string | number | boolean | null | JsonSafeValue[] | { [key: string]: JsonSafeValue };
export type WebGraphNodeType = "target" | "origin" | "url" | "endpoint" | "parameter" | "http_method" | "request" | "response" | "header" | "cookie" | "technology" | "artifact" | "script" | "api" | "form" | "authentication_boundary" | "candidate" | "verification" | "browser_session" | "browser_page" | "dom_state" | "dom_element" | "client_route" | "dialog" | "frame" | "network_request" | "network_response" | "browser_storage_key" | "unknown";
export type WebGraphEdgeType = "contains" | "links_to" | "redirects_to" | "calls" | "submits_to" | "accepts" | "returns" | "sets" | "requires" | "reflects" | "indicates" | "served_by" | "implemented_by" | "derived_from" | "supports" | "contradicts" | "verified_by" | "related_to" | "session_contains_page" | "page_has_state" | "state_contains_element" | "action_transitions_to" | "element_navigates_to" | "element_submits_to" | "page_issues_request" | "request_receives_response" | "page_reads_storage" | "page_writes_storage" | "state_differs_from" | "action_triggered_request";
export interface WebGraphNode { id: string; type: WebGraphNodeType; key: string; label: string; attributes: Record<string, JsonSafeValue>; evidenceIds: string[]; observationIds: string[]; confidence: number; firstSeenAt: string; lastSeenAt: string; status: "active" | "stale" | "invalidated" | "superseded"; }
export interface WebGraphEdge { id: string; type: WebGraphEdgeType; fromNodeId: string; toNodeId: string; attributes: Record<string, JsonSafeValue>; evidenceIds: string[]; confidence: number; firstSeenAt: string; lastSeenAt: string; status: "active" | "invalidated" | "superseded"; }
export interface WebGraphIndexes { nodeByKey: Record<string, string>; edgesByFrom: Record<string, string[]>; edgesByTo: Record<string, string[]>; }
export interface WebGraphStatistics { nodeCount: number; edgeCount: number; duplicateNodeMerges: number; duplicateEdgeMerges: number; integrityWarnings: number; projectionCount: number; }
export interface WebKnowledgeGraphState { schemaVersion: number; nodes: WebGraphNode[]; edges: WebGraphEdge[]; indexes: WebGraphIndexes; statistics: WebGraphStatistics; createdAt: string; updatedAt: string; degraded?: boolean; }
export interface WebPlan { id: string; objective: string; actionIds: string[]; createdAt: string; }
export type WebRole = "coordinator" | "recon" | "fingerprint" | "js_analysis" | "behavior_analysis" | "browser" | "verification";
export type WebRoleOutputType = "observation" | "hypothesis_update" | "action_proposal" | "verification_result" | "blocked";
export interface WebRoleObjective { id: string; role: WebRole; objective: string; targetNodeIds: string[]; hypothesisIds: string[]; evidenceIds: string[]; expectedOutputs: WebRoleOutputType[]; prohibitedActions: string[]; priority: number; deadlineRound?: number; }
export interface WebRoleResult { objectiveId: string; role: WebRole; status: "completed" | "partial" | "blocked" | "no_progress"; rationaleSummary: string; observationIds: string[]; evidenceIds: string[]; proposedActions: WebReasoningActionProposal[]; createdAt: string; }
export interface WebRoleCoordinationState { schemaVersion: number; activeRole: WebRole; objectiveQueue: WebRoleObjective[]; completedObjectiveIds: string[]; blockedObjectiveIds: string[]; results: WebRoleResult[]; roleSwitchCount: number; noProgressCount: number; updatedAt: string; }
export interface WebPlanningContext { state: WebReasoningState; availableTools: string[]; remainingRounds: number; remainingToolBudget: number; run: RunState; graphQuery?: { findUnexploredEndpoints(): WebGraphNode[]; findTechnologies(): WebGraphNode[]; findCandidateEvidencePaths(candidateId: string): Array<{ nodeIds: string[]; edgeIds: string[] }>; }; }
export interface WebReasoningInitializationContext { task: NormalizedTask; remainingRounds: number; enabled: boolean; }
export interface WebReasoningTurnPreparation { context: string; proposal?: WebReasoningActionProposal; }
export interface WebReasoningToolResultContext { toolName: string; toolCallId: string; isError: boolean; result: unknown; args: unknown; }
export interface WebReasoningEvaluationResult { evaluation: WebEvaluation; evidence?: EvidenceRecord; }
export interface WebReasoningFinalizationDecision { shouldFinalize: boolean; reason: string; }
