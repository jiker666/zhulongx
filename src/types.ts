import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export type RunStatus = "queued" | "running" | "completed" | "blocked" | "failed" | "aborted";
export type RunPhase = "intake" | "planning" | "exploration" | "analysis" | "verification" | "reporting" | "done";
export type ScopeMode = "observe" | "controlled";

export interface ModelConfig {
  provider: string;
  id: string;
  name: string;
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  baseUrl: string;
  apiKeyEnv: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  headersFromEnv?: Record<string, string>;
}

export interface RuntimeConfig {
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  artifactRoot: string;
  scratchRoot: string;
  maxTurns: number;
  maxToolCalls: number;
  maxRuntimeMs: number;
  modelMinIntervalMs: number;
  modelRequestsPerMinute: number;
  modelTokensPerMinute: number;
  modelMaxRetryDelayMs: number;
  maxActionsWithoutCheckpoint: number;
  maxRepeatedAction: number;
  maxOutputBytes: number;
  maxImageBytes: number;
  maxImageObservations: number;
  maxScratchFileBytes: number;
  finalizationReserveMs: number;
  commandTimeoutMs: number;
  httpTimeoutMs: number;
  maxHttpRequests: number;
  maxTcpSessions: number;
  maxTcpBytes: number;
  sandbox: SandboxConfig;
}

export interface WebReasoningConfig {
  enabled: boolean;
  autoDetectWebTasks: boolean;
  persistState: boolean;
  enableHypothesisManagement: boolean;
  enableReflection: boolean;
  enableActionDeduplication: boolean;
  noEvidenceRoundLimit: number;
  duplicateActionLimit: number;
  toolFailureLimit: number;
  finalizationRoundReserve: number;
  maxObservations: number;
  maxHypotheses: number;
  maxActions: number;
  maxReflections: number;
}

export interface SandboxConfig {
  socketPath: string;
  connectTimeoutMs: number;
}

export interface ScopeConfig {
  mode: ScopeMode;
  workspaceRoot: string;
  allowedHosts: string[];
  allowedPrograms: string[];
  /** Extra directories prepended to PATH inside the sandbox (e.g. conda/venv bin dirs). */
  extraPaths?: string[];
  /** Python modules that the operator expects in the selected sandbox interpreter. */
  pythonModules?: string[];
  /** Extra read-only directories that command arguments may reference (e.g. wordlists). */
  readOnlyPaths?: string[];
}

export interface ServerConfig {
  host: string;
  port: number;
  tokenEnv: string;
}

export interface QuestionBankConfig {
  enabled: boolean;
  root?: string;
  rootEnv?: string;
  listFiles: string[];
  maxQuestions: number;
  raceAgents?: number;
  instanceRunner?: {
    enabled: boolean;
    networkName: string;
    startupTimeoutMs: number;
    commandTimeoutMs: number;
    maxOutputBytes: number;
  };
}

export interface AppConfig {
  model: ModelConfig;
  runtime: RuntimeConfig;
  scope: ScopeConfig;
  server: ServerConfig;
  questionBank?: QuestionBankConfig;
  webReasoning?: WebReasoningConfig;
  browser?: import("./web-reasoning/browser/types.js").BrowserRuntimeConfig;
  profile?: AgentProfileConfig;
  connectors?: import("./connector.js").ConnectorConfig[];
}

export interface AgentProfileConfig {
  id: string;
  systemPrompt?: string;
  preferredExecutor: "sandbox" | "local" | "ssh" | "connector";
  executorTargetId?: string;
  requiredCapabilities: string[];
  toolAllowlist: string[];
  approvalPolicy?: "always" | "on-request" | "never";
  contextPolicy: {
    compactAtRatio: number;
    keepRecentTokens: number;
    maxSummaryChars: number;
  };
}

export interface TaskRequest {
  task: string;
  attachments?: string[];
  scope?: Partial<ScopeConfig>;
  metadata?: Record<string, string>;
}

export interface NormalizedAttachment {
  source: string;
  kind: "text" | "structured" | "archive" | "image" | "binary" | "directory";
  size: number;
  sha256?: string;
  summary: string;
  content?: string;
  entries?: string[];
  toolPath?: { source: "workspace" | "scratch"; path: string };
  truncated: boolean;
}

export interface NormalizedTask {
  task: string;
  attachments: NormalizedAttachment[];
  metadata: Record<string, string>;
}

export interface PlanStep {
  id: string;
  objective: string;
  successCriteria: string[];
  tools: string[];
}

export interface RunPlan {
  goal: string;
  assumptions: string[];
  hypotheses: string[];
  steps: PlanStep[];
}

export type HypothesisStatus = "open" | "supported" | "contradicted" | "confirmed";

export interface HypothesisRecord {
  id: string;
  statement: string;
  status: HypothesisStatus;
  evidence: string[];
  updatedAt: string;
}

export type FailureClassification = "tool" | "policy" | "evidence" | "assumption" | "scope" | "infrastructure";

export interface StrategyRevision {
  id: string;
  classification: FailureClassification;
  planChanges: string[];
  nextAction: string;
  rationale: string;
  createdAt: string;
}

export interface RunFailure {
  classification: "tool" | "policy";
  toolName: string;
  reason: string;
  createdAt: string;
}

export interface Finding {
  id: string;
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  confidence: number;
  description: string;
  evidence: string[];
  remediation?: string;
}

export type EvidenceLifecycleStatus = "created" | "attached" | "evaluated" | "used" | "invalidated" | "superseded";

export interface EvidenceRecord {
  id: string;
  summary: string;
  source: "task" | "tool" | "provider" | "benchmark" | "verifier" | "system";
  lifecycle: EvidenceLifecycleStatus;
  toolCallId?: string;
  observationIds: string[];
  hypothesisIds: string[];
  actionIds: string[];
  candidateIds: string[];
  verificationIds: string[];
  fingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExperienceLesson {
  id: string;
  title: string;
  applicableWhen: string[];
  strategy: string[];
  verification: string[];
  pitfalls: string[];
  tools: string[];
}

export interface RunReview {
  id: string;
  sequence: number;
  verdict: "correct" | "incorrect" | "uncertain";
  note: string;
  correction?: string;
  createdAt: string;
}

export interface RunLineage {
  parentRunId: string;
  boundarySequence: number;
  mode: "fork" | "resume";
  inheritedEventCount: number;
}

export interface RunState {
  id: string;
  status: RunStatus;
  phase: RunPhase;
  task: NormalizedTask;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  plan?: RunPlan;
  findings: Finding[];
  lessons: ExperienceLesson[];
  hypotheses: HypothesisRecord[];
  strategyRevisions: StrategyRevision[];
  strategyRevisionRequired: boolean;
  lastFailure?: RunFailure;
  sandboxNamespace: string;
  scratchRoot: string;
  workspaceMode: "configured" | "attachments-only";
  appliedExperienceIds: string[];
  submission?: string;
  verification?: string[];
  independentlyVerified?: boolean;
  summary?: string;
  stopReason?: string;
  turns: number;
  toolCalls: number;
  imageObservations: number;
  httpRequests: number;
  tcpSessions: number;
  actionsSinceCheckpoint: number;
  repeatedActions: Record<string, number>;
  evidence?: EvidenceRecord[];
  webAgent?: import("./agents/web/types.js").WebAgentState;
  webReasoning?: import("./web-reasoning/types.js").WebReasoningState;
  contextCuts?: ContextCut[];
  profile?: { id: string; executorId: string; executorKind: string; capabilities: string[]; tools: string[] };
  providerError?: ProviderError;
  lineage?: RunLineage;
}

export interface ContextCut {
  id: string;
  throughSeq: number;
  throughMessageCount: number;
  sourceEventCount: number;
  summary: string;
  createdAt: string;
}

export interface AuditRecord {
  sequence: number;
  timestamp: string;
  runId: string;
  type: string;
  source?: import("./session-trajectory.js").TrajectorySource;
  actor?: string;
  correlationId?: string;
  parentSequence?: number;
  data: unknown;
  previousHash: string;
  hash: string;
}

export interface RunEvent {
  type: string;
  runId: string;
  timestamp: string;
  data: unknown;
}

export interface OrderedRuntimeEvent {
  sessionId: string;
  runId: string;
  epoch: number;
  seq: number;
  type: string;
  timestamp: string;
  source?: import("./session-trajectory.js").TrajectorySource;
  actor?: string;
  correlationId?: string;
  parentSequence?: number;
  data: unknown;
}

export type ProviderErrorCode =
  | "rate_limit"
  | "quota"
  | "provider_config"
  | "request_rejected"
  | "network_policy"
  | "network"
  | "server"
  | "tool_denied"
  | "aborted"
  | "unknown";

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export interface RuntimeOverrides {
  streamFn?: StreamFn;
  model?: Model<string>;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  externalTools?: import("./external-tools.js").ExternalToolRegistration[];
  permissionGate?: import("./permissions.js").PermissionGate;
  memoryStore?: import("./memory.js").MemoryStore;
  executorFactory?: (input: { runId: string; workspaceRoot: string; scratchRoot: string; signal?: AbortSignal }) => Promise<import("./executor.js").Executor> | import("./executor.js").Executor;
}
