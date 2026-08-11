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

export interface SandboxConfig {
  socketPath: string;
  connectTimeoutMs: number;
}

export interface ScopeConfig {
  mode: ScopeMode;
  workspaceRoot: string;
  allowedHosts: string[];
  allowedPrograms: string[];
}

export interface ServerConfig {
  host: string;
  port: number;
  tokenEnv: string;
}

export interface ArenaConfig {
  enabled: boolean;
  baseUrl: string;
  tokenEnv: string;
  timeoutMs: number;
  maxResponseBytes: number;
  allowedCategories?: string[];
  maxCategorySkips?: number;
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
  arena?: ArenaConfig;
  questionBank?: QuestionBankConfig;
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
}

export interface AuditRecord {
  sequence: number;
  timestamp: string;
  runId: string;
  type: string;
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

export interface RuntimeOverrides {
  streamFn?: StreamFn;
  model?: Model<string>;
  onEvent?: (event: RunEvent) => void | Promise<void>;
}
