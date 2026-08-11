export type DecisionKind = "observation" | "hypothesis" | "action" | "evidence" | "result" | "policy" | "system" | "warning";

export interface RawTraceEvent {
  sequence: number;
  timestamp: string;
  type: string;
  data: unknown;
}

export interface DecisionRecord {
  id: string;
  sequence: number;
  timestamp?: string;
  kind: DecisionKind;
  title: string;
  summary: string;
  sourceEventType: string;
  confidenceBefore?: number;
  confidenceAfter?: number;
  relatedEvidenceIds?: string[];
  relatedActionId?: string;
  relatedCandidateId?: string;
  policyState?: string;
  technicalDetails?: Record<string, unknown>;
}
