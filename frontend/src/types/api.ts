export type RunStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "aborted";
export type RunPhase = "intake" | "planning" | "exploration" | "analysis" | "verification" | "reporting" | "done";

export interface RunLineage { parentRunId: string; boundarySequence: number; mode: "fork" | "resume"; inheritedEventCount: number }
export interface RunSummary { id: string; status: RunStatus; phase: RunPhase; task: string; category?: string; createdAt: string; finishedAt?: string; turns: number; toolCalls: number; lessons: number; lineage?: RunLineage; }
export interface EvidenceRecord { id: string; summary: string; source: string; lifecycle: string; toolCallId?: string; observationIds?: string[]; hypothesisIds?: string[]; actionIds?: string[]; candidateIds?: string[]; verificationIds?: string[]; createdAt?: string; updatedAt?: string }
export interface HypothesisRecord { id: string; statement: string; status: string; evidence: string[]; updatedAt?: string }
export interface FindingRecord { id: string; title: string; severity: string; confidence: number; description?: string; evidence: string[] }
export interface WebActionRecord { id: string; proposalId: string; kind: string; objective: string; rationaleSummary: string; hypothesisId?: string; toolName?: string; toolCallId?: string; status: string; evidenceIds: string[]; startedAt?: string; completedAt?: string }
export interface WebHypothesisRecord { id: string; title: string; statement: string; status: string; confidence: number; supportingEvidenceIds: string[]; contradictingEvidenceIds: string[]; attemptedActionIds: string[]; updatedAt?: string }
export interface WebGraphNodeRecord { id: string; type: string; key: string; label: string; attributes: Record<string, unknown>; evidenceIds: string[]; observationIds: string[]; confidence: number; firstSeenAt: string; lastSeenAt: string; status: string }
export interface WebGraphEdgeRecord { id: string; type: string; fromNodeId: string; toNodeId: string; attributes: Record<string, unknown>; evidenceIds: string[]; confidence: number; firstSeenAt: string; lastSeenAt: string; status: string }
export interface RunState { id: string; status: RunStatus; phase: RunPhase; task: { task: string; metadata: Record<string, string>; attachments: unknown[] }; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; findings: FindingRecord[]; lessons: Array<Record<string, unknown>>; hypotheses: HypothesisRecord[]; strategyRevisions: Array<Record<string, unknown>>; evidence?: EvidenceRecord[]; turns: number; toolCalls: number; httpRequests: number; tcpSessions: number; summary?: string; stopReason?: string; webReasoning?: { observations: Array<Record<string, unknown>>; hypotheses: WebHypothesisRecord[]; actions: WebActionRecord[]; knowledgeGraph?: { nodes: WebGraphNodeRecord[]; edges: WebGraphEdgeRecord[] } }
  lineage?: RunLineage;
}
export interface RunSnapshot { id: string; status: RunStatus; state?: RunState; error?: string; events: Array<{ type: string; timestamp: string; data: unknown }> }
export type TrajectorySource = "operator" | "orchestrator" | "model" | "context" | "policy" | "tool" | "agent" | "system";
export interface TraceEvent { sequence: number; timestamp: string; kind: string; title: string; summary: string; data: unknown; status?: string; sourceEventType?: string; source?: TrajectorySource; actor?: string; correlationId?: string; parentSequence?: number }
export interface RunReview { id?: string; sequence: number; verdict: "correct" | "incorrect" | "uncertain"; note: string; correction?: string; createdAt?: string }
export interface RunTrace { state: RunState; integrity: { valid: boolean; records: number; error?: string }; timeline: TraceEvent[]; rawEvents?: Array<{ sequence: number; timestamp: string; type: string; source?: TrajectorySource; actor?: string; correlationId?: string; parentSequence?: number; data: unknown }>; reviews: RunReview[] }
export interface Experience { id: string; title: string; category?: string; strategy: string[]; status: "active" | "disabled"; promotedAt?: string }

export type ArenaJobStatus = "queued" | "running" | "stopping" | "completed" | "failed" | "aborted";
export type ArenaOutcome = "solved" | "wrong" | "blocked" | "abandoned" | "skipped" | "dry-run" | "infrastructure-error";

export interface ArenaReadiness {
  ready: boolean;
  issues: string[];
  model: { provider: string; id: string; name: string };
  arenaConfigured: boolean;
  arenaCredentialConfigured: boolean;
  modelCredentialConfigured: boolean;
  modelHeadersConfigured: boolean;
  scopeControlled: boolean;
  allowedCategories: string[];
  maxCategorySkips: number;
  sandbox: { reachable: boolean; network: string; availablePrograms: number; configuredPrograms: number };
}

export interface ArenaJobListItem {
  id: string;
  status: ArenaJobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  targetAttempts: number | null;
  continuous: boolean;
  completedAttempts: number;
  currentRunId?: string;
  accuracyPercent?: number | null;
  error?: string;
}

export interface ArenaAttemptEvaluation {
  attemptId: number;
  category: string;
  problemRating?: number;
  outcome: ArenaOutcome;
  settled: boolean;
  correct?: boolean;
  flagCandidateFound: boolean;
  submissionAttempts: number;
  runCount: number;
  attachmentCount: number;
  reused: boolean;
  run: { id: string; status: RunStatus; summary?: string; stopReason?: string; turns: number; toolCalls: number; promotedLessons?: number };
  platform?: { state?: string; ratingDelta?: number; agentRatingAfter?: number; problemRatingAfter?: number };
  reason?: string;
}

export interface ArenaCapabilitySummary {
  solved: number;
  evaluated: number;
  accuracyPercent: number | null;
  averageTurns: number;
  averageToolCalls: number;
  promotedLessons: number;
  outcomes: Record<string, number>;
  strengths: string[];
  gaps: string[];
  nextActions: string[];
}

export interface ArenaJobSnapshot extends ArenaJobListItem {
  options: { maxAttempts: number; autoSubmit: boolean; idleSeconds: number; continuous: boolean };
  attempts: ArenaAttemptEvaluation[];
  activity: Array<{ timestamp: string; type: string; runId: string; detail: string }>;
  summary?: ArenaCapabilitySummary;
  reportPath?: string;
}

export interface ArenaWrongQuestionSummary {
  attemptId: number;
  category: string;
  status: "pending";
  firstFailedAt: string;
  lastFailedAt: string;
  failureCount: number;
  attachmentCount: number;
  lastOutcome: "wrong" | "blocked" | "abandoned";
  lastReason: string;
}

export interface ArenaWrongQuestionRecord {
  attemptId: number;
  category: string;
  status: "pending";
  firstFailedAt: string;
  lastFailedAt: string;
  failureCount: number;
  task: string;
  attachments: Array<{ name: string; path: string; size: number; sha256?: string }>;
  failures: Array<{ failedAt: string; sourceRunId: string; outcome: "wrong" | "blocked" | "abandoned"; reason: string; runStatus: RunStatus; stopReason?: string; turns: number; toolCalls: number }>;
}

export interface ArenaStatusResponse {
  readiness: ArenaReadiness;
  jobs: ArenaJobListItem[];
  wrongQuestions: ArenaWrongQuestionSummary[];
}

export type ManualJobStatus = "queued" | "running" | "stopping" | "completed" | "aborted";
export type ManualTaskStatus = "queued" | "running" | "completed" | "blocked" | "skipped" | "failed" | "aborted";

export interface ManualTaskSnapshot {
  index: number;
  task: string;
  status: ManualTaskStatus;
  attachmentCount: number;
  runId?: string;
  flag?: string;
  writeup?: string;
  error?: string;
  runAttempts?: number;
  race?: { agentCount: number; winnerAgent?: number; runIds: string[]; cancelledAgents: number; sharedEvidenceEntries: number };
  run?: { id: string; status: RunStatus; turns: number; toolCalls: number };
}

export interface ManualJobSnapshot {
  id: string;
  status: ManualJobStatus;
  concurrency: number;
  raceAgents: number;
  writeup: boolean;
  skipBlocked: boolean;
  transientRetryLimit: number;
  total: number;
  queued: number;
  running: number;
  completed: number;
  skipped: number;
  failed: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  tasks: ManualTaskSnapshot[];
}

export interface QuestionBankQuestion {
  id: string;
  title: string;
  category: string;
  attachmentCount: number;
  instanceAvailable: boolean;
  status: "pending" | "solved";
  solvedAt?: string;
}

export interface QuestionBankSnapshot {
  enabled: boolean;
  configured: boolean;
  root?: string;
  count: number;
  solvedCount?: number;
  pendingCount?: number;
  questions?: QuestionBankQuestion[];
  error?: string;
}

export interface ManualUploadSnapshot { id: string; files: Array<{ id: string; name: string; size: number }>; totalBytes: number }
