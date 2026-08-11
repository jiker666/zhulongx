import { createHash, randomUUID } from "node:crypto";
import type { NormalizedTask, WebReasoningConfig } from "../types.js";
import type { WebReasoningState, WebTaskClassification } from "./types.js";

export const WEB_REASONING_SCHEMA_VERSION = 1;
export const WEB_GRAPH_SCHEMA_VERSION = 1;

export const defaultWebReasoningConfig: WebReasoningConfig = {
  enabled: true, autoDetectWebTasks: true, persistState: true, enableHypothesisManagement: true,
  enableReflection: true, enableActionDeduplication: true, noEvidenceRoundLimit: 3,
  duplicateActionLimit: 2, toolFailureLimit: 3, finalizationRoundReserve: 2,
  maxObservations: 80, maxHypotheses: 40, maxActions: 80, maxReflections: 12,
};

export function webConfig(config?: WebReasoningConfig): WebReasoningConfig {
  return { ...defaultWebReasoningConfig, ...(config ?? {}) };
}

export function createInitialWebReasoningState(
  classification: WebTaskClassification,
  remainingRounds: number,
  now = new Date().toISOString(),
): WebReasoningState {
  return {
    schemaVersion: WEB_REASONING_SCHEMA_VERSION, enabled: classification.isWeb, phase: "initializing",
    taskClassification: classification, observations: [], hypotheses: [], plans: [], actions: [], evaluations: [],
    reflections: [], activeHypothesisIds: [], unresolvedHypothesisIds: [], rejectedHypothesisIds: [], confirmedHypothesisIds: [],
    stagnation: { consecutiveNoEvidenceRounds: 0, consecutiveDuplicateActions: 0, consecutiveToolFailures: 0, detected: false },
    budget: { remainingRounds: Math.max(0, remainingRounds), finalizationReserve: 2, actionsUsed: 0 },
    createdAt: now, updatedAt: now,
    knowledgeGraph: {
      schemaVersion: WEB_GRAPH_SCHEMA_VERSION, nodes: [], edges: [], indexes: { nodeByKey: {}, edgesByFrom: {}, edgesByTo: {} },
      statistics: { nodeCount: 0, edgeCount: 0, duplicateNodeMerges: 0, duplicateEdgeMerges: 0, integrityWarnings: 0, projectionCount: 0 }, createdAt: now, updatedAt: now,
    },
    roleCoordination: { schemaVersion: 1, activeRole: "coordinator", objectiveQueue: [], completedObjectiveIds: [], blockedObjectiveIds: [], results: [], roleSwitchCount: 0, noProgressCount: 0, updatedAt: now },
    browser: { schemaVersion: 1, capability: { available: false, provider: "playwright", browserType: "chromium", reason: "Capability not checked" }, sessions: [], pages: [], domSnapshots: [], stateTransitions: [], networkEventSummaries: [], analyzedDomHashes: [], capturedResponseIds: [] },
    webIntelligence: { schemaVersion: 1, analyzedScriptHashes: [], javascriptAnalysisSummaries: [], responseSnapshots: [], responseDiffResults: [] },
  };
}

function bounded<T>(items: T[], max: number): T[] { return items.length <= max ? items : items.slice(items.length - max); }

export function normalizeWebReasoningState(input: unknown, fallback: WebReasoningState): WebReasoningState {
  if (!input || typeof input !== "object") return fallback;
  const source = input as Partial<WebReasoningState>;
  if (typeof source.schemaVersion !== "number" || source.schemaVersion > WEB_REASONING_SCHEMA_VERSION || source.schemaVersion < 0 || source.enabled !== true || !source.taskClassification) return fallback;
  const state: WebReasoningState = {
    ...fallback, ...source, schemaVersion: WEB_REASONING_SCHEMA_VERSION,
    observations: Array.isArray(source.observations) ? source.observations : [],
    hypotheses: Array.isArray(source.hypotheses) ? source.hypotheses : [],
    plans: Array.isArray(source.plans) ? source.plans : [], actions: Array.isArray(source.actions) ? source.actions : [],
    evaluations: Array.isArray(source.evaluations) ? source.evaluations : [], reflections: Array.isArray(source.reflections) ? source.reflections : [],
    activeHypothesisIds: Array.isArray(source.activeHypothesisIds) ? [...new Set(source.activeHypothesisIds)] : [],
    unresolvedHypothesisIds: Array.isArray(source.unresolvedHypothesisIds) ? [...new Set(source.unresolvedHypothesisIds)] : [],
    rejectedHypothesisIds: Array.isArray(source.rejectedHypothesisIds) ? [...new Set(source.rejectedHypothesisIds)] : [],
    confirmedHypothesisIds: Array.isArray(source.confirmedHypothesisIds) ? [...new Set(source.confirmedHypothesisIds)] : [],
    stagnation: source.stagnation && typeof source.stagnation === "object" ? { ...fallback.stagnation, ...source.stagnation } : fallback.stagnation,
    budget: source.budget && typeof source.budget === "object" ? { ...fallback.budget, ...source.budget } : fallback.budget,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : fallback.updatedAt,
  };
  if (source.knowledgeGraph && typeof source.knowledgeGraph === "object" && Array.isArray(source.knowledgeGraph.nodes) && Array.isArray(source.knowledgeGraph.edges) && source.knowledgeGraph.indexes && source.knowledgeGraph.statistics) state.knowledgeGraph = source.knowledgeGraph;
  if (source.roleCoordination && typeof source.roleCoordination === "object" && Array.isArray(source.roleCoordination.objectiveQueue) && Array.isArray(source.roleCoordination.results)) state.roleCoordination = source.roleCoordination;
  if (source.webIntelligence && typeof source.webIntelligence === "object") state.webIntelligence = source.webIntelligence;
  if (source.browser && typeof source.browser === "object" && Array.isArray(source.browser.sessions) && Array.isArray(source.browser.pages)) state.browser = source.browser;
  state.observations = bounded(state.observations, 80);
  state.hypotheses = bounded(state.hypotheses, 40);
  state.actions = bounded(state.actions, 80);
  state.reflections = bounded(state.reflections, 12);
  return state;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

export function newId(prefix: string): string { return `${prefix}_${randomUUID()}`; }

export function taskClassificationForState(task: NormalizedTask, classification: WebTaskClassification): WebTaskClassification {
  return { ...classification, reasons: classification.reasons.map((reason) => ({ ...reason, detail: reason.detail.slice(0, 240) })) };
}
