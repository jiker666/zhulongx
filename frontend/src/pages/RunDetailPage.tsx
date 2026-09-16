import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, Flag, GitFork, HelpCircle, History, Pause, Play, RefreshCw, RotateCcw, Search, ShieldAlert, SkipBack, SkipForward, X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { continueRun, generateRunWriteup, getRun, getRunTrace, reviewRunEvent } from "../api/runs";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState } from "../components/ui";
import { cacheReadShare, formatConfidence, formatDateTime, formatTokenCount, formatTimestamp, kindLabels, observerKindLabels, safeJson, terminalReasonLabels, verdictLabels } from "../features/decision-stream/formatters";
import { projectTrace } from "../features/decision-stream/projection";
import type { DecisionRecord } from "../features/decision-stream/types";
import { EvidenceGraphView } from "../features/evidence-graph/EvidenceGraphView";
import { layoutEvidenceGraph } from "../features/evidence-graph/layout";
import { projectEvidenceGraph } from "../features/evidence-graph/projection";
import type { EvidenceGraphNode } from "../features/evidence-graph/types";
import { useRunRealtimeStream } from "../features/realtime/runStream";
import type { RunConnectionState } from "../features/realtime/types";
import { PolicyDetails } from "../features/policy/PolicyDetails";
import { DecisionObservatory } from "../features/decision-observatory/DecisionObservatory";
import { renderRunWriteup } from "../features/writeup/format";
import type { ObserverAnomaly, RunState, TrajectorySource } from "../types/api";

const phaseLabels: Record<string, string> = { intake: "接收", planning: "规划", exploration: "探索", analysis: "分析", verification: "验证", reporting: "报告", done: "完成" };
const statusLabels: Record<string, string> = { queued: "排队中", running: "运行中", completed: "已完成", blocked: "等待外部验证", failed: "失败", aborted: "已中止" };
const sourceLabels: Record<TrajectorySource, string> = { operator: "操作员", orchestrator: "编排器", model: "模型", context: "上下文", policy: "安全策略", tool: "工具", agent: "子 Agent", system: "系统" };
const sourceFilters: Array<{ value: "all" | TrajectorySource; label: string }> = [
  { value: "all", label: "全部来源" },
  { value: "model", label: "模型" },
  { value: "context", label: "模型看到的" },
  { value: "policy", label: "安全检查" },
  { value: "tool", label: "工具" },
  { value: "agent", label: "子 Agent" },
  { value: "orchestrator", label: "编排器" },
];
const activeStatuses = new Set(["queued", "running"]);
const terminalStatuses = new Set(["completed", "blocked", "failed", "aborted"]);

function missionValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "—";
}

function missionTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "运行详情";
  return value.split(/\r?\n/)[0]?.trim() || "运行详情";
}

function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function MissionControl({ status, state, records, realtimeState }: { status: string; state: RunState | undefined; records: DecisionRecord[]; realtimeState: RunConnectionState }) {
  const runStarted = records.find((record) => record.sourceEventType === "run.started");
  const model = runStarted?.technicalDetails?.model;
  const eventModelId = model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string" ? String((model as Record<string, unknown>).id) : undefined;
  const modelId = state?.model?.id ?? eventModelId;
  const policy = [...records].reverse().find((record) => record.kind === "policy")?.policyState;
  const target = state?.task.metadata.target ?? state?.task.metadata.host ?? state?.task.metadata.url;
  const allowed = records.filter((record) => record.kind === "policy" && record.policyState === "allowed").length;
  const blocked = records.filter((record) => record.kind === "policy" && record.policyState === "blocked").length;
  const usage = state?.tokenUsage;
  const cacheShare = usage ? cacheReadShare(usage) : undefined;
  return (
    <Card className="mission-control">
      <div className="mission-kicker">XUANSHU / MISSION CONTROL <span className={`connection-state connection-${realtimeState}`} data-realtime-state={realtimeState}>● {realtimeState.toUpperCase()}</span></div>
      <div className="mission-header"><div><h1 title={state?.task.task}>{missionTitle(state?.task.task)}</h1><p className="mono">{state?.id ?? "—"}</p></div><Badge tone={status}>{statusLabels[status] ?? status}</Badge></div>
      {state?.lineage && <Link className="lineage-link" to={`/runs/${state.lineage.parentRunId}`}><GitFork size={14} aria-hidden="true" />{state.lineage.mode === "fork" ? "分支自" : "继续自"}父运行 #{state.lineage.boundarySequence}</Link>}
      <div className="mission-facts">
        <div><span>当前阶段</span><strong>{state ? phaseLabels[state.phase] ?? state.phase : "—"}</strong></div>
        <div><span>任务目标</span><strong>{missionValue(target)}</strong></div>
        <div><span>模型</span><strong>{missionValue(modelId)}</strong></div>
        <div><span>策略状态</span><strong>{policy ? policy.toUpperCase() : "UNKNOWN"}</strong></div>
        <div><span>策略计数</span><strong>{allowed} / {blocked}</strong></div>
        <div><span>运行回合 / 工具</span><strong>{state?.turns ?? "—"} / {state?.toolCalls ?? "—"}</strong></div>
        <div><span>终止原因</span><strong>{state?.terminalReason ? terminalReasonLabels[state.terminalReason] ?? state.terminalReason : "—"}</strong></div>
        {usage && <div><span>令牌用量</span><strong title={`输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 缓存读 ${usage.cacheReadTokens} · 缓存写 ${usage.cacheCreationTokens} · 请求 ${usage.requests}`}>{formatTokenCount(usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens)} 入 / {formatTokenCount(usage.outputTokens)} 出 · 缓存命中 {cacheShare ?? 0}%</strong></div>}
      </div>
    </Card>
  );
}

const planStepMarks: Record<string, string> = { completed: "✔", in_progress: "▶", blocked: "⊘", pending: "☐" };

function PlanProgress({ state }: { state?: RunState }) {
  const plan = state?.plan;
  if (!plan) return null;
  const steps = plan.steps ?? [];
  if (!steps.length) return null;
  const completed = steps.filter((step) => step.status === "completed").length;
  const hasActivity = steps.some((step) => step.status);
  return (
    <section className="plan-progress-panel" aria-label="执行计划进度">
      <div className="plan-progress-heading">
        <div><span className="section-label">PLAN PROGRESS</span><h2>执行计划进度{hasActivity ? ` · ${completed}/${steps.length}` : ""}</h2></div>
        <span className="plan-progress-goal" title={plan.goal}>{plan.goal}</span>
      </div>
      <ol className="plan-steps">
        {steps.map((step) => (
          <li key={step.id} className={`plan-step plan-step-${step.status ?? "pending"}`}>
            <span className="plan-step-mark" aria-hidden="true">{planStepMarks[step.status ?? "pending"]}</span>
            <div className="plan-step-body">
              <strong>{step.id}</strong>
              <span className="plan-step-objective">{step.objective}</span>
              {step.dependsOn?.length ? <small className="plan-step-depends">依赖：{step.dependsOn.join("、")}</small> : null}
              {step.note ? <small className="plan-step-note">{step.note}</small> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ObserverNotes({ anomalies }: { anomalies?: ObserverAnomaly[] }) {
  if (!anomalies?.length) return null;
  return (
    <section className="observer-notes-panel" aria-label="旁路观察者记录">
      <div className="observer-notes-heading">
        <div><span className="section-label">OBSERVER / RECORD-ONLY</span><h2>旁路观察者记录</h2></div>
        <span className="chip chip-warn">{anomalies.length} 类异常</span>
      </div>
      <ul className="observer-notes-list">
        {anomalies.map((anomaly) => (
          <li key={`${anomaly.kind}-${anomaly.detail}`} className="observer-note">
            <span className="chip chip-warn">{observerKindLabels[anomaly.kind] ?? anomaly.kind} ×{anomaly.occurrences}</span>
            <code>{anomaly.detail}</code>
            <small>{formatDateTime(anomaly.firstSeenAt)} → {formatDateTime(anomaly.lastSeenAt)}</small>
          </li>
        ))}
      </ul>
      <small className="observer-notes-disclaimer">观察者只记录、不干预：这些记录用于操作员复盘与后续运行交接，不会截断本次运行。</small>
    </section>
  );
}

function CurrentAction({ status, decision, total }: { status: string; decision?: DecisionRecord; total: number }) {
  const terminal = terminalStatuses.has(status);
  return (
    <section className={`current-action ${terminal ? "settled" : "live"}`} aria-live="polite">
      <div className="current-action-mark">{terminal ? <CheckCircle2 size={18} aria-hidden="true" /> : <span className="live-pulse" />}</div>
      <div>
        <span className="section-label">{terminal ? "本次运行最后一步" : "AGENT 现在在做什么"}</span>
        <h2>{decision?.explanation.what ?? "正在等待第一条运行事件"}</h2>
        <p>{decision?.explanation.why ?? "任务启动后，每个动作都会在这里用通俗语言解释。"}</p>
        {decision && <small>来源：{sourceLabels[decision.source]} · 事件 #{decision.sequence} · 共 {total} 步</small>}
      </div>
    </section>
  );
}

function FinalConclusion({ state, events }: { state?: RunState; events: Array<{ type: string; data: unknown }> }) {
  const [generatingWriteup, setGeneratingWriteup] = useState(false);
  const [generatedInSession, setGeneratedInSession] = useState(false);
  const [generationError, setGenerationError] = useState<string>();
  const outcomeEvent = [...events].reverse().find((event) => event.type === "run.settled" || event.type === "run.finished_by_agent");
  const outcomeData = outcomeEvent?.data && typeof outcomeEvent.data === "object" ? outcomeEvent.data as Record<string, unknown> : {};
  const submission = state?.submission ?? (typeof outcomeData.submission === "string" ? outcomeData.submission : undefined);
  const summary = state?.summary ?? (typeof outcomeData.summary === "string" ? outcomeData.summary : undefined);
  const submissionValidation = state?.submissionValidation;
  const replayVerdict = state?.verificationVerdict;
  const contradicted = replayVerdict?.verdict === "contradicted";
  const verifiedSubmission = Boolean(submission && !contradicted && state?.independentlyVerified === true && submissionValidation?.status === "accepted");
  const writeupError = state?.writeupError;
  const category = state?.task.metadata.category ?? "";
  const flagLike = /ctf|flag|challenge/i.test(category) || Boolean(submission && /flag\{|[A-Za-z0-9_:-]+\{[^}]+\}/i.test(submission));
  const status = state?.status ?? "unknown";
  const statusText = status === "completed" ? "COMPLETED" : status === "blocked" ? "BLOCKED" : status === "failed" ? "FAILED" : status === "aborted" ? "ABORTED" : "IN PROGRESS";
  const downloadWriteup = async () => {
    if (!state) return;
    setGeneratingWriteup(true);
    setGenerationError(undefined);
    try {
      let content = state.writeup?.trim();
      if (!content) {
        try {
          content = (await generateRunWriteup(state.id)).writeup;
          setGeneratedInSession(true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setGenerationError(message.slice(0, 600));
          content = renderRunWriteup(state, summary);
        }
      }
      if (content) downloadMarkdown(content, `xuan-shu-${state.id}-wp.md`);
    } finally {
      setGeneratingWriteup(false);
    }
  };
  const hasWriteup = Boolean(state?.writeup?.trim()) || generatedInSession;
  return (
    <section className={`final-conclusion-panel ${submission ? "has-submission" : "no-submission"}`} aria-label="最终结论">
      <div className="final-conclusion-heading"><div><span className="section-label">FINAL CONCLUSION</span><h2>运行总结结论</h2></div><div className="final-heading-status"><span className={`final-status final-status-${status}`}>{statusText}</span>{replayVerdict && <span className={`chip chip-verdict-${replayVerdict.verdict}`} title={`重跑 ${replayVerdict.replayed} 条验证命令 · ${formatDateTime(replayVerdict.checkedAt)}`}>{verdictLabels[replayVerdict.verdict]}</span>}{verifiedSubmission && flagLike && <span className="final-flag-status"><Flag size={12} aria-hidden="true" />FLAG FOUND</span>}</div></div>
      {submission ? <div className={`submission-spotlight${verifiedSubmission ? " verified" : " candidate"}`}><div className="submission-label"><Flag size={17} aria-hidden="true" /><span>{verifiedSubmission && flagLike ? "FLAG" : "候选答案"}</span><small>{verifiedSubmission ? "已通过工具证据与独立验证" : "来自 finish_task，尚未形成可确认结论"}</small></div><div className="submission-value"><span className="submission-value-kicker">{verifiedSubmission && flagLike ? "最终 Flag" : "候选提交"}</span><code title={submission}>{submission}</code></div></div> : <div className="submission-empty"><Flag size={16} aria-hidden="true" /><span>未提交最终答案或 Flag</span><small>运行状态不会从工具日志中推测答案。</small></div>}
      <div className="conclusion-summary"><div className="conclusion-summary-heading"><span className="observatory-kicker">SUMMARY / 结论摘要</span>{summary && state && <Button className="button secondary compact-action" type="button" onClick={() => void downloadWriteup()} disabled={generatingWriteup}><Download size={14} aria-hidden="true" />{generatingWriteup ? "正在生成 WP" : hasWriteup ? "下载 WP" : "AI 生成并下载 WP"}</Button>}</div><p>{summary || "运行尚未写入总结结论。"}</p>{(writeupError || generationError) && <small className="writeup-generation-note">WP 自动生成失败，当前下载内容为结构化兼容报告：{generationError ?? writeupError}</small>}</div>
      <div className="conclusion-proof"><span>{verifiedSubmission ? "✓ INDEPENDENTLY VERIFIED" : "VERIFICATION STATUS"}</span><strong>{contradicted ? "复放验证矛盾：完成声明不被信任" : verifiedSubmission ? "已独立验证" : submissionValidation?.reason ?? (state?.verification?.length ? `${state.verification.length} 条验证记录` : "未提供独立验证")}</strong></div>
      {replayVerdict && (
        <div className={`replay-verdict replay-verdict-${replayVerdict.verdict}`}>
          <span className="observatory-kicker">REPLAY VERIFIER / 复放验证</span>
          <div className="replay-verdict-row">
            <span className={`chip chip-verdict-${replayVerdict.verdict}`}>{verdictLabels[replayVerdict.verdict]}</span>
            <span className="replay-verdict-meta">在结算后重跑了解题者自己的 {replayVerdict.replayed} 条验证命令 · {formatDateTime(replayVerdict.checkedAt)}</span>
          </div>
          {replayVerdict.evidence.length > 0 && <ul className="replay-verdict-evidence">{replayVerdict.evidence.map((item, index) => <li key={index}><code>{item}</code></li>)}</ul>}
          {contradicted && <small className="replay-verdict-warning">复放未复现候选答案：该运行的完成声明已按失败处理，赛跑与编排不再采信。</small>}
        </div>
      )}
    </section>
  );
}

function DecisionItem({ decision, selected, onSelect }: { decision: DecisionRecord; selected: boolean; onSelect: () => void }) {
  const confidence = decision.confidenceAfter ?? decision.confidenceBefore;
  return (
    <button className={`decision-item decision-${decision.kind} source-${decision.source}${selected ? " selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <span className="decision-node" aria-hidden="true" />
      <span className="decision-body">
        <span className="decision-meta"><span>#{decision.sequence}</span><span>{formatTimestamp(decision.timestamp)}</span><span className={`source-pill source-pill-${decision.source}`}>{sourceLabels[decision.source]}</span></span>
        <strong>{decision.explanation.what}</strong>
        <span className="decision-summary"><b>为什么：</b>{decision.explanation.why}</span>
        {decision.explanation.result && <span className="decision-result-line"><b>结果：</b>{decision.explanation.result}</span>}
        <span className="decision-status">{decision.policyState ? `策略 · ${decision.policyState}` : confidence !== undefined ? `置信度 · ${formatConfidence(confidence)}` : `事件 · ${decision.sourceEventType}`}</span>
      </span>
    </button>
  );
}

function relatedDecisions(node: EvidenceGraphNode, decisions: DecisionRecord[]): DecisionRecord[] {
  const rawId = node.subtitle ?? node.id.split(":").slice(1).join(":");
  return decisions.filter((decision) => node.sourceIds.includes(decision.id) || decision.relatedEvidenceIds?.includes(rawId) || decision.relatedActionId === rawId || decision.relatedCandidateId === rawId);
}

function graphNodeForDecision(decision: DecisionRecord, nodes: EvidenceGraphNode[]): EvidenceGraphNode | undefined {
  return nodes.find((node) => decision.relatedEvidenceIds?.some((id) => node.id === `evidence:${id}`) || (decision.relatedActionId && node.id === `action:${decision.relatedActionId}`) || (decision.relatedCandidateId && node.id === `candidate:${decision.relatedCandidateId}`) || node.sourceIds.includes(decision.id));
}

function DecisionReview({ runId, decision, reviews }: { runId: string; decision: DecisionRecord; reviews: import("../types/api").RunReview[] }) {
  const queryClient = useQueryClient();
  const existing = reviews.filter((review) => review.sequence === decision.sequence).sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  const latest = existing[0];
  const [verdict, setVerdict] = useState<"correct" | "incorrect" | "uncertain">(latest?.verdict ?? "uncertain");
  const [note, setNote] = useState("");
  const [correction, setCorrection] = useState("");
  const mutation = useMutation({
    mutationFn: () => reviewRunEvent(runId, { sequence: decision.sequence, verdict, note, ...(correction.trim() ? { correction } : {}) }),
    onSuccess: () => { setNote(""); setCorrection(""); void queryClient.invalidateQueries({ queryKey: ["trace", runId] }); },
  });
  return (
    <section className="decision-review">
      <div className="review-heading"><span><ShieldAlert size={14} aria-hidden="true" />人工复核</span>{existing.length > 0 && <Badge tone="success">已复核 {existing.length}</Badge>}</div>
      {latest && <div className="latest-review"><span><strong>{latest.verdict === "correct" ? "正确" : latest.verdict === "incorrect" ? "错误" : "待确认"}</strong>{latest.createdAt ? formatDateTime(latest.createdAt) : "最近复核"}</span><p>{latest.note}</p>{latest.correction && <small>修正建议：{latest.correction}</small>}</div>}
      <div className="review-verdicts" role="radiogroup" aria-label="复核结论">
        <button type="button" role="radio" aria-checked={verdict === "correct"} className={verdict === "correct" ? "active correct" : ""} onClick={() => setVerdict("correct")}><CheckCircle2 size={14} aria-hidden="true" />正确</button>
        <button type="button" role="radio" aria-checked={verdict === "incorrect"} className={verdict === "incorrect" ? "active incorrect" : ""} onClick={() => setVerdict("incorrect")}><ShieldAlert size={14} aria-hidden="true" />错误</button>
        <button type="button" role="radio" aria-checked={verdict === "uncertain"} className={verdict === "uncertain" ? "active uncertain" : ""} onClick={() => setVerdict("uncertain")}><HelpCircle size={14} aria-hidden="true" />待确认</button>
      </div>
      <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="复核依据（必填）" aria-label="复核依据" required maxLength={2000} />
      <textarea value={correction} onChange={(event) => setCorrection(event.target.value)} placeholder="修正建议（可选）" aria-label="修正建议" maxLength={4000} />
      <Button className="button secondary" type="button" loading={mutation.isPending} disabled={!note.trim()} onClick={() => mutation.mutate()}><CheckCircle2 size={15} aria-hidden="true" />保存复核</Button>
      {mutation.error && <span className="review-error" role="alert">{mutation.error.message}</span>}
    </section>
  );
}

function DecisionInspector({ runId, decision, graphNodes, reviews, onViewGraph, onFork, forking }: { runId: string; decision?: DecisionRecord; graphNodes: EvidenceGraphNode[]; reviews: import("../types/api").RunReview[]; onViewGraph: (id: string) => void; onFork: (sequence: number) => void; forking: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!decision) return <aside className="inspector-panel"><div className="section-label">DECISION INSPECTOR</div><EmptyState title="选择一条动作记录" description="点击行动轨迹中的步骤，查看它在做什么、为什么以及产生什么影响。" /></aside>;
  const confidenceBefore = formatConfidence(decision.confidenceBefore);
  const confidenceAfter = formatConfidence(decision.confidenceAfter);
  const graphNode = graphNodeForDecision(decision, graphNodes);
  return (
    <aside className="inspector-panel">
      <div className="section-label">DECISION INSPECTOR</div>
      <h2>{decision.explanation.what}</h2>
      <div className="inspector-source"><span className={`source-pill source-pill-${decision.source}`}>{sourceLabels[decision.source]}</span><span>#{decision.sequence}</span></div>
      <dl className="plain-explanation">
        <div><dt>这一步在做什么</dt><dd>{decision.explanation.what}</dd></div>
        <div><dt>为什么要做</dt><dd>{decision.explanation.why}</dd></div>
        <div><dt>会产生什么影响</dt><dd>{decision.explanation.impact}</dd></div>
        {decision.explanation.result && <div><dt>得到什么结果</dt><dd>{decision.explanation.result}</dd></div>}
        {decision.explanation.next && <div><dt>接下来会怎样</dt><dd>{decision.explanation.next}</dd></div>}
      </dl>
      <dl className="inspector-facts compact">
        <div><dt>时间</dt><dd>{formatDateTime(decision.timestamp)}</dd></div>
        <div><dt>技术事件</dt><dd className="mono">{decision.sourceEventType}</dd></div>
        {decision.actor && <div><dt>执行者</dt><dd>{decision.actor}</dd></div>}
        {decision.correlationId && <div><dt>关联 ID</dt><dd className="mono">{decision.correlationId}</dd></div>}
        {decision.parentSequence !== undefined && <div><dt>上游事件</dt><dd>#{decision.parentSequence}</dd></div>}
        {decision.policyState && <div><dt>策略</dt><dd>{decision.policyState}</dd></div>}
        {decision.relatedEvidenceIds?.length && <div><dt>Evidence ID</dt><dd className="mono">{decision.relatedEvidenceIds.join(", ")}</dd></div>}
        {(confidenceBefore || confidenceAfter) && <div><dt>Confidence</dt><dd>{confidenceBefore ?? "—"} → {confidenceAfter ?? "—"}</dd></div>}
      </dl>
      {decision.kind === "policy" && <PolicyDetails record={decision} />}
      <div className="inspector-actions">
        {graphNode && <Button className="button secondary graph-link-button" onClick={() => onViewGraph(graphNode.id)}>在证据图中查看</Button>}
        <Button className="button secondary" loading={forking} onClick={() => onFork(decision.sequence)}><GitFork size={15} aria-hidden="true" />从这一步创建分支</Button>
      </div>
      {decision.technicalDetails ? <div className="technical-details"><Button className="button secondary" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? "收起技术详情" : "查看技术详情"}</Button>{expanded && <pre>{safeJson(decision.technicalDetails)}</pre>}</div> : <p className="muted">无额外技术数据</p>}
      <DecisionReview key={decision.id} runId={runId} decision={decision} reviews={reviews} />
    </aside>
  );
}

function GraphInspector({ node, decisions, onViewDecision }: { node?: EvidenceGraphNode; decisions: DecisionRecord[]; onViewDecision: (id: string) => void }) {
  if (!node) return <aside className="inspector-panel graph-inspector"><div className="section-label">GRAPH INSPECTOR</div><EmptyState title="选择图中的节点查看证据关系" description="节点仅来自真实运行实体或审计事件。" /></aside>;
  const linked = relatedDecisions(node, decisions);
  return <aside className="inspector-panel graph-inspector"><div className="section-label">GRAPH INSPECTOR</div><h2>{node.label}</h2><dl className="inspector-facts"><div><dt>节点类型</dt><dd>{node.kind}</dd></div><div><dt>节点状态</dt><dd>{node.state}</dd></div><div><dt>真实 ID</dt><dd className="mono">{node.subtitle ?? node.id}</dd></div>{node.confidence !== undefined && <div><dt>Confidence</dt><dd>{formatConfidence(node.confidence)}</dd></div>}<div><dt>来源</dt><dd>{node.sourceIds.length ? node.sourceIds.join(", ") : "—"}</dd></div></dl>{linked.length > 0 && <div className="linked-decisions"><strong>关联决策 {linked.length} 条</strong>{linked.map((decision) => <Button key={decision.id} className="button secondary" onClick={() => onViewDecision(decision.id)}>{decision.title}</Button>)}</div>}{node.metadata && <div className="technical-details"><details><summary>查看 Metadata</summary><pre>{safeJson(node.metadata)}</pre></details></div>}</aside>;
}

function BranchCompare({ current, parent, currentEvents, parentEvents }: { current?: RunState; parent?: RunState; currentEvents: Array<{ type: string; data: unknown }>; parentEvents: Array<{ type: string; data: unknown }> }) {
  if (!current?.lineage) return null;
  const names = (items: Array<{ id?: string; title?: string; statement?: string; objective?: string; toolName?: string }>) => items.map((item) => item.id ?? item.title ?? item.statement ?? item.objective ?? item.toolName ?? "unknown").filter(Boolean);
  const currentHypotheses = names(current.webReasoning?.hypotheses?.length ? current.webReasoning.hypotheses : current.hypotheses);
  const parentHypotheses = names(parent?.webReasoning?.hypotheses?.length ? parent.webReasoning.hypotheses : parent?.hypotheses ?? []);
  const currentActions = (current.webReasoning?.actions ?? []).map((item) => item.id ?? item.toolName ?? item.objective);
  const parentActions = (parent?.webReasoning?.actions ?? []).map((item) => item.id ?? item.toolName ?? item.objective);
  const currentEvidence = (current.evidence ?? []).map((item) => item.id);
  const parentEvidence = (parent?.evidence ?? []).map((item) => item.id);
  const currentFindings = (current.findings ?? []).map((item) => item.id);
  const parentFindings = (parent?.findings ?? []).map((item) => item.id);
  const policyBlocks = (events: Array<{ type: string; data: unknown }>) => events.filter((event) => event.type === "policy.decision" && event.data && typeof event.data === "object" && (event.data as Record<string, unknown>).allowed === false).length;
  const added = (left: string[], right: string[]) => left.filter((item) => !right.includes(item));
  const metrics = [
    ["Outcome", parent?.status ?? "Unavailable", current.status],
    ["Tool Calls", parent?.toolCalls ?? "—", current.toolCalls],
    ["Strategy Revisions", parent?.strategyRevisions?.length ?? "—", current.strategyRevisions?.length ?? 0],
    ["Evidence", parent?.evidence?.length ?? "—", current.evidence?.length ?? 0],
    ["Findings", parent?.findings?.length ?? "—", current.findings?.length ?? 0],
    ["Policy Blocks", policyBlocks(parentEvents), policyBlocks(currentEvents)],
  ];
  const differences = [
    ["HYPOTHESES", added(currentHypotheses, parentHypotheses)],
    ["ACTIONS", added(currentActions, parentActions)],
    ["EVIDENCE", added(currentEvidence, parentEvidence)],
    ["FINDINGS", added(currentFindings, parentFindings)],
  ] as const;
  return <section className="branch-compare-panel"><div className="branch-compare-heading"><div><span className="section-label">RUN LINEAGE / COUNTERFACTUAL COMPARE</span><h2>Decision Tree</h2></div><span className="mono">Fork @ #{current.lineage.boundarySequence}</span></div><div className="lineage-graph"><span className="lineage-run">PARENT RUN <b>{current.lineage.parentRunId.slice(0, 8)}</b></span><span className="lineage-fork">#{current.lineage.boundarySequence}</span><span className="lineage-run current">CURRENT RUN <b>{current.id.slice(0, 8)}</b></span></div><div className="branch-compare-table"><div className="branch-compare-row branch-compare-head"><span>METRIC</span><span>PARENT</span><span>BRANCH</span></div>{metrics.map(([label, parentValue, currentValue]) => <div className="branch-compare-row" key={String(label)}><span>{label}</span><strong>{parentValue}</strong><strong>{currentValue}</strong></div>)}</div><div className="branch-difference-grid">{differences.map(([label, items]) => <div className="branch-difference" key={label}><span className="observatory-kicker">DIFFERENT {label}</span>{items.length ? <ul>{items.slice(0, 8).map((item) => <li key={item}>{item}</li>)}</ul> : <small>无新增差异</small>}</div>)}</div></section>;
}

export function RunDetailPage() {
  const { runId = "" } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<"trajectory" | "graph" | "raw">("trajectory");
  const [graphMode, setGraphMode] = useState<"evidence" | "attack" | "browser">("evidence");
  const [sourceFilter, setSourceFilter] = useState<"all" | TrajectorySource>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedGraphId, setSelectedGraphId] = useState<string>();
  const [replayEnabled, setReplayEnabled] = useState(false);
  const [replaySequence, setReplaySequence] = useState(1);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [branchBoundary, setBranchBoundary] = useState<number>();
  const [branchInstruction, setBranchInstruction] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(160);
  const [realtimeState, setRealtimeState] = useState<RunConnectionState>("connecting");
  const run = useQuery({ queryKey: ["run", runId], queryFn: ({ signal }) => getRun(runId, signal), enabled: Boolean(runId), refetchInterval: (query) => activeStatuses.has(query.state.data?.status ?? "") && realtimeState !== "live" ? 5_000 : false });
  useRunRealtimeStream(runId, activeStatuses.has(run.data?.status ?? ""), setRealtimeState);
  const trace = useQuery({ queryKey: ["trace", runId], queryFn: ({ signal }) => getRunTrace(runId, signal), enabled: Boolean(runId), refetchInterval: () => activeStatuses.has(run.data?.status ?? "") && realtimeState !== "live" ? 10_000 : false });
  const parentRun = useQuery({ queryKey: ["parent-run", run.data?.state?.lineage?.parentRunId], queryFn: ({ signal }) => getRun(run.data?.state?.lineage?.parentRunId ?? "", signal), enabled: Boolean(run.data?.state?.lineage?.parentRunId) });
  const parentTrace = useQuery({ queryKey: ["parent-trace", run.data?.state?.lineage?.parentRunId], queryFn: ({ signal }) => getRunTrace(run.data?.state?.lineage?.parentRunId ?? "", signal), enabled: Boolean(run.data?.state?.lineage?.parentRunId) });
  const rawEvents = trace.data?.rawEvents ?? trace.data?.timeline.map((event) => ({ sequence: event.sequence, timestamp: event.timestamp, type: event.sourceEventType ?? event.kind, source: event.source, actor: event.actor, correlationId: event.correlationId, parentSequence: event.parentSequence, data: event.data })) ?? [];
  const decisions = useMemo(() => projectTrace(rawEvents), [rawEvents]);
  const maxSequence = decisions.at(-1)?.sequence ?? 1;
  useEffect(() => { setSelectedId((current) => current && decisions.some((decision) => decision.id === current) ? current : decisions.at(-1)?.id); }, [decisions]);
  useEffect(() => { if (!replayEnabled) setReplaySequence(maxSequence); }, [maxSequence, replayEnabled]);
  useEffect(() => {
    if (!replayEnabled || !replayPlaying) return;
    const timer = window.setInterval(() => setReplaySequence((current) => {
      if (current >= maxSequence) { setReplayPlaying(false); return maxSequence; }
      return Math.min(maxSequence, current + 1);
    }), Math.max(120, 700 / replaySpeed));
    return () => window.clearInterval(timer);
  }, [maxSequence, replayEnabled, replayPlaying, replaySpeed]);
  const state = (run.data?.state ?? trace.data?.state) as RunState | undefined;
  const graph = useMemo(() => layoutEvidenceGraph(projectEvidenceGraph({ state: state ?? ({ id: runId, status: "running", phase: "intake", task: { task: "", metadata: {}, attachments: [] }, createdAt: "", updatedAt: "", findings: [], lessons: [], hypotheses: [], strategyRevisions: [], turns: 0, toolCalls: 0, httpRequests: 0, tcpSessions: 0 } as RunState), rawEvents })), [rawEvents, runId, state]);
  const displayedGraph = useMemo(() => {
    if (graphMode === "evidence") return graph;
    const nodes = graph.nodes.filter((node) => graphMode === "attack" ? node.id.startsWith("web:") : node.id.startsWith("browser:"));
    const nodeIds = new Set(nodes.map((node) => node.id));
    return layoutEvidenceGraph({ nodes, edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) });
  }, [graph, graphMode]);
  const continuation = useMutation({
    mutationFn: ({ mode, boundarySequence, instruction }: { mode: "fork" | "resume"; boundarySequence?: number; instruction?: string }) => continueRun(runId, mode, { ...(boundarySequence === undefined ? {} : { boundarySequence }), ...(instruction?.trim() ? { instruction: instruction.trim() } : {}) }),
    onSuccess: (result) => void navigate(`/runs/${result.id}`),
  });
  if (run.isPending) return <LoadingState label="正在读取任务概览…" />;
  if (run.isError) return <ErrorState message={run.error.message} onRetry={() => void run.refetch()} />;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleDecisions = decisions.filter((decision) => !replayEnabled || decision.sequence <= replaySequence).filter((decision) => sourceFilter === "all" || decision.source === sourceFilter).filter((decision) => !normalizedSearch || `${decision.title} ${decision.summary} ${decision.explanation.what} ${decision.explanation.why} ${decision.sourceEventType}`.toLowerCase().includes(normalizedSearch));
  const renderedDecisions = visibleDecisions.slice(-visibleLimit);
  const hiddenDecisionCount = visibleDecisions.length - renderedDecisions.length;
  const selected = decisions.find((decision) => decision.id === selectedId);
  const currentDecision = decisions.filter((decision) => !replayEnabled || decision.sequence <= replaySequence).at(-1);
  const observatoryEvents = replayEnabled ? rawEvents.filter((event) => event.sequence <= replaySequence) : rawEvents;
  const selectedGraphNode = displayedGraph.nodes.find((node) => node.id === selectedGraphId);
  const manualRefresh = async () => { await Promise.all([run.refetch(), trace.refetch()]); };
  const selectDecision = (id: string) => { setSelectedId(id); setActiveTab("trajectory"); };
  const locateSequence = (sequence: number) => {
    const decision = decisions.find((item) => item.sequence === sequence) ?? decisions.find((item) => item.sequence >= sequence);
    if (decision) selectDecision(decision.id);
  };
  const openBranchLab = (sequence: number) => { setBranchBoundary(sequence); setBranchInstruction(""); };
  const createBranch = () => { if (branchBoundary === undefined) return; continuation.mutate({ mode: "fork", boundarySequence: branchBoundary, instruction: branchInstruction }); setBranchBoundary(undefined); };
  const jumpReplay = (direction: "back" | "forward", type?: string) => {
    const candidates = decisions.filter((decision) => type ? decision.sourceEventType === type : true).map((decision) => decision.sequence);
    const current = replayEnabled ? replaySequence : maxSequence;
    const next = direction === "back" ? [...candidates].reverse().find((sequence) => sequence < current) : candidates.find((sequence) => sequence > current);
    setReplayEnabled(true);
    if (next !== undefined) setReplaySequence(next); else setReplaySequence(direction === "back" ? 1 : maxSequence);
  };
  const selectGraph = (id: string) => { setSelectedGraphId(id); setActiveTab("graph"); };
  const exportAudit = () => { if (!trace.data) return; const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), run: run.data, trace: trace.data }, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `xuan-shu-audit-${runId}.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); };
  return (
    <div className="page run-detail-page">
      <Link className="back-link" to="/runs">← 返回运行审计</Link>
      <div className="detail-toolbar">
        <span className="eyebrow">RUN DETAIL / {runId}</span>
        <div>
          {terminalStatuses.has(run.data?.status ?? "") && <Button className="button secondary" loading={continuation.isPending} onClick={() => continuation.mutate({ mode: "resume" })}><RotateCcw size={15} aria-hidden="true" />从结尾继续</Button>}
          <Button className="button secondary" onClick={exportAudit} disabled={!trace.data} disabledReason="等待审计数据加载"><Download size={15} aria-hidden="true" />导出审计</Button>
          <Button className="button secondary" onClick={() => void manualRefresh()} loading={run.isFetching || trace.isFetching} disabled={run.isFetching || trace.isFetching}><RefreshCw size={15} aria-hidden="true" />刷新</Button>
        </div>
      </div>
      {continuation.error && <div className="inline-error" role="alert">{continuation.error.message}</div>}
      <MissionControl status={run.data?.status ?? "unknown"} state={state} records={decisions} realtimeState={realtimeState} />
      <CurrentAction status={run.data?.status ?? "unknown"} decision={currentDecision} total={decisions.length} />
      <PlanProgress state={state} />
      <FinalConclusion state={state} events={rawEvents} />
      <ObserverNotes anomalies={state?.observerAnomalies} />
      <DecisionObservatory state={state} events={observatoryEvents} onLocate={locateSequence} />
      <BranchCompare current={state} parent={parentRun.data?.state} currentEvents={rawEvents} parentEvents={parentTrace.data?.rawEvents ?? []} />
      {trace.data && <div className={`audit-integrity ${trace.data.integrity.valid ? "valid" : "invalid"}`}>{trace.data.integrity.valid ? <CheckCircle2 size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}<span><strong>{trace.data.integrity.valid ? "审计链完整" : "审计链异常"}</strong><small>{trace.data.integrity.records} 条只追加记录{trace.data.integrity.error ? ` · ${trace.data.integrity.error}` : " · 顺序与哈希校验通过"}</small></span></div>}
      <div className="view-tabs primary-tabs" role="tablist" aria-label="Run detail view">
        <button role="tab" aria-selected={activeTab === "trajectory"} className={activeTab === "trajectory" ? "active" : ""} onClick={() => setActiveTab("trajectory")}>行动轨迹</button>
        <button role="tab" aria-selected={activeTab === "graph"} className={activeTab === "graph" ? "active" : ""} onClick={() => setActiveTab("graph")}>证据图</button>
        <button role="tab" aria-selected={activeTab === "raw"} className={activeTab === "raw" ? "active" : ""} onClick={() => setActiveTab("raw")}>原始事件</button>
      </div>
      {trace.isPending ? <LoadingState label="正在校验审计链并构建行动轨迹…" /> : trace.isError ? <ErrorState message={trace.error.message} onRetry={() => void trace.refetch()} /> : activeTab === "graph" ? <div className="graph-layout"><section><div className="graph-mode-switch" role="tablist" aria-label="图谱模式"><button type="button" className={graphMode === "evidence" ? "active" : ""} onClick={() => setGraphMode("evidence")}>EVIDENCE</button><button type="button" className={graphMode === "attack" ? "active" : ""} onClick={() => setGraphMode("attack")}>ATTACK SURFACE</button><button type="button" className={graphMode === "browser" ? "active" : ""} onClick={() => setGraphMode("browser")}>BROWSER STATE</button></div><EvidenceGraphView graph={displayedGraph} selectedId={selectedGraphId} onSelect={setSelectedGraphId} /></section><GraphInspector node={selectedGraphNode} decisions={decisions} onViewDecision={selectDecision} /></div> : (
        <div className="decision-layout">
          <section className="decision-main">
            {activeTab === "trajectory" && <>
              <div className="trajectory-toolbar">
                <div className="stream-filters" aria-label="按事件来源筛选">{sourceFilters.map((item) => <button key={item.value} className={sourceFilter === item.value ? "active" : ""} onClick={() => setSourceFilter(item.value)}>{item.label}</button>)}</div>
                <label className="trajectory-search"><Search size={15} aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索动作、原因或事件" aria-label="搜索行动轨迹" /></label>
                <label className="replay-toggle"><input type="checkbox" checked={replayEnabled} onChange={(event) => { setReplayEnabled(event.target.checked); setReplaySequence(maxSequence); }} /><History size={15} aria-hidden="true" />历史回放</label>
              </div>
              {replayEnabled && <div className="replay-control replay-flight-recorder"><div className="replay-buttons"><button type="button" onClick={() => setReplayPlaying((value) => !value)} aria-label={replayPlaying ? "暂停回放" : "播放回放"}>{replayPlaying ? <Pause size={14} /> : <Play size={14} />}</button><button type="button" onClick={() => jumpReplay("back")} aria-label="上一个事件"><SkipBack size={14} /></button><button type="button" onClick={() => jumpReplay("forward")} aria-label="下一个事件"><SkipForward size={14} /></button></div><span>MISSION FLIGHT RECORDER</span><input type="range" min={1} max={maxSequence} value={Math.min(replaySequence, maxSequence)} onChange={(event) => { setReplayPlaying(false); setReplaySequence(Number(event.target.value)); }} aria-label="回放事件序号" /><strong>#{replaySequence} / {maxSequence}</strong><select value={replaySpeed} onChange={(event) => setReplaySpeed(Number(event.target.value))} aria-label="回放速度"><option value={0.5}>0.5x</option><option value={1}>1x</option><option value={2}>2x</option></select><div className="replay-jumps"><button type="button" onClick={() => jumpReplay("forward", "decision.checkpoint")}>Next Checkpoint</button><button type="button" onClick={() => jumpReplay("forward", "strategy.revised")}>Next Revision</button><button type="button" onClick={() => jumpReplay("forward", "finding.recorded")}>Next Finding</button><button type="button" onClick={() => jumpReplay("forward", "policy.decision")}>Next Policy</button></div></div>}
              {visibleDecisions.length ? <div className="decision-stream">{hiddenDecisionCount > 0 && <button className="load-earlier-events" onClick={() => setVisibleLimit((value) => value + 160)}><History size={14} aria-hidden="true" />加载更早的 {Math.min(160, hiddenDecisionCount)} 条记录</button>}{renderedDecisions.map((decision) => <DecisionItem key={decision.id} decision={decision} selected={decision.id === selectedId} onSelect={() => setSelectedId(decision.id)} />)}</div> : <EmptyState title="没有匹配的行动记录" description="调整来源、搜索词或回放位置后重试。" />}
            </>}
            {activeTab === "raw" && (rawEvents.length ? <div className="raw-stream">{rawEvents.map((event) => <button className="raw-event" key={`${event.sequence}-${event.timestamp}`} onClick={() => selectDecision(`${event.type}:${event.sequence}`)}><span>#{event.sequence}</span><strong>{event.type}</strong><small>{event.source ? sourceLabels[event.source] : "系统"}{event.actor ? ` · ${event.actor}` : ""}</small><time>{formatDateTime(event.timestamp)}</time><pre>{safeJson(event.data)}</pre></button>)}</div> : <EmptyState title="暂无原始事件" description="该运行尚未产生可展示的审计事件。" />)}
          </section>
          <DecisionInspector runId={runId} decision={selected} graphNodes={graph.nodes} reviews={trace.data?.reviews ?? []} onViewGraph={selectGraph} onFork={openBranchLab} forking={continuation.isPending} />
        </div>
      )}
      {branchBoundary !== undefined && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setBranchBoundary(undefined); }}><section className="branch-dialog" role="dialog" aria-modal="true" aria-labelledby="branch-dialog-title"><div className="dialog-header"><div><div className="eyebrow">COUNTERFACTUAL BRANCH LAB</div><h2 id="branch-dialog-title">从事件 #{branchBoundary} 创建替代路线</h2></div><button type="button" className="icon-button" aria-label="关闭分支实验" onClick={() => setBranchBoundary(undefined)}><X size={17} /></button></div><p>父运行在该边界之前保持不变；新运行只继承公开、脱敏的历史轨迹。</p><label className="field-label" htmlFor="branch-instruction">Alternative Instruction</label><textarea id="branch-instruction" value={branchInstruction} onChange={(event) => setBranchInstruction(event.target.value)} maxLength={4000} placeholder="例如：优先分析已有浏览器网络证据，再决定是否主动请求。" /><div className="branch-dialog-footer"><span>Inherited evidence: {state?.evidence?.length ?? 0}</span><Button className="button" loading={continuation.isPending} onClick={createBranch}><GitFork size={15} />创建分支</Button></div></section></div>}
    </div>
  );
}
