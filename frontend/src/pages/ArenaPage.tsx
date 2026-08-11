import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, CircleStop, Play, RefreshCw, RotateCcw, ShieldCheck, Trophy } from "lucide-react";
import { Link } from "react-router-dom";
import { getArenaJob, getArenaStatus, getWrongQuestion, startArenaJob, stopArenaJob } from "../api/operations";
import { Badge, Button, EmptyState, ErrorState, IconButton, LoadingState } from "../components/ui";
import { formatDateTime, formatTimestamp } from "../features/decision-stream/formatters";
import type { ArenaAttemptEvaluation, ArenaJobStatus, ArenaOutcome } from "../types/api";

const activeStatuses = new Set<ArenaJobStatus>(["queued", "running", "stopping"]);
const statusLabels: Record<ArenaJobStatus, string> = { queued: "排队中", running: "运行中", stopping: "正在停止", completed: "已完成", failed: "失败", aborted: "已中止" };
const outcomeLabels: Record<ArenaOutcome, string> = { solved: "已解出", wrong: "答案错误", blocked: "受阻", abandoned: "未收敛", skipped: "已跳过", "dry-run": "仅复核", "infrastructure-error": "基础设施错误" };

function attemptTone(attempt: ArenaAttemptEvaluation): string {
  if (attempt.outcome === "solved") return "completed";
  if (attempt.outcome === "wrong" || attempt.outcome === "infrastructure-error") return "failed";
  if (attempt.outcome === "blocked" || attempt.outcome === "abandoned") return "blocked";
  return "neutral";
}

export function ArenaPage() {
  const queryClient = useQueryClient();
  const [continuous, setContinuous] = useState(true);
  const [maxAttempts, setMaxAttempts] = useState(5);
  const [autoSubmit, setAutoSubmit] = useState(true);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [selectedWrongId, setSelectedWrongId] = useState<number>();
  const status = useQuery({ queryKey: ["arena-status"], queryFn: ({ signal }) => getArenaStatus(signal), refetchInterval: 2_000 });
  const activeJob = status.data?.jobs.find((job) => activeStatuses.has(job.status));

  useEffect(() => {
    if (!selectedJobId && status.data?.jobs[0]) setSelectedJobId(status.data.jobs[0].id);
    if (selectedJobId && status.data && !status.data.jobs.some((job) => job.id === selectedJobId)) setSelectedJobId(status.data.jobs[0]?.id);
  }, [selectedJobId, status.data]);

  const job = useQuery({
    queryKey: ["arena-job", selectedJobId],
    queryFn: ({ signal }) => getArenaJob(selectedJobId!, signal),
    enabled: Boolean(selectedJobId),
    refetchInterval: (query) => activeStatuses.has(query.state.data?.job.status ?? "completed") ? 1_500 : false,
  });
  const wrongQuestion = useQuery({ queryKey: ["arena-wrong-question", selectedWrongId], queryFn: ({ signal }) => getWrongQuestion(selectedWrongId!, signal), enabled: selectedWrongId !== undefined });

  const start = useMutation({
    mutationFn: () => startArenaJob({ continuous, maxAttempts, autoSubmit, idleSeconds: 1 }),
    onSuccess: ({ job: created }) => { setSelectedJobId(created.id); void queryClient.invalidateQueries({ queryKey: ["arena-status"] }); },
  });
  const stop = useMutation({
    mutationFn: (id: string) => stopArenaJob(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["arena-status"] }); void queryClient.invalidateQueries({ queryKey: ["arena-job"] }); },
  });

  const selectedJob = job.data?.job;
  const summary = selectedJob?.summary;
  const attemptStats = useMemo(() => {
    const attempts = selectedJob?.attempts ?? [];
    const solved = attempts.filter((attempt) => attempt.outcome === "solved").length;
    const evaluated = attempts.filter((attempt) => attempt.settled).length;
    return { solved, evaluated, accuracy: evaluated ? Math.round((solved / evaluated) * 100) : 0 };
  }, [selectedJob?.attempts]);

  const submit = (event: FormEvent) => { event.preventDefault(); start.mutate(); };
  if (status.isPending) return <LoadingState label="正在读取擂台控制面…" />;
  if (status.isError) return <ErrorState message={status.error.message} onRetry={() => void status.refetch()} />;
  const readiness = status.data.readiness;

  return (
    <div className="page arena-page">
      <div className="page-heading arena-heading">
        <div><div className="eyebrow">LIVE OPERATIONS</div><h1>擂台指挥</h1><p>集中控制取题、求解、提交与复盘作业。</p></div>
        <div className="heading-status"><span className={`large-status-dot ${readiness.ready ? "ready" : "attention"}`} /><span><strong>{readiness.ready ? "环境就绪" : "需要检查"}</strong><small>{readiness.model.name}</small></span><IconButton className="icon-button bordered" label="刷新擂台状态" onClick={() => void status.refetch()} disabled={status.isFetching}><RefreshCw size={17} className={status.isFetching ? "spinning" : ""} aria-hidden="true" /></IconButton></div>
      </div>

      <form className="arena-control-band" onSubmit={submit}>
        <div className="control-group mode-control"><span className="field-label">运行模式</span><div className="segmented-control"><button type="button" className={continuous ? "active" : ""} aria-pressed={continuous} onClick={() => { setContinuous(true); setAutoSubmit(true); }}>持续运行</button><button type="button" className={!continuous ? "active" : ""} aria-pressed={!continuous} onClick={() => setContinuous(false)}>有限批次</button></div></div>
        <label className="control-group"><span className="field-label">目标题数</span><input type="number" min={1} max={50} value={maxAttempts} disabled={continuous} onChange={(event) => setMaxAttempts(Number(event.target.value))} /></label>
        <label className="toggle-control"><span><strong>自动提交</strong><small>向平台提交验证结果</small></span><input type="checkbox" checked={autoSubmit} disabled={continuous} onChange={(event) => setAutoSubmit(event.target.checked)} /></label>
        <div className="control-actions">
          <Button className="button" type="submit" loading={start.isPending} disabled={!readiness.ready || Boolean(activeJob)} disabledReason={!readiness.ready ? readiness.issues.join("；") : activeJob ? "已有作业正在运行" : undefined}><Play size={16} aria-hidden="true" />开始作业</Button>
          <Button className="button danger-button" type="button" disabled={!activeJob || stop.isPending} loading={stop.isPending} onClick={() => activeJob && stop.mutate(activeJob.id)}><CircleStop size={16} aria-hidden="true" />停止</Button>
        </div>
      </form>
      {(start.error || stop.error) && <div className="inline-error">{(start.error ?? stop.error)?.message}</div>}

      <section className="readiness-strip" aria-label="擂台环境状态">
        <div><span className={`readiness-dot ${readiness.arenaCredentialConfigured ? "ok" : "bad"}`} /><span>平台凭据</span><strong>{readiness.arenaCredentialConfigured ? "已配置" : "缺失"}</strong></div>
        <div><span className={`readiness-dot ${readiness.modelCredentialConfigured && readiness.modelHeadersConfigured ? "ok" : "bad"}`} /><span>模型网关</span><strong>{readiness.modelCredentialConfigured && readiness.modelHeadersConfigured ? "已连接" : "待配置"}</strong></div>
        <div><span className={`readiness-dot ${readiness.scopeControlled ? "ok" : "bad"}`} /><span>作用域</span><strong>{readiness.scopeControlled ? "Controlled" : "未授权"}</strong></div>
        <div><span className={`readiness-dot ${readiness.sandbox.reachable ? "ok" : "warn"}`} /><span>沙箱</span><strong>{readiness.sandbox.reachable ? readiness.sandbox.network : "按需启动"}</strong></div>
        <div><span className="readiness-dot ok" /><span>允许题型</span><strong>{readiness.allowedCategories.join(" / ").toUpperCase() || "ALL"}</strong></div>
      </section>

      <section className="arena-metrics" aria-label="作业指标">
        <div><span>已处理</span><strong>{selectedJob?.completedAttempts ?? 0}</strong><small>{selectedJob?.options.continuous ? "持续模式" : `目标 ${selectedJob?.options.maxAttempts ?? 0}`}</small></div>
        <div><span>平台通过</span><strong>{summary?.solved ?? attemptStats.solved}</strong><small>VERIFIED</small></div>
        <div><span>正确率</span><strong>{summary?.accuracyPercent ?? attemptStats.accuracy}<em>%</em></strong><small>{summary?.evaluated ?? attemptStats.evaluated} 次结算</small></div>
        <div><span>平均回合</span><strong>{summary?.averageTurns ?? "—"}</strong><small>DECISION TURNS</small></div>
        <div><span>晋升经验</span><strong>{summary?.promotedLessons ?? 0}</strong><small>PROMOTED</small></div>
      </section>

      <div className="arena-workspace-grid">
        <section className="surface-panel activity-panel">
          <div className="panel-heading"><div><span className="section-label">LIVE TRACE</span><h2>实时执行轨迹</h2></div>{status.data.jobs.length > 0 && <select aria-label="Arena 作业历史" value={selectedJobId ?? ""} onChange={(event) => setSelectedJobId(event.target.value)}>{status.data.jobs.map((item) => <option key={item.id} value={item.id}>{formatDateTime(item.createdAt)} · {statusLabels[item.status]}</option>)}</select>}</div>
          {selectedJob ? <div className="job-state-line"><span className={`run-state-mark state-${selectedJob.status}`} /><Badge tone={selectedJob.status}>{statusLabels[selectedJob.status]}</Badge><span>{selectedJob.id}</span>{selectedJob.currentRunId && <Link to={`/runs/${selectedJob.currentRunId}`}>查看当前运行<ArrowRight size={13} /></Link>}</div> : null}
          {job.isFetching && !selectedJob ? <LoadingState /> : selectedJob?.activity.length ? <div className="arena-activity-list">{[...selectedJob.activity].reverse().map((event, index) => <div className="arena-activity-row" key={`${event.timestamp}-${event.type}-${index}`}><span className="activity-node"><Activity size={13} aria-hidden="true" /></span><time>{formatTimestamp(event.timestamp)}</time><span><strong>{event.type}</strong><small>{event.detail}</small></span>{event.runId ? <Link to={`/runs/${event.runId}`} aria-label="查看关联运行"><ArrowRight size={14} /></Link> : <span />}</div>)}</div> : <EmptyState title="尚无擂台作业" description="环境就绪后可从上方启动持续或有限批次作业。" />}
        </section>

        <section className="surface-panel attempts-panel">
          <div className="panel-heading"><div><span className="section-label">PLATFORM RESULTS</span><h2>题目结果</h2></div><span className="panel-count">{selectedJob?.attempts.length ?? 0}</span></div>
          {selectedJob?.attempts.length ? <div className="attempt-list">{[...selectedJob.attempts].reverse().map((attempt) => <Link className="attempt-row" to={`/runs/${attempt.run.id}`} key={`${attempt.attemptId}-${attempt.run.id}`}><span className="attempt-id">#{attempt.attemptId}</span><span><strong>{attempt.category}</strong><small>{attempt.run.turns} 回合 · {attempt.run.toolCalls} 次工具调用</small></span><Badge tone={attemptTone(attempt)}>{outcomeLabels[attempt.outcome]}</Badge><ArrowRight size={14} aria-hidden="true" /></Link>)}</div> : <div className="compact-empty"><Trophy size={20} aria-hidden="true" /><span>等待平台结算结果</span></div>}
        </section>
      </div>

      <div className="arena-secondary-grid">
        <section className="surface-panel wrong-question-panel">
          <div className="panel-heading"><div><span className="section-label">RETRY QUEUE</span><h2>错题复盘</h2></div><span className="panel-count">{status.data.wrongQuestions.length}</span></div>
          {status.data.wrongQuestions.length ? <div className="wrong-question-list">{status.data.wrongQuestions.map((item) => <button type="button" key={item.attemptId} className={selectedWrongId === item.attemptId ? "active" : ""} onClick={() => setSelectedWrongId(item.attemptId)}><span className="attempt-id">#{item.attemptId}</span><span><strong>{item.category}</strong><small>{item.lastReason}</small></span><Badge tone="blocked">失败 {item.failureCount} 次</Badge></button>)}</div> : <div className="compact-empty"><ShieldCheck size={20} aria-hidden="true" /><span>当前没有待复盘错题</span></div>}
          {selectedWrongId !== undefined && <div className="wrong-question-detail">{wrongQuestion.isPending ? <LoadingState /> : wrongQuestion.data ? <><h3>Attempt #{wrongQuestion.data.wrongQuestion.attemptId}</h3><p>{wrongQuestion.data.wrongQuestion.task}</p><dl><div><dt>附件</dt><dd>{wrongQuestion.data.wrongQuestion.attachments.length}</dd></div><div><dt>失败记录</dt><dd>{wrongQuestion.data.wrongQuestion.failures.length}</dd></div><div><dt>最后更新</dt><dd>{formatDateTime(wrongQuestion.data.wrongQuestion.lastFailedAt)}</dd></div></dl>{wrongQuestion.data.wrongQuestion.failures.at(-1)?.sourceRunId && <Link className="button secondary" to={`/runs/${wrongQuestion.data.wrongQuestion.failures.at(-1)!.sourceRunId}`}><RotateCcw size={15} aria-hidden="true" />查看失败轨迹</Link>}</> : null}</div>}
        </section>

        <section className="surface-panel capability-panel">
          <div className="panel-heading"><div><span className="section-label">CAPABILITY REVIEW</span><h2>能力复盘</h2></div></div>
          {summary ? <div className="capability-columns"><div><h3>已验证</h3>{summary.strengths.length ? <ul>{summary.strengths.map((item) => <li key={item}>{item}</li>)}</ul> : <p>暂无平台验真结果</p>}</div><div><h3>能力缺口</h3>{summary.gaps.length ? <ul>{summary.gaps.map((item) => <li key={item}>{item}</li>)}</ul> : <p>当前未识别新增缺口</p>}</div><div><h3>下一步</h3><ul>{summary.nextActions.map((item) => <li key={item}>{item}</li>)}</ul></div></div> : <div className="compact-empty"><span>作业结算后生成能力复盘</span></div>}
        </section>
      </div>
    </div>
  );
}
