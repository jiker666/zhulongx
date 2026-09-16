import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Bot, Boxes, CheckCircle2, Clock3, RefreshCw, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { getExperiences } from "../api/experiences";
import { getManualJobs, getQuestionBank } from "../api/operations";
import { getRuns } from "../api/runs";
import { Badge, IconButton } from "../components/ui";
import { formatDateTime } from "../features/decision-stream/formatters";

const activeStatuses = new Set(["queued", "running", "stopping"]);
const runStatusLabels: Record<string, string> = { queued: "排队中", running: "运行中", completed: "已完成", blocked: "等待验证", failed: "失败", aborted: "已中止" };

export function OverviewPage() {
  const manual = useQuery({ queryKey: ["manual-jobs"], queryFn: ({ signal }) => getManualJobs(signal), refetchInterval: 5_000 });
  const bank = useQuery({ queryKey: ["question-bank"], queryFn: ({ signal }) => getQuestionBank(signal), refetchInterval: 10_000 });
  const runs = useQuery({ queryKey: ["runs"], queryFn: ({ signal }) => getRuns(signal), refetchInterval: 10_000 });
  const experiences = useQuery({ queryKey: ["experiences"], queryFn: ({ signal }) => getExperiences(signal), refetchInterval: 15_000 });
  const runItems = runs.data?.runs ?? [];
  const manualJobs = manual.data?.jobs ?? [];
  const questionBank = bank.data?.questionBank;
  const activeManual = manualJobs.filter((job) => activeStatuses.has(job.status)).length;
  const activeRuns = runItems.filter((run) => run.status === "running" || run.status === "queued").length;
  const completedRuns = runItems.filter((run) => run.status === "completed").length;
  const solvedQuestions = questionBank?.solvedCount ?? 0;
  const totalQuestions = questionBank?.count ?? 0;
  const bankProgress = totalQuestions ? Math.round((solvedQuestions / totalQuestions) * 100) : 0;
  const activeExperiences = (experiences.data?.experiences ?? []).filter((item) => item.status === "active").length;
  const isRefreshing = [manual, bank, runs, experiences].some((query) => query.isFetching);
  const sources = [{ label: "批量作业", query: manual }, { label: "任务集", query: bank }, { label: "运行审计", query: runs }, { label: "经验库", query: experiences }];
  const failedSources = sources.filter(({ query }) => query.isError).map(({ label }) => label);
  const lastUpdatedAt = Math.max(...sources.map(({ query }) => query.dataUpdatedAt), 0);
  const refresh = () => void Promise.all([manual.refetch(), bank.refetch(), runs.refetch(), experiences.refetch()]);

  return <div className="page overview-page">
    <div className="page-heading overview-heading"><div><div className="eyebrow">概览</div><h1>系统总览</h1><p>实时汇总执行环境、任务进度与审计结果。</p></div><div className="heading-refresh"><span><Clock3 size={13} aria-hidden="true" />{lastUpdatedAt ? `更新于 ${new Date(lastUpdatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : "等待首次同步"}</span><IconButton className="icon-button bordered" label="刷新系统状态" onClick={refresh} disabled={isRefreshing}><RefreshCw size={17} className={isRefreshing ? "spinning" : ""} aria-hidden="true" /></IconButton></div></div>
    {failedSources.length > 0 && <div className="data-health-banner" role="alert"><AlertTriangle size={16} aria-hidden="true" /><span><strong>部分数据暂不可用</strong><small>{failedSources.join("、")}读取失败；其余模块仍保留最近一次有效结果。</small></span><button type="button" onClick={refresh}>重新同步</button></div>}
    <section className="readiness-brief ready"><div className="brief-mark"><ShieldCheck size={25} aria-hidden="true" /></div><div className="brief-copy"><span className="section-label">平台状态</span><h2>通用运行控制面</h2><p>主动能力由 operator scope、PolicyEngine 和运行预算共同约束。</p></div><div className="brief-actions"><Link className="button" to="/workbench"><Boxes size={16} aria-hidden="true" />提交任务</Link><Link className="button secondary" to="/campaigns">自主编排<ArrowRight size={15} aria-hidden="true" /></Link></div></section>
    <section className="command-metrics" aria-label="系统指标"><div><span>活动运行</span><strong>{runs.data ? activeRuns : "—"}</strong><small>进行中</small></div><div><span>控制作业</span><strong>{manual.data ? activeManual : "—"}</strong><small>进行中</small></div><div><span>完成运行</span><strong>{runs.data ? completedRuns : "—"}</strong><small>累计</small></div><div><span>任务集完成</span><strong>{bank.data ? solvedQuestions : "—"}<em>/{bank.data ? totalQuestions : "—"}</em></strong><small>已核验</small></div><div><span>验真经验</span><strong>{experiences.data ? activeExperiences : "—"}</strong><small>启用中</small></div></section>
    <div className="overview-grid"><section className="surface-panel recent-runs-panel"><div className="panel-heading"><div><span className="section-label">运行记录</span><h2>最近运行</h2></div><Link className="text-link" to="/runs">查看全部<ArrowRight size={14} aria-hidden="true" /></Link></div>{runItems.length ? <div className="compact-run-list">{runItems.slice(0, 6).map((run) => <Link key={run.id} className="compact-run" to={`/runs/${run.id}`}><span className={`run-state-mark state-${run.status}`} aria-hidden="true" /><span className="compact-run-copy"><strong>{run.task.split(/\r?\n/)[0] || "未命名任务"}</strong><small>{run.category ?? run.phase} · {formatDateTime(run.createdAt)}</small></span><Badge tone={run.status}>{runStatusLabels[run.status] ?? run.status}</Badge><ArrowRight size={15} aria-hidden="true" /></Link>)}</div> : <div className="compact-empty"><Bot size={21} aria-hidden="true" /><span>尚无运行记录</span></div>}</section><section className="surface-panel readiness-panel"><div className="panel-heading"><div><span className="section-label">环境</span><h2>执行环境</h2></div></div><dl className="readiness-list"><div><dt>授权模式</dt><dd><span className="readiness-dot ok" />由 operator 配置</dd></div><div><dt>策略引擎</dt><dd><span className="readiness-dot ok" />已启用</dd></div><div><dt>隔离沙箱</dt><dd><span className="readiness-dot warn" />按需启动</dd></div><div><dt>人工复核</dt><dd><span className="readiness-dot ok" />可用</dd></div></dl></section><section className="surface-panel bank-progress-panel"><div className="panel-heading"><div><span className="section-label">任务集</span><h2>本地任务集</h2></div><Link className="text-link" to="/workbench">打开任务集<ArrowRight size={14} aria-hidden="true" /></Link></div><div className="progress-summary"><strong>{bankProgress}%</strong><span>{solvedQuestions} 项完成，{questionBank?.pendingCount ?? 0} 项待处理</span></div><div className="progress-track" aria-label={`任务集完成度 ${bankProgress}%`}><span style={{ width: `${bankProgress}%` }} /></div><div className="category-summary">{[...(new Set((questionBank?.questions ?? []).map((question) => question.category)))].map((category) => { const items = questionBank?.questions?.filter((item) => item.category === category) ?? []; return <span key={category}><CheckCircle2 size={13} aria-hidden="true" />{category.toUpperCase()} {items.filter((item) => item.status === "solved").length}/{items.length}</span>; })}</div></section></div>
  </div>;
}
