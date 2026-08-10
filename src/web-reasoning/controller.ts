import { createHash } from "node:crypto";
import { sanitizeSecrets } from "../sanitize.js";
import type { AuditChain } from "../audit.js";
import type { EvidenceRecord, HypothesisRecord, RunState, WebReasoningConfig } from "../types.js";
import { createWebAgentState } from "../agents/web/web-state-machine.js";
import { renderWebOrchestrationContext } from "../agents/web/web-orchestrator.js";
import { ActionDeduplicator } from "./action-deduplicator.js";
import { WebActionGuard } from "./action-guard.js";
import { evaluateProgress } from "./evaluator.js";
import { HypothesisManager } from "./hypothesis-manager.js";
import { ObservationManager } from "./observation-manager.js";
import { planNext } from "./planner.js";
import { createReflection } from "./reflection-manager.js";
import { createInitialWebReasoningState, defaultWebReasoningConfig, newId, normalizeWebReasoningState, webConfig } from "./state.js";
import { detectWebTask } from "./task-detector.js";
import { WebKnowledgeGraph } from "./graph/graph.js";
import { WebGraphProjector } from "./graph/projector.js";
import { WebGraphQuery } from "./graph/query.js";
import { checkAndRepairGraph } from "./graph/integrity.js";
import { WebRoleCoordinator } from "./role-coordinator.js";
import { StaticJavaScriptAnalyzer } from "./javascript/adapter.js";
import { createJavaScriptInput, isJavaScriptLike } from "./javascript/intake.js";
import { projectJavaScriptResult } from "./javascript/projector.js";
import type { JavaScriptAnalysisSummary } from "./javascript/types.js";
import { createResponseSnapshot, compareResponseSnapshots } from "./response-diff.js";
import { projectBrowserState } from "./browser/state-projector.js";
import { candidateIdForSubmission, driveWebPhase, suggestNextWebPhase } from "./phase-driver.js";
import type { WebHypothesis, WebReasoningAction, WebReasoningState, WebTaskClassification } from "./types.js";

function ledgerStatusForWeb(status: WebHypothesis["status"]): HypothesisRecord["status"] {
  switch (status) {
    case "confirmed": return "confirmed";
    case "supported": return "supported";
    case "rejected":
    case "expired": return "contradicted";
    default: return "open";
  }
}

export class WebReasoningController {
  readonly config: WebReasoningConfig;
  private state: WebReasoningState;
  private readonly observations: ObservationManager;
  private readonly hypotheses: HypothesisManager;
  private readonly deduplicator: ActionDeduplicator;
  private readonly guard = new WebActionGuard();
  private readonly graph: WebKnowledgeGraph;
  private readonly projector: WebGraphProjector;
  private readonly graphQuery: WebGraphQuery;
  private readonly roles: WebRoleCoordinator;
  private readonly javascriptAnalyzer = new StaticJavaScriptAnalyzer();
  private readonly restored: boolean;
  constructor(private readonly run: RunState, private readonly audit: AuditChain, config?: WebReasoningConfig) {
    this.config = webConfig(config ?? defaultWebReasoningConfig);
    const classification = detectWebTask(run.task);
    this.restored = Boolean(run.webReasoning);
    this.state = run.webReasoning ? normalizeWebReasoningState(run.webReasoning, createInitialWebReasoningState(classification, this.config.finalizationRoundReserve)) : createInitialWebReasoningState(classification, this.config.finalizationRoundReserve);
    if (!classification.isWeb || !this.config.enabled || (!this.config.autoDetectWebTasks && !/^web$/i.test(run.task.metadata.category ?? ""))) this.state.enabled = false;
    if (classification.isWeb && this.config.enabled) run.webReasoning = this.state;
    // Seed the persistent Web phase machine so later renders/drives see a real phase
    // instead of a fresh INIT every time.
    if (this.state.enabled) run.webAgent ??= createWebAgentState();
    this.observations = new ObservationManager(this.state, this.config.maxObservations);
    this.hypotheses = new HypothesisManager(this.state, this.config.maxHypotheses);
    this.deduplicator = new ActionDeduplicator(this.state);
    const graphState = this.state.knowledgeGraph ?? createInitialWebReasoningState(classification, 0).knowledgeGraph!;
    this.state.knowledgeGraph = graphState;
    this.graph = new WebKnowledgeGraph(graphState);
    this.graphQuery = new WebGraphQuery(graphState);
    this.projector = new WebGraphProjector(this.state, this.graph);
    this.roles = new WebRoleCoordinator(this.state, this.graphQuery);
  }
  get classification(): WebTaskClassification { return this.state.taskClassification; }
  get enabled(): boolean { return this.state.enabled && this.config.enabled; }
  guardToolCall(toolName: string, args: unknown, availableTools: readonly string[]): { allowed: boolean; reason: string; decision: string } {
    if (!this.enabled) return { allowed: true, reason: "Web reasoning is not active", decision: "allow" };
    const result = this.guard.validate(this.state.nextRecommendedAction, { toolName, args }, this.state, availableTools);
    return { allowed: !result.decision.startsWith("reject_"), reason: result.reason, decision: result.decision };
  }
  async initialize(): Promise<void> { if (!this.enabled) return; this.state.phase = "observing"; this.state.updatedAt = new Date().toISOString(); await driveWebPhase(this.run, this.state, this.audit); for (const url of this.run.task.task.match(/https?:\/\/[^\s)]+/gi) ?? []) { try { const observation = this.observations.add({ type: "url", summary: "Authorized task URL", source: "task", evidenceIds: [], confidence: 1, normalizedKey: url }); const target = this.graph.upsertNode({ type: "target", key: new URL(url).origin, label: "Authorized target", confidence: 1 }); const urlNode = this.graph.upsertNode({ type: "url", key: url, label: url, observationIds: [observation.id], confidence: 1 }); this.graph.upsertEdge({ type: "contains", fromNodeId: target.id, toNodeId: urlNode.id, confidence: 1 }); } catch { await this.event("WEB_GRAPH_INTEGRITY_WARNING", { reason: "Task URL could not be normalized" }); } } const integrity = checkAndRepairGraph(this.graph.state, this.state, this.run.evidence ?? []); await this.event("WEB_TASK_DETECTED", { classification: this.state.taskClassification }); await this.event(this.restored ? "WEB_REASONING_STATE_RESTORED" : "WEB_REASONING_INITIALIZED", { schemaVersion: this.state.schemaVersion }); await this.event(this.restored ? "WEB_GRAPH_RESTORED" : "WEB_GRAPH_INITIALIZED", { nodeCount: this.graph.state.nodes.length, edgeCount: this.graph.state.edges.length }); if (integrity.warnings.length > 0) await this.event("WEB_GRAPH_INTEGRITY_WARNING", { warnings: integrity.warnings.slice(0, 8) }); }
  async beforeTurn(remainingRounds: number, remainingToolBudget: number, availableTools: string[]): Promise<string> {
    if (!this.enabled) return "";
    this.state.budget.remainingRounds = remainingRounds; this.state.budget.actionsUsed = this.state.actions.length;
    const proposal = planNext({ state: this.state, availableTools, remainingRounds, remainingToolBudget, run: this.run, graphQuery: this.graphQuery });
    this.state.nextRecommendedAction = proposal; this.state.phase = proposal.kind === "complete" ? "completing" : "planning";
    await this.event("WEB_PLAN_CREATED", { proposal: { ...proposal, requestedArguments: sanitizeSecrets(proposal.requestedArguments) } });
    const objective = this.roles.assign(remainingRounds);
    await this.event("WEB_ROLE_OBJECTIVE_CREATED", { objectiveId: objective.id, role: objective.role, objective: objective.objective });
    await this.event("WEB_ROLE_ASSIGNED", { objectiveId: objective.id, role: objective.role });
    await this.event("WEB_ROLE_STARTED", { objectiveId: objective.id, role: objective.role });
    const nextPhase = suggestNextWebPhase(this.state, this.run)?.target;
    const orchestrationContext = renderWebOrchestrationContext({ task: this.run.task, run: this.run }, nextPhase);
    return `${orchestrationContext}\n${this.renderContext(remainingRounds)}\n${this.roles.renderObjective(objective)}`;
  }
  async afterToolResult(input: { toolName: string; toolCallId: string; args: unknown; result: unknown; isError: boolean }): Promise<void> {
    if (!this.enabled) return;
    const summary = this.summarize(input.result); const action = this.state.actions.find((item) => item.toolCallId === input.toolCallId); if (action) { action.status = input.isError ? "failed" : "succeeded"; action.completedAt = new Date().toISOString(); }
    const evidence: EvidenceRecord = { id: newId("ev"), summary, source: "tool", lifecycle: "created", toolCallId: input.toolCallId, observationIds: [], hypothesisIds: [], actionIds: action ? [action.id] : [], candidateIds: [], verificationIds: [], fingerprint: createHash("sha256").update(summary).digest("hex").slice(0, 24), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.run.evidence ??= []; const duplicate = this.run.evidence.find((item) => item.fingerprint === evidence.fingerprint); if (duplicate) return;
    this.run.evidence.push(evidence); this.run.evidence = this.run.evidence.slice(-this.config.maxObservations);
    if (input.toolName === "finish_task" && input.args && typeof input.args === "object" && typeof (input.args as Record<string, unknown>).submission === "string") {
      const candidateId = candidateIdForSubmission((input.args as Record<string, unknown>).submission);
      evidence.candidateIds.push(candidateId);
      if ((input.args as Record<string, unknown>).independentlyVerified === true) evidence.verificationIds.push(`verification_${input.toolCallId}`);
      this.projector.projectCandidate(candidateId, [evidence.id]);
    }
    const observation = this.observations.add({ type: input.isError ? "error_signal" : "tool_result", summary, source: "tool", evidenceIds: [evidence.id], toolCallId: input.toolCallId, confidence: input.isError ? 0.8 : 0.9, normalizedKey: `${input.toolName}:${evidence.fingerprint}` });
    evidence.observationIds.push(observation.id); evidence.lifecycle = "attached";
    this.projector.projectObservation(observation, evidence);
    await this.processStaticIntelligence(input, evidence);
    await this.processBrowserIntelligence(input, evidence);
    const evaluation = evaluateProgress(this.state, { newEvidenceIds: [evidence.id], isError: input.isError }); evidence.lifecycle = "evaluated";
    await this.event("WEB_OBSERVATION_CREATED", { observationId: observation.id, evidenceId: evidence.id });
    if (this.config.enableReflection) { const reflection = createReflection(this.state); await this.event("WEB_REFLECTION_CREATED", { reflectionId: reflection.id }); }
    await this.event("WEB_EVIDENCE_ATTACHED", { evidenceId: evidence.id, observationId: observation.id, toolName: input.toolName });
    await this.event("WEB_EVALUATION_COMPLETED", { evaluationId: evaluation.id, decision: evaluation.decision, progressScore: evaluation.progressScore });
    await driveWebPhase(this.run, this.state, this.audit);
    this.syncRunHypothesisLedger();
  }
  private async processStaticIntelligence(input: { toolName: string; toolCallId: string; args: unknown; result: unknown; isError: boolean }, evidence: EvidenceRecord): Promise<void> {
    if (input.isError) return;
    const args = input.args && typeof input.args === "object" ? input.args as Record<string, unknown> : {};
    const result = input.result && typeof input.result === "object" ? input.result as Record<string, unknown> : {};
    const content = typeof result.content === "string" ? result.content : typeof result.details === "string" ? result.details : "";
    const path = typeof args.path === "string" ? args.path : "";
    if ((input.toolName === "inspect_artifact" || input.toolName === "read_scratch_file") && content && isJavaScriptLike("", path)) {
      const analysisInput = createJavaScriptInput({ id: `${input.toolCallId}:${path}`, source: "artifact", content, sourceUrl: path, artifactId: path, evidenceIds: [evidence.id], maxBytes: 128 * 1024 });
      if (this.state.webIntelligence?.analyzedScriptHashes.includes(analysisInput.contentHash)) { await this.event("JAVASCRIPT_ANALYSIS_SKIPPED_DUPLICATE", { contentHash: analysisInput.contentHash }); return; }
      await this.event("JAVASCRIPT_ANALYSIS_STARTED", { inputId: analysisInput.id, contentHash: analysisInput.contentHash });
      const analysis = await this.javascriptAnalyzer.analyze(analysisInput);
      const jsEvidence: EvidenceRecord = { id: newId("ev-js"), summary: `Static JavaScript analysis: ${analysis.networkCalls.length} network calls, ${analysis.routes.length} routes, ${analysis.storageFindings.length} storage findings`, source: "tool", lifecycle: "created", observationIds: [], hypothesisIds: [], actionIds: [], candidateIds: [], verificationIds: [], fingerprint: analysisInput.contentHash, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.run.evidence ??= []; this.run.evidence.push(jsEvidence); this.run.evidence = this.run.evidence.slice(-this.config.maxObservations); const jsObservation = this.observations.add({ type: "artifact", summary: jsEvidence.summary, source: "tool", evidenceIds: [jsEvidence.id], confidence: analysis.status === "completed" ? 0.9 : 0.5, normalizedKey: `javascript:${analysisInput.contentHash}` }); jsEvidence.observationIds.push(jsObservation.id); jsEvidence.lifecycle = "attached"; const projection = projectJavaScriptResult(analysis, this.graph, jsEvidence); this.state.webIntelligence ??= { schemaVersion: 1, analyzedScriptHashes: [], javascriptAnalysisSummaries: [], responseSnapshots: [], responseDiffResults: [] }; this.state.webIntelligence.analyzedScriptHashes = [...new Set([...this.state.webIntelligence.analyzedScriptHashes, analysisInput.contentHash])].slice(-80); const summary: JavaScriptAnalysisSummary = { analysisId: analysis.analysisId, inputId: analysis.inputId, contentHash: analysisInput.contentHash, status: analysis.status, language: analysis.language, moduleKind: analysis.moduleKind, networkCallCount: analysis.networkCalls.length, routeCount: analysis.routes.length, storageFindingCount: analysis.storageFindings.length, sourceMapFindingCount: analysis.sourceMapFindings.length, createdEvidenceIds: [jsEvidence.id] }; this.state.webIntelligence.javascriptAnalysisSummaries = [...this.state.webIntelligence.javascriptAnalysisSummaries, summary].slice(-40); await this.event(analysis.status === "completed" ? "JAVASCRIPT_ANALYSIS_COMPLETED" : "JAVASCRIPT_ANALYSIS_PARTIAL", { analysisId: analysis.analysisId, evidenceId: jsEvidence.id, nodeCount: projection.nodeIds.length, edgeCount: projection.edgeIds.length });
    }
    if (input.toolName === "web_compare_responses" && typeof args.baseline === "string" && typeof args.candidate === "string") {
      const baseline = createResponseSnapshot({ source: "tool", headers: {}, bodyPreview: args.baseline }); const candidate = createResponseSnapshot({ source: "tool", headers: {}, bodyPreview: args.candidate }); const diff = compareResponseSnapshots(baseline, candidate, { evidenceIds: [evidence.id] }); this.state.webIntelligence ??= { schemaVersion: 1, analyzedScriptHashes: [], javascriptAnalysisSummaries: [], responseSnapshots: [], responseDiffResults: [] }; this.state.webIntelligence.responseSnapshots = [...this.state.webIntelligence.responseSnapshots, baseline, candidate].slice(-80); this.state.webIntelligence.responseDiffResults = [...this.state.webIntelligence.responseDiffResults, diff].slice(-40); await this.event("RESPONSE_SNAPSHOT_CREATED", { snapshotIds: [baseline.id, candidate.id] }); await this.event("RESPONSE_DIFF_COMPLETED", { diffId: diff.id, stable: diff.stable, signalCount: diff.signals.length });
    }
    if (input.toolName === "web_compare_responses" && this.state.webIntelligence?.responseDiffResults.length) {
      const diff = this.state.webIntelligence.responseDiffResults.at(-1);
      const snapshots = this.state.webIntelligence.responseSnapshots.slice(-2);
      if (diff && snapshots.length === 2) {
        const observation = this.observations.add({ type: "response", summary: `Response comparison produced ${diff.signals.length} semantic signal(s); stable=${diff.stable}.`, source: "tool", evidenceIds: [evidence.id], confidence: diff.stable ? 0.85 : 0.55, normalizedKey: `response-diff:${diff.id}` });
        evidence.observationIds.push(observation.id);
        const baseline = this.graph.upsertNode({ type: "response", key: snapshots[0]!.id, label: "Baseline response", attributes: { bodyHash: snapshots[0]!.bodyHash ?? "[hash-only]", status: snapshots[0]!.status ?? null }, evidenceIds: [evidence.id], observationIds: [observation.id], confidence: 0.9 });
        const candidate = this.graph.upsertNode({ type: "response", key: snapshots[1]!.id, label: "Candidate response", attributes: { bodyHash: snapshots[1]!.bodyHash ?? "[hash-only]", status: snapshots[1]!.status ?? null }, evidenceIds: [evidence.id], observationIds: [observation.id], confidence: 0.9 });
        this.graph.upsertEdge({ type: "related_to", fromNodeId: baseline.id, toNodeId: candidate.id, attributes: { diffId: diff.id, stable: diff.stable, signalCount: diff.signals.length }, evidenceIds: [evidence.id], confidence: diff.stable ? 0.85 : 0.55 });
        for (const signal of diff.signals) await this.event("RESPONSE_DIFF_SIGNAL_CREATED", { diffId: diff.id, signalKey: signal.kind, kind: signal.kind, evidenceIds: signal.evidenceIds });
        await this.event(diff.stable ? "RESPONSE_DIFF_STABILITY_CONFIRMED" : "RESPONSE_DIFF_UNSTABLE", { diffId: diff.id, observationId: observation.id });
      }
    }
  }
  private async processBrowserIntelligence(input: { toolName: string; toolCallId: string; args: unknown; result: unknown; isError: boolean }, evidence: EvidenceRecord): Promise<void> {
    if (input.isError || input.toolName !== "browser" || !this.state.browser) return;
    const snapshot = this.state.browser.domSnapshots.at(-1); const session = this.state.browser.sessions.at(-1); if (!snapshot && !session) return;
    const key = "browser-state:" + (snapshot?.id ?? session?.id ?? "unknown"); const observation = this.observations.add({ type: snapshot ? "response" : "target", summary: snapshot ? "Controlled browser DOM state and bounded network metadata captured." : "Controlled browser session created.", source: "tool", evidenceIds: [evidence.id], confidence: 0.85, normalizedKey: key }); evidence.observationIds.push(observation.id);
    const projection = projectBrowserState(this.state.browser, this.graph, evidence); await this.event("BROWSER_DOM_SNAPSHOT_CREATED", { snapshotId: snapshot?.id, sessionId: session?.id, observationId: observation.id, nodeCount: projection.nodeIds.length, edgeCount: projection.edgeIds.length }); if (this.state.browser.stateTransitions.length) await this.event("BROWSER_STATE_TRANSITION_CREATED", { transitionId: this.state.browser.stateTransitions.at(-1)?.id, snapshotId: snapshot?.id });
  }
  prepareToolCall(toolName: string, args: unknown, toolCallId: string): { duplicate: boolean; actionId: string } {
    if (!this.enabled) return { duplicate: false, actionId: "" };
    const proposal = { kind: "invoke_tool" as const, requestedTool: toolName, requestedArguments: args && typeof args === "object" ? args as Record<string, unknown> : {} };
    const key = this.deduplicator.key(proposal); const previous = this.deduplicator.find(proposal); const action: WebReasoningAction = { id: newId("action"), proposalId: this.state.nextRecommendedAction?.id ?? newId("proposal"), kind: "invoke_tool", objective: `Invoke ${toolName}`, rationaleSummary: "Model-requested registered tool action.", toolName, toolCallId, argumentsFingerprint: key, deduplicationKey: key, status: previous ? "skipped_duplicate" : "executing", evidenceIds: [], startedAt: new Date().toISOString() };
    this.state.actions.push(action); this.state.actions = this.state.actions.slice(-this.config.maxActions); this.state.lastActionId = action.id;
    if (previous) { this.state.stagnation.consecutiveDuplicateActions += 1; void this.event("WEB_ACTION_SKIPPED_DUPLICATE", { actionId: action.id, duplicateOf: previous.id, toolName }); }
    else void this.event("WEB_ACTION_PROPOSED", { actionId: action.id, toolName, deduplicationKey: key });
    return { duplicate: Boolean(previous), actionId: action.id };
  }
  markPolicyRejected(toolCallId: string, reason: string): void {
    const action = this.state.actions.find((item) => item.toolCallId === toolCallId);
    if (!action) return;
    action.status = "policy_rejected"; action.failureCode = "policy_rejected"; action.failureSummary = reason.slice(0, 240); action.completedAt = new Date().toISOString();
    void this.event("WEB_ACTION_POLICY_REJECTED", { actionId: action.id, reason: action.failureSummary });
  }

  /** Keep the run-level hypothesis ledger in sync with the reasoning ledger so the
   *  model always sees one authoritative set of hypotheses. The upsert is idempotent:
   *  matching on the stable web hypothesis id first, then on statement, so repeated
   *  rounds never insert a duplicate record. */
  private syncRunHypothesisLedger(): void {
    const ledger = this.run.hypotheses ?? [];
    for (const hypothesis of this.state.hypotheses) {
      if (hypothesis.status === "created" || hypothesis.status === "queued" || hypothesis.status === "testing") continue;
      const status = ledgerStatusForWeb(hypothesis.status);
      const existing = ledger.find((record) => record.id === hypothesis.id || record.statement === hypothesis.statement);
      const updatedAt = new Date().toISOString();
      if (existing) {
        existing.status = status;
        existing.evidence = [...hypothesis.supportingEvidenceIds];
        existing.updatedAt = updatedAt;
      } else {
        ledger.push({ id: hypothesis.id, statement: hypothesis.statement, status, evidence: [...hypothesis.supportingEvidenceIds], updatedAt });
      }
    }
    this.run.hypotheses = ledger;
  }
  async beforeFinalization(remainingRounds: number): Promise<void> { if (!this.enabled) return; this.state.phase = "completing"; this.state.budget.remainingRounds = remainingRounds; if (this.config.enableReflection) createReflection(this.state); await this.event("WEB_FINALIZATION_STARTED", { remainingRounds, evidenceCount: this.run.evidence?.length ?? 0 }); }
  async complete(status: "completed" | "blocked"): Promise<void> { if (!this.enabled) return; this.state.phase = status === "completed" ? "completed" : "blocked"; await this.event(status === "completed" ? "WEB_REASONING_COMPLETED" : "WEB_REASONING_BLOCKED", { phase: this.state.phase, evidenceCount: this.run.evidence?.length ?? 0 }); }
  serialize(): WebReasoningState { return JSON.parse(JSON.stringify(this.state)) as WebReasoningState; }
  private renderContext(remainingRounds: number): string { const state = this.state; return JSON.stringify({ web_reasoning: { phase: state.phase, web_phase: this.run.webAgent?.phase ?? "INIT", known_observations: state.observations.slice(-6).map(({ id, type, summary, evidenceIds }) => ({ id, type, summary, evidence_ids: evidenceIds })), hypothesis_ledger: (this.run.hypotheses ?? []).slice(-4).map(({ statement, status, evidence }) => ({ statement, status, evidence_count: evidence.length })), failed_actions: state.actions.filter((item) => item.status === "failed").slice(-4).map(({ deduplicationKey, failureSummary }) => ({ deduplication_key: deduplicationKey, failure_summary: failureSummary })), recommended_next_action: state.nextRecommendedAction ? { objective: state.nextRecommendedAction.objective, expected_signal: state.nextRecommendedAction.expectedSignal } : undefined, remaining_rounds: remainingRounds } }, null, 2); }
  private summarize(value: unknown): string { const raw = typeof value === "string" ? value : JSON.stringify(sanitizeSecrets(value)); return raw.slice(0, 600); }
  private async event(type: string, data: unknown): Promise<void> { await this.audit.append(type, data); }
}

export function createWebReasoningController(run: RunState, audit: AuditChain, config?: WebReasoningConfig): WebReasoningController { return new WebReasoningController(run, audit, config); }
