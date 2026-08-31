export type RunStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "aborted" | "indexing";
export type RunPhase = "intake" | "planning" | "exploration" | "analysis" | "verification" | "reporting" | "done";

export interface RunLineage { parentRunId: string; boundarySequence: number; mode: "fork" | "resume"; inheritedEventCount: number }
export interface RunSummary { id: string; status: RunStatus; phase: RunPhase; task: string; category?: string; createdAt: string; finishedAt?: string; turns: number; toolCalls: number; lessons: number; lineage?: RunLineage; indexPending?: boolean; }
export interface EvidenceRecord { id: string; summary: string; source: string; lifecycle: string; toolCallId?: string; observationIds?: string[]; hypothesisIds?: string[]; actionIds?: string[]; candidateIds?: string[]; verificationIds?: string[]; createdAt?: string; updatedAt?: string }
export interface HypothesisRecord { id: string; statement: string; status: string; evidence: string[]; updatedAt?: string }
export interface FindingRecord { id: string; title: string; severity: string; confidence: number; description?: string; evidence: string[] }
export interface StrategyRevisionRecord { id: string; classification: string; planChanges: string[]; nextAction: string; rationale: string; createdAt: string }
export interface WebActionRecord { id: string; proposalId: string; kind: string; objective: string; rationaleSummary: string; hypothesisId?: string; toolName?: string; toolCallId?: string; status: string; evidenceIds: string[]; startedAt?: string; completedAt?: string }
export interface WebHypothesisRecord { id: string; title: string; statement: string; status: string; confidence: number; priority?: number; supportingEvidenceIds: string[]; contradictingEvidenceIds: string[]; attemptedActionIds: string[]; requiredEvidence?: string[]; updatedAt?: string }
export interface WebActionProposal { id: string; kind: string; objective: string; rationaleSummary: string; hypothesisId?: string; evidenceIds: string[]; requestedTool?: string; expectedSignal: string; failureSignal: string; priority: number; estimatedCost: number; deduplicationKey: string }
export interface WebEvaluationRecord { id: string; actionId?: string; hypothesisId?: string; decision: string; rationaleSummary: string; newEvidenceIds: string[]; changedHypothesisIds: string[]; progressScore: number; confidenceDelta: number; stagnationDetected: boolean; createdAt: string }
export interface WebReflectionRecord { id: string; knownFacts: string[]; unsupportedAssumptions: string[]; failedApproaches: string[]; unresolvedQuestions: string[]; missingEvidence: string[]; recommendedNextObjective?: string; relatedEvidenceIds: string[]; relatedHypothesisIds: string[]; relatedActionIds: string[]; createdAt: string }
export interface WebStagnationRecord { consecutiveNoEvidenceRounds: number; consecutiveDuplicateActions: number; consecutiveToolFailures: number; lastProgressAt?: string; detected: boolean; reason?: string }
export interface WebRoleCoordinationRecord { activeRole: string; roleSwitchCount: number; noProgressCount: number }
export interface BrowserStateSnapshot { id: string; sessionId: string; pageId: string; url: string; documentHash: string; visibleTextHash?: string; createdAt: string; sourceEvidenceIds: string[]; elementCount: number; interactiveElementIds: string[] }
export interface BrowserStateTransitionRecord { id: string; sessionId: string; pageId: string; beforeSnapshotId?: string; actionId: string; afterSnapshotId?: string; navigationChanged: boolean; domChanged: boolean; visibleTextChanged: boolean; formStateChanged: boolean; newNetworkEvidenceIds: string[]; newDialogEvidenceIds: string[]; significance: string; createdAt: string }
export interface BrowserNetworkEventRecord { id: string; sessionId: string; pageId: string; kind: string; url: string; origin: string; method?: string; resourceType?: string; status?: number; timestamp: string }
export interface BrowserStateRecord { capability: { available: boolean; provider: string; browserType: string; reason?: string }; sessions: Array<{ id: string; status: string; currentUrl?: string; actionCount: number; networkEventCount: number }>; pages: Array<{ id: string; sessionId: string; url?: string; title?: string }>; domSnapshots: BrowserStateSnapshot[]; stateTransitions: BrowserStateTransitionRecord[]; networkEventSummaries: BrowserNetworkEventRecord[] }
export interface WebGraphNodeRecord { id: string; type: string; key: string; label: string; attributes: Record<string, unknown>; evidenceIds: string[]; observationIds: string[]; confidence: number; firstSeenAt: string; lastSeenAt: string; status: string }
export interface WebGraphEdgeRecord { id: string; type: string; fromNodeId: string; toNodeId: string; attributes: Record<string, unknown>; evidenceIds: string[]; confidence: number; firstSeenAt: string; lastSeenAt: string; status: string }
export interface RunState { id: string; status: RunStatus; phase: RunPhase; task: { task: string; metadata: Record<string, string>; attachments: unknown[] }; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; plan?: { goal: string; assumptions: string[]; hypotheses: string[]; steps: Array<{ id: string; objective: string; successCriteria: string[]; tools: string[] }> }; findings: FindingRecord[]; lessons: Array<Record<string, unknown>>; hypotheses: HypothesisRecord[]; strategyRevisions: StrategyRevisionRecord[]; strategyRevisionRequired?: boolean; lastFailure?: { classification: string; toolName: string; reason: string; createdAt: string }; evidence?: EvidenceRecord[]; turns: number; toolCalls: number; imageObservations?: number; httpRequests: number; tcpSessions: number; actionsSinceCheckpoint?: number; workspaceMode?: string; appliedExperienceIds?: string[]; submission?: string; independentlyVerified?: boolean; verification?: string[]; summary?: string; writeup?: string; writeupError?: string; stopReason?: string; webAgent?: { phase: string; activeRole: string; failureCount: number; repeatedActionCount: number; history: Array<{ phase: string; enteredAt: string; reason: string; completedAt?: string }> }; contextCuts?: Array<{ id: string; throughSeq: number; throughMessageCount: number; sourceEventCount: number; summary: string; createdAt: string }>; webReasoning?: { phase?: string; observations: Array<Record<string, unknown>>; hypotheses: WebHypothesisRecord[]; actions: WebActionRecord[]; evaluations?: WebEvaluationRecord[]; reflections?: WebReflectionRecord[]; nextRecommendedAction?: WebActionProposal; stagnation?: WebStagnationRecord; roleCoordination?: WebRoleCoordinationRecord; browser?: BrowserStateRecord; knowledgeGraph?: { nodes: WebGraphNodeRecord[]; edges: WebGraphEdgeRecord[] } }
  lineage?: RunLineage;
}
export interface RunSnapshot { id: string; status: RunStatus; state?: RunState; error?: string; events: Array<{ type: string; timestamp: string; data: unknown }> }
export type TrajectorySource = "operator" | "orchestrator" | "model" | "context" | "policy" | "tool" | "agent" | "system";
export interface TraceEvent { sequence: number; timestamp: string; kind: string; title: string; summary: string; data: unknown; status?: string; sourceEventType?: string; source?: TrajectorySource; actor?: string; correlationId?: string; parentSequence?: number }
export interface RunReview { id?: string; sequence: number; verdict: "correct" | "incorrect" | "uncertain"; note: string; correction?: string; createdAt?: string }
export interface RunTrace { state: RunState; integrity: { valid: boolean; records: number; error?: string }; timeline: TraceEvent[]; rawEvents?: Array<{ sequence: number; timestamp: string; type: string; source?: TrajectorySource; actor?: string; correlationId?: string; parentSequence?: number; data: unknown }>; reviews: RunReview[] }
export interface Experience { id: string; title: string; category?: string; strategy: string[]; applicableWhen?: string[]; verification?: string[]; pitfalls?: string[]; tools?: string[]; sourceRunId?: string; validation?: string; status: "active" | "disabled"; promotedAt?: string }
export interface EvaluationManifest { id: string; suite: string; datasetVersion: string; split: "development" | "validation" | "hidden"; model: { provider: string; id: string; thinkingLevel: string }; runtime: { node: string; platform: string; arch: string }; budget: { maxAttempts: number; maxRuntimeMsPerAttempt: number; maxTokensPerAttempt: number; maxCostMicrosPerAttempt: number; networkAllowed: boolean }; artifacts: Array<{ name: string; sha256: string; bytes: number }>; containerDigests: Record<string, string>; manifestHash: string; createdAt: string }
export interface EvaluationReport { manifest: EvaluationManifest; attempts: number; successes: number; successRate: number; outcomes: Record<string, number>; errors: Record<string, number>; durationMs: { mean: number; min: number; max: number }; tokens: { total: number; mean: number }; costMicros: { total: number; mean: number }; traceReferences: Array<{ runId: string; runArtifactId: string; auditSha256?: string }> }
export interface EvaluationAttempt { id: string; manifestId: string; taskId: string; runId: string; outcome: "success" | "partial" | "failed" | "blocked"; durationMs: number; tokensUsed: number; costMicros: number; toolCalls: number; timeToFirstHypothesisMs?: number; errorCode?: string; trace: { auditPath?: string; auditSha256?: string; runArtifactId: string }; createdAt: string }

export type RuntimeAgentStatus = "initializing" | "idle" | "running" | "interrupted" | "error" | "closed";
export type RuntimeTaskStatus = "queued" | "starting" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export interface RuntimeAgent { id: string; rootAgentId: string; parentAgentId?: string; path: string; purpose: "joined" | "addressable"; status: RuntimeAgentStatus; profileId: string; depth: number; version: number; createdAt: string; updatedAt: string }
export interface RuntimeTask { id: string; agentId: string; parentTaskId?: string; ownerTurnId?: string; kind: "delegation" | "workflow_node" | "team_turn"; awaitPolicy: "join" | "background"; cancelPolicy: "linked" | "detached"; status: RuntimeTaskStatus; message: string; context: string[]; leaseGeneration: number; leaseOwner?: string; leaseExpiresAt?: string; attempts: number; providerTokensUsed: number; providerCostUsedMicros: number; budget: { maxRuntimeMs: number; maxTokens: number; maxCostMicros: number }; version: number; createdAt: string; updatedAt: string }
export interface RuntimeTaskResult { taskId: string; agentId: string; status: "succeeded" | "failed" | "cancelled"; summary: string; body?: string; artifacts: string[]; unread: boolean; leaseGeneration: number; createdAt: string; acknowledgedAt?: string }
export interface RuntimeMailboxMessage { id: string; agentId: string; senderAgentId?: string; text: string; createdAt: string; delivered: boolean }
export interface RuntimeEvent { id: string; type: string; agentId?: string; taskId?: string; detail?: string; createdAt: string }
export interface RuntimeAgentsSnapshot { version: 1; agents: RuntimeAgent[]; tasks: RuntimeTask[]; results: RuntimeTaskResult[]; messages: RuntimeMailboxMessage[]; events: RuntimeEvent[] }
export type RuntimeWorkflowNodeStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
export type RuntimeWorkflowStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type RuntimeWorkflowEffect = "pure_readonly" | "workspace_read" | "workspace_write" | "network" | "unknown";
export interface RuntimeWorkflowDependency { nodeId: string; condition: "success" | "settled" }
export interface RuntimeWorkflowNode { id: string; kind: "work" | "join" | "gate" | "controller"; message: string; dependencies: RuntimeWorkflowDependency[]; effect: RuntimeWorkflowEffect; cachePolicy: "none" | "evidence"; evidenceVersion?: string; maxAttempts: number; status: RuntimeWorkflowNodeStatus; attempts: number; leaseGeneration: number; leaseOwner?: string; leaseExpiresAt?: string; summary?: string; error?: string; startedAt?: string; finishedAt?: string; updatedAt: string }
export interface RuntimeWorkflow { id: string; name: string; status: RuntimeWorkflowStatus; nodes: RuntimeWorkflowNode[]; budget: { maxNodes: number; maxRuntimeMs: number; maxNetworkNodes: number; maxNetworkRequests: number; maxTokens: number; maxCostMicros: number; maxControllerExpansions: number }; usage: { networkNodes: number; networkRequests: number; tokens: number; costMicros: number; controllerExpansions: number }; createdAt: string; updatedAt: string; finishedAt?: string }
export interface RuntimeWorkflowEvent { id: string; workflowId: string; nodeId?: string; type: string; detail?: string; createdAt: string }
export interface RuntimeWorkflowsSnapshot { version: 1; workflows: RuntimeWorkflow[]; events: RuntimeWorkflowEvent[] }

export type ManualJobStatus = "queued" | "running" | "stopping" | "completed" | "aborted";
export type ManualTaskStatus = "queued" | "running" | "completed" | "blocked" | "skipped" | "failed" | "aborted";

export interface ManualTaskSnapshot {
  index: number;
  task: string;
  status: ManualTaskStatus;
  attachmentCount: number;
  runId?: string;
  submission?: string;
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

export type AdaptiveCampaignStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export type CampaignWorkStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export interface CampaignEvidence { id: string; kind: "fact" | "candidate" | "dead-end"; claim: string; evidence: string[]; confidence: number; sourceRunIds: string[]; createdAt: string; updatedAt: string }
export interface CampaignEvent { sequence: number; id: string; campaignId: string; itemId?: string; runId?: string; type: string; detail?: string; data?: unknown; createdAt: string }
export interface CampaignWorkItem { id: string; campaignId: string; rootIndex: number; lane: number; parentItemId?: string; tier: 0 | 1 | 2 | 3; task: { task: string; attachments?: string[]; metadata?: Record<string, string> }; status: CampaignWorkStatus; attempts: number; leaseGeneration: number; leaseOwner?: string; leaseExpiresAt?: string; runId?: string; summary?: string; error?: string; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string }
export interface AdaptiveCampaignSnapshot { id: string; name: string; status: AdaptiveCampaignStatus; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; concurrency: number; raceAgents: number; budget: { maxRuntimeMs: number; maxWorkers: number; maxItems: number; maxRuns: number }; tiers: Array<{ tier: 0 | 1 | 2 | 3; label: string; maxAttempts: number; hintAfterTier?: 0 | 1 | 2 | 3 }>; items: CampaignWorkItem[]; evidence: CampaignEvidence[]; curation: Array<{ id: string; itemId: string; runId?: string; summary: string; evidenceIds: string[]; proposedTasks: string[]; createdAt: string }>; events: CampaignEvent[]; runsStarted: number; verifiedRuns: number; queued: number; running: number; succeeded: number; blocked: number; failed: number; currentTier: 0 | 1 | 2 | 3; error?: string }
