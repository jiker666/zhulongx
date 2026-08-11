import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, Boxes, CheckCircle2, RefreshCw, ShieldCheck, Trophy } from "lucide-react";
import { Link } from "react-router-dom";
import { getExperiences } from "../api/experiences";
import { getArenaStatus, getManualJobs, getQuestionBank } from "../api/operations";
import { getRuns } from "../api/runs";
import { Badge, IconButton } from "../components/ui";
import { formatDateTime } from "../features/decision-stream/formatters";

const activeStatuses = new Set(["queued", "running", "stopping"]);
const runStatusLabels: Record<string, string> = { queued: "排队中", running: "运行中", completed: "已完成", blocked: "等待验证", failed: "失败", aborted: "已中止" };

export function OverviewPage() {
  const arena = useQuery({ queryKey: ["arena-status"], queryFn: ({ signal }) => getArenaStatus(signal), refetchInterval: 5_000 });
  const manual = useQuery({ queryKey: ["manual-jobs"], queryFn: ({ signal }) => getManualJobs(signal), refetchInterval: 5_000 });
  const bank = useQuery({ queryKey: ["question-bank"], queryFn: ({ signal }) => getQuestionBank(signal), refetchInterval: 10_000 });
  const runs = useQuery({ queryKey: ["runs"], queryFn: ({ signal }) => getRuns(signal), refetchInterval: 10_000 });
  const experiences = useQuery({ queryKey: ["experiences"], queryFn: ({ signal }) => getExperiences(signal), refetchInterval: 15_000 });

  const readiness = arena.data?.readiness;
  const runItems = runs.data?.runs ?? [];
  const manualJobs = manual.data?.jobs ?? [];
  const questionBank = bank.data?.questionBank;
  const activeArena = arena.data?.jobs.find((job) => activeStatuses.has(job.status));
  const activeManual = manualJobs.filter((job) => activeStatuses.has(job.status)).length;
  const activeRuns = runItems.filter((run) => run.status === "running" || run.status === "queued").length;
  const completedRuns = runItems.filter((run) => run.status === "completed").length;
  const solvedQuestions = questionBank?.solvedCount ?? 0;
  const totalQuestions = questionBank?.count ?? 0;
  const bankProgress = totalQuestions ? Math.round((solvedQuestions / totalQuestions) * 100) : 0;
  const activeExperiences = (experiences.data?.experiences ?? []).filter((item) => item.status === "active").length;
  const isRefreshing = [arena, manual, bank, runs, experiences].some((query) => query.isFetching);
  const refresh = () => void Promise.all([arena.refetch(), manual.refetch(), bank.refetch(), runs.refetch(), experiences.refetch()]);

  return (
    <div className="page overview-page">
      <div className="page-heading overview-heading">
        <div><div className="eyebrow">COMMAND OVERVIEW</div><h1>系统总览</h1><p>实时汇总执行环境、任务进度与平台验真结果。</p></div>
        <IconButton className="icon-button bordered" label="刷新系统状态" onClick={refresh} disabled={isRefreshing}><RefreshCw size={17} className={isRefreshing ? "spinning" : ""} aria-hidden="true" /></IconButton>
      </div>

      <section className={`readiness-brief ${readiness?.ready ? "ready" : "attention"}`}>
        <div className="brief-mark">{readiness?.ready ? <ShieldCheck size={25} aria-hidden="true" /> : <Boxes size={25} aria-hidden="true" />}</div>
        <div className="brief-copy">
          <span className="section-label">SYSTEM READINESS</span>
          <h2>{readiness ? (readiness.ready ? "控制面已准备就绪" : "控制面需要检查") : "正在确认运行环境"}</h2>
          <p>{readiness?.ready ? `${readiness.model.name} · ${readiness.sandbox.network} 沙箱 · ${readiness.allowedCategories.join(" / ").toUpperCase()} 题型` : readiness?.issues.join("；") || "正在读取模型、沙箱与授权范围状态。"}</p>
        </div>
        <div className="brief-actions">
          <Link className="button" to="/arena"><Trophy size={16} aria-hidden="true" />进入擂台</Link>
          <Link className="button secondary" to="/workbench">提交任务<ArrowRight size={15} aria-hidden="true" /></Link>
        </div>
      </section>

      <section className="command-metrics" aria-label="系统指标">
        <div><span>实时运行</span><strong>{activeRuns + activeManual + (activeArena ? 1 : 0)}</strong><small>ACTIVE WORK</small></div>
        <div><span>完成运行</span><strong>{completedRuns}</strong><small>COMPLETED RUNS</small></div>
        <div><span>题库通过</span><strong>{solvedQuestions}<em>/{totalQuestions}</em></strong><small>VERIFIED</small></div>
        <div><span>验真经验</span><strong>{activeExperiences}</strong><small>ACTIVE LESSONS</small></div>
        <div><span>可用工具</span><strong>{readiness?.sandbox.availablePrograms ?? "—"}</strong><small>ALLOWLISTED</small></div>
      </section>

      <div className="overview-grid">
        <section className="surface-panel recent-runs-panel">
          <div className="panel-heading"><div><span className="section-label">RECENT ACTIVITY</span><h2>最近运行</h2></div><Link className="text-link" to="/runs">查看全部<ArrowRight size={14} aria-hidden="true" /></Link></div>
          {runItems.length ? (
            <div className="compact-run-list">
              {runItems.slice(0, 6).map((run) => (
                <Link key={run.id} className="compact-run" to={`/runs/${run.id}`}>
                  <span className={`run-state-mark state-${run.status}`} aria-hidden="true" />
                  <span className="compact-run-copy"><strong>{run.task.split(/\r?\n/)[0] || "未命名任务"}</strong><small>{run.category ?? run.phase} · {formatDateTime(run.createdAt)}</small></span>
                  <Badge tone={run.status}>{runStatusLabels[run.status] ?? run.status}</Badge>
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              ))}
            </div>
          ) : <div className="compact-empty"><Bot size={21} aria-hidden="true" /><span>尚无运行记录</span></div>}
        </section>

        <section className="surface-panel readiness-panel">
          <div className="panel-heading"><div><span className="section-label">RUNTIME</span><h2>执行环境</h2></div></div>
          <dl className="readiness-list">
            <div><dt>模型服务</dt><dd><span className={`readiness-dot ${readiness?.modelCredentialConfigured ? "ok" : "bad"}`} />{readiness?.model.name ?? "读取中"}</dd></div>
            <div><dt>平台连接</dt><dd><span className={`readiness-dot ${readiness?.arenaCredentialConfigured ? "ok" : "bad"}`} />{readiness?.arenaConfigured ? "Arena 已配置" : "未配置"}</dd></div>
            <div><dt>授权范围</dt><dd><span className={`readiness-dot ${readiness?.scopeControlled ? "ok" : "bad"}`} />{readiness?.scopeControlled ? "Controlled" : "需检查"}</dd></div>
            <div><dt>隔离沙箱</dt><dd><span className={`readiness-dot ${readiness?.sandbox.reachable ? "ok" : "warn"}`} />{readiness?.sandbox.reachable ? "在线" : "按需启动"}</dd></div>
          </dl>
        </section>

        <section className="surface-panel bank-progress-panel">
          <div className="panel-heading"><div><span className="section-label">BENCHMARK</span><h2>本地题库</h2></div><Link className="text-link" to="/workbench">打开题库<ArrowRight size={14} aria-hidden="true" /></Link></div>
          <div className="progress-summary"><strong>{bankProgress}%</strong><span>{solvedQuestions} 题通过，{questionBank?.pendingCount ?? 0} 题待处理</span></div>
          <div className="progress-track" aria-label={`题库完成度 ${bankProgress}%`}><span style={{ width: `${bankProgress}%` }} /></div>
          <div className="category-summary">
            {[...(new Set((questionBank?.questions ?? []).map((question) => question.category)))].map((category) => {
              const categoryItems = questionBank?.questions?.filter((item) => item.category === category) ?? [];
              return <span key={category}><CheckCircle2 size={13} aria-hidden="true" />{category.toUpperCase()} {categoryItems.filter((item) => item.status === "solved").length}/{categoryItems.length}</span>;
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
