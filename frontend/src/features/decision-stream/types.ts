import type { TrajectorySource } from "../../types/api";

export type DecisionKind = "observation" | "hypothesis" | "action" | "evidence" | "result" | "policy" | "context" | "system" | "warning";

export interface RawTraceEvent {
  sequence: number;
  timestamp: string;
  type: string;
  source?: TrajectorySource;
  actor?: string;
  correlationId?: string;
  parentSequence?: number;
  data: unknown;
}

export interface PlainLanguageExplanation {
  what: string;
  why: string;
  impact: string;
  result?: string;
  next?: string;
}

export interface DecisionRecord {
  id: string;
  sequence: number;
  timestamp?: string;
  kind: DecisionKind;
  title: string;
  summary: string;
  sourceEventType: string;
  source: TrajectorySource;
  actor?: string;
  correlationId?: string;
  parentSequence?: number;
  explanation: PlainLanguageExplanation;
  confidenceBefore?: number;
  confidenceAfter?: number;
  relatedEvidenceIds?: string[];
  relatedActionId?: string;
  relatedCandidateId?: string;
  policyState?: string;
  technicalDetails?: Record<string, unknown>;
}
