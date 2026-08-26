import type { RunState, StrategyRevisionRecord, WebHypothesisRecord } from "../../types/api";

export interface ObservatoryEvent {
  sequence: number;
  timestamp: string;
  type: string;
  correlationId?: string;
  parentSequence?: number;
  data: unknown;
}

export interface DecisionLoopView {
  key: string;
  label: string;
  active: boolean;
  complete: boolean;
}

export interface RecommendedActionView {
  objective: string;
  rationale: string;
  kind?: string;
  tool?: string;
  hypothesisId?: string;
  expectedSignal?: string;
  failureSignal?: string;
  priority?: number;
  estimatedCost?: number;
}

export interface EvaluationView {
  decision: string;
  rationale: string;
  newEvidence: number;
  progressScore: number;
  confidenceDelta: number;
  stagnationDetected: boolean;
}

export interface ActionTransactionView {
  id: string;
  sequence: number;
  toolName: string;
  requested?: ObservatoryEvent;
  policy?: ObservatoryEvent;
  permissionRequest?: ObservatoryEvent;
  permissionResolved?: ObservatoryEvent;
  result?: ObservatoryEvent;
  status: "pending" | "allowed" | "blocked" | "success" | "error";
  evidenceIds: string[];
  durationMs?: number;
}

export interface SafetyEnvelopeView {
  mode?: string;
  hosts: string[];
  workspace?: string;
  programs: string[];
  budgets: Record<string, number>;
  currentTool?: string;
  currentPolicy?: "allowed" | "blocked" | "unknown";
  reason?: string;
}

export interface ContextLensView {
  messageCount?: number;
  omittedMessageCount?: number;
  toolCount?: number;
  digest?: string;
  requestId?: string;
  injectedSections: string[];
  compacted?: { sequence: number; summary?: string; sourceEventCount?: number };
  diff: { fromSequence?: number; toSequence?: number; added: string[]; removed: string[]; compacted: boolean };
}

export interface ReflectionView {
  knownFacts: string[];
  unsupportedAssumptions: string[];
  failedApproaches: string[];
  unresolvedQuestions: string[];
  missingEvidence: string[];
  nextObjective?: string;
}

export interface BrowserReplayView {
  available: boolean;
  capability?: string;
  sessions: Array<{ id: string; status: string; currentUrl?: string; actionCount: number; networkEventCount: number }>;
  pages: Array<{ id: string; url?: string; title?: string }>;
  snapshots: Array<{ id: string; url: string; documentHash: string; elementCount: number; createdAt: string }>;
  transitions: Array<{ id: string; actionId: string; beforeSnapshotId?: string; afterSnapshotId?: string; domChanged: boolean; visibleTextChanged: boolean; formStateChanged: boolean; significance: string; createdAt: string }>;
  network: Array<{ id: string; kind: string; method?: string; url: string; status?: number; timestamp: string }>;
}

export interface ObservatoryProjection {
  loop: DecisionLoopView[];
  recommendedAction?: RecommendedActionView;
  evaluation?: EvaluationView;
  stagnation: { noEvidence: number; duplicateActions: number; toolFailures: number; detected: boolean; reason?: string };
  recoveryRequired: boolean;
  latestRevision?: StrategyRevisionRecord;
  resolvedFailure?: Record<string, unknown>;
  hypotheses: Array<{ id: string; title: string; statement: string; status: string; confidence?: number; supporting: string[]; contradicting: string[]; attempted: string[] }>;
  transactions: ActionTransactionView[];
  safety: SafetyEnvelopeView;
  context: ContextLensView;
  reflection?: ReflectionView;
  webPhase?: string;
  webPhaseHistory: Array<{ phase: string; enteredAt: string; completedAt?: string; reason: string }>;
  activeRole?: string;
  browser?: BrowserReplayView;
}

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const asString = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const asStrings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const asNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function eventData(event?: ObservatoryEvent): Record<string, unknown> {
  return asRecord(event?.data);
}

function actionKey(event: ObservatoryEvent): string | undefined {
  const data = eventData(event);
  return event.correlationId ?? asString(data.toolCallId) ?? asString(data.actionId);
}

export function projectDecisionLoop(state: RunState | undefined): DecisionLoopView[] {
  const phases = ["observe", "hypothesize", "plan", "act", "evaluate", "reflect", "verify"];
  const webPhase = state?.webReasoning?.phase;
  const phaseMap: Record<string, string> = {
    initializing: "observe", observing: "observe", hypothesizing: "hypothesize", planning: "plan", acting: "act",
    evaluating: "evaluate", reflecting: "reflect", verifying: "verify", completing: "verify", completed: "verify", blocked: "verify",
  };
  const active = phaseMap[webPhase ?? ""] ?? (state?.phase === "planning" ? "plan" : state?.phase === "verification" ? "verify" : state?.phase === "analysis" ? "evaluate" : "act");
  const activeIndex = phases.indexOf(active);
  return phases.map((key, index) => ({ key, label: key.toUpperCase(), active: key === active, complete: activeIndex >= 0 && index < activeIndex }));
}

export function projectActionTransactions(events: ObservatoryEvent[], state?: RunState): ActionTransactionView[] {
  const groups = new Map<string, ActionTransactionView>();
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  for (const event of ordered) {
    if (!["tool.requested", "policy.decision", "permission.request", "permission.resolved", "tool.result"].includes(event.type)) continue;
    const data = eventData(event);
    const key = actionKey(event) ?? `${event.type}:${event.sequence}`;
    const existing = groups.get(key);
    const toolName = asString(data.toolName) ?? existing?.toolName ?? "unknown";
    const transaction = existing ?? { id: key, sequence: event.sequence, toolName, status: "pending" as const, evidenceIds: [] };
    transaction.sequence = Math.min(transaction.sequence, event.sequence);
    transaction.toolName = toolName;
    if (event.type === "tool.requested") transaction.requested = event;
    if (event.type === "policy.decision") transaction.policy = event;
    if (event.type === "permission.request") transaction.permissionRequest = event;
    if (event.type === "permission.resolved") transaction.permissionResolved = event;
    if (event.type === "tool.result") transaction.result = event;
    const resultData = eventData(transaction.result);
    const policyData = eventData(transaction.policy);
    transaction.evidenceIds = [...new Set([...transaction.evidenceIds, ...asStrings(data.evidenceIds), ...asStrings(resultData.evidenceIds)])];
    if (transaction.result) transaction.status = resultData.isError === true ? "error" : "success";
    else if (policyData.allowed === false) transaction.status = "blocked";
    else if (policyData.allowed === true) transaction.status = "allowed";
    const start = transaction.requested?.timestamp ? Date.parse(transaction.requested.timestamp) : undefined;
    const end = transaction.result?.timestamp ? Date.parse(transaction.result.timestamp) : undefined;
    if (start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end)) transaction.durationMs = Math.max(0, end - start);
    groups.set(key, transaction);
  }
  const evidence = state?.evidence ?? [];
  for (const transaction of groups.values()) {
    for (const item of evidence) if (item.toolCallId === transaction.id) transaction.evidenceIds = [...new Set([...transaction.evidenceIds, item.id])];
  }
  return [...groups.values()].sort((left, right) => left.sequence - right.sequence).slice(-80);
}

export function projectSafetyEnvelope(events: ObservatoryEvent[], state?: RunState): SafetyEnvelopeView {
  const started = events.find((event) => event.type === "run.started");
  const startedData = eventData(started);
  const scope = asRecord(startedData.scope);
  const budgets = asRecord(startedData.budgets);
  const policies = events.filter((event) => event.type === "policy.decision");
  const latest = policies.at(-1);
  const latestData = eventData(latest);
  return {
    mode: asString(scope.mode),
    hosts: asStrings(scope.allowedHosts),
    workspace: asString(scope.workspaceRoot) ?? state?.workspaceMode,
    programs: asStrings(scope.allowedPrograms),
    budgets: Object.fromEntries(Object.entries(budgets).filter(([, value]) => typeof value === "number" && Number.isFinite(value))) as Record<string, number>,
    currentTool: asString(latestData.toolName),
    currentPolicy: latestData.allowed === true ? "allowed" : latestData.allowed === false ? "blocked" : "unknown",
    reason: asString(latestData.reason),
  };
}

export function projectObservatory(state: RunState | undefined, events: ObservatoryEvent[]): ObservatoryProjection {
  const web = state?.webReasoning;
  const proposal = web?.nextRecommendedAction;
  const evaluation = web?.evaluations?.at(-1);
  const reflection = web?.reflections?.at(-1);
  const latestRevision = state?.strategyRevisions?.at(-1);
  const revisionEvent = [...events].reverse().find((event) => event.type === "strategy.revised");
  const revisionData = eventData(revisionEvent);
  const reflectionView = reflection ? {
    knownFacts: reflection.knownFacts,
    unsupportedAssumptions: reflection.unsupportedAssumptions,
    failedApproaches: reflection.failedApproaches,
    unresolvedQuestions: reflection.unresolvedQuestions,
    missingEvidence: reflection.missingEvidence,
    nextObjective: reflection.recommendedNextObjective,
  } : undefined;
  const hypotheses = (web?.hypotheses?.length ? web.hypotheses : state?.hypotheses ?? []).map((item) => {
    const webItem = item as WebHypothesisRecord;
    const generic = item as unknown as { id: string; statement: string; status: string; evidence?: string[] };
    return { id: webItem.id, title: webItem.title ?? generic.statement, statement: webItem.statement ?? generic.statement, status: webItem.status, confidence: webItem.confidence, supporting: webItem.supportingEvidenceIds ?? generic.evidence ?? [], contradicting: webItem.contradictingEvidenceIds ?? [], attempted: webItem.attemptedActionIds ?? [] };
  });
  return {
    loop: projectDecisionLoop(state),
    ...(proposal ? { recommendedAction: { objective: proposal.objective, rationale: proposal.rationaleSummary, kind: proposal.kind, tool: proposal.requestedTool, hypothesisId: proposal.hypothesisId, expectedSignal: proposal.expectedSignal, failureSignal: proposal.failureSignal, priority: proposal.priority, estimatedCost: proposal.estimatedCost } } : {}),
    ...(evaluation ? { evaluation: { decision: evaluation.decision, rationale: evaluation.rationaleSummary, newEvidence: evaluation.newEvidenceIds.length, progressScore: evaluation.progressScore, confidenceDelta: evaluation.confidenceDelta, stagnationDetected: evaluation.stagnationDetected } } : {}),
    stagnation: { noEvidence: web?.stagnation?.consecutiveNoEvidenceRounds ?? 0, duplicateActions: web?.stagnation?.consecutiveDuplicateActions ?? 0, toolFailures: web?.stagnation?.consecutiveToolFailures ?? 0, detected: web?.stagnation?.detected ?? false, reason: web?.stagnation?.reason },
    recoveryRequired: state?.strategyRevisionRequired === true,
    ...(latestRevision ? { latestRevision } : {}),
    ...(asRecord(revisionData.resolvedFailure).toolName ? { resolvedFailure: asRecord(revisionData.resolvedFailure) } : {}),
    hypotheses,
    transactions: projectActionTransactions(events, state),
    safety: projectSafetyEnvelope(events, state),
    context: projectContextLens(events),
    ...(reflectionView ? { reflection: reflectionView } : {}),
    webPhase: state?.webAgent?.phase,
    webPhaseHistory: state?.webAgent?.history ?? [],
    activeRole: web?.roleCoordination?.activeRole ?? state?.webAgent?.activeRole,
    ...(web?.browser ? { browser: projectBrowserReplay(web.browser) } : {}),
  };
}

export function projectBrowserReplay(browser: NonNullable<NonNullable<RunState["webReasoning"]>["browser"]>): BrowserReplayView {
  return {
    available: browser.capability.available,
    capability: browser.capability.reason ?? (browser.capability.available ? `${browser.capability.provider}/${browser.capability.browserType}` : undefined),
    sessions: browser.sessions.map((session) => ({ id: session.id, status: session.status, currentUrl: session.currentUrl, actionCount: session.actionCount, networkEventCount: session.networkEventCount })),
    pages: browser.pages.map((page) => ({ id: page.id, url: page.url, title: page.title })),
    snapshots: browser.domSnapshots.map((snapshot) => ({ id: snapshot.id, url: snapshot.url, documentHash: snapshot.documentHash, elementCount: snapshot.elementCount, createdAt: snapshot.createdAt })),
    transitions: browser.stateTransitions.map((transition) => ({ id: transition.id, actionId: transition.actionId, beforeSnapshotId: transition.beforeSnapshotId, afterSnapshotId: transition.afterSnapshotId, domChanged: transition.domChanged, visibleTextChanged: transition.visibleTextChanged, formStateChanged: transition.formStateChanged, significance: transition.significance, createdAt: transition.createdAt })),
    network: browser.networkEventSummaries.slice(-80).map((event) => ({ id: event.id, kind: event.kind, method: event.method, url: event.url, status: event.status, timestamp: event.timestamp })),
  };
}

export function projectContextLens(events: ObservatoryEvent[]): ContextLensView {
  const contexts = events.filter((event) => event.type === "model.context");
  const latest = contexts.at(-1);
  const data = eventData(latest);
  const previous = contexts.at(-2);
  const previousData = eventData(previous);
  const injectedSections = events.filter((event) => event.type === "context.injected").flatMap((event) => asRecord(event.data).sections).flatMap((section) => {
    const item = asRecord(section);
    return [asString(item.title) ?? asString(item.kind) ?? asString(item.name)].filter((value): value is string => Boolean(value));
  }).slice(-12);
  const compacted = [...events].reverse().find((event) => event.type === "context.compacted");
  const compactedData = eventData(compacted);
  const added: string[] = [];
  const removed: string[] = [];
  if (latest && previous) {
    if (asNumber(data.messageCount) !== asNumber(previousData.messageCount)) added.push(`Messages ${asNumber(previousData.messageCount) ?? "—"} → ${asNumber(data.messageCount) ?? "—"}`);
    if (asNumber(data.toolCount) !== asNumber(previousData.toolCount)) added.push(`Tools ${asNumber(previousData.toolCount) ?? "—"} → ${asNumber(data.toolCount) ?? "—"}`);
    if (asString(data.digest) && asString(data.digest) !== asString(previousData.digest)) added.push("Context digest changed");
  }
  if (injectedSections.length > 0 && latest) added.push(...injectedSections.slice(-4).map((section) => `Injected ${section}`));
  const compactionEvent = compacted ? "Context compaction recorded" : undefined;
  if (compactionEvent) added.push(compactionEvent);
  return {
    messageCount: asNumber(data.messageCount), omittedMessageCount: asNumber(data.omittedMessageCount), toolCount: asNumber(data.toolCount), digest: asString(data.digest), requestId: asString(data.requestId), injectedSections,
    ...(compacted ? { compacted: { sequence: compacted.sequence, summary: asString(compactedData.summary), sourceEventCount: asNumber(compactedData.sourceEventCount) } } : {}),
    diff: { ...(previous ? { fromSequence: previous.sequence } : {}), ...(latest ? { toSequence: latest.sequence } : {}), added, removed, compacted: Boolean(compacted) },
  };
}
