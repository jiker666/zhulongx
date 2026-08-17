import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Bot, CircleStop, GitBranch, ListChecks, Play, RefreshCw, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import { getCampaigns, startCampaign, stopCampaign } from "../api/operations";
import { Badge, Button, EmptyState, ErrorState, IconButton, LoadingState } from "../components/ui";
import { formatDateTime } from "../features/decision-stream/formatters";
import type { AdaptiveCampaignSnapshot, CampaignWorkStatus } from "../types/api";

const activeStatuses = new Set(["queued", "running"]);
const statusLabels: Record<string, string> = { queued: "排队中", running: "编排中", completed: "已完成", failed: "失败", aborted: "已中止" };
const itemLabels: Record<CampaignWorkStatus, string> = { queued: "待认领", running: "执行中", succeeded: "完成", failed: "失败", blocked: "受阻，准备升级", cancelled: "已取消" };

function splitTasks(value: string): string[] {
  return value.split(/^\s*---\s*$/m).map((item) => item.trim()).filter(Boolean);
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    "campaign.created": "编排器创建了 Campaign",
    "campaign.task.claimed": "一个 Agent 认领了调查任务",
    "campaign.task.queued": "编排器排队了下一层调查",
    "campaign.run.started": "已启动受控运行",
    "campaign.curated": "curator 整理了公开证据",
    "campaign.task.succeeded": "调查任务完成",
    "campaign.task.blocked": "调查受阻，准备升级层级",
    "campaign.task.failed": "调查失败，准备更换路径",
    "campaign.run.verified": "运行出现独立验证证据",
    "campaign.completed": "Campaign 已收敛",
    "campaign.aborted": "Campaign 被停止",
  };
  return labels[type] ?? type;
}

function itemTone(status: CampaignWorkStatus): string {
  if (status === "succeeded") return "completed";
  if (status === "running" || status === "queued") return "running";
  if (status === "blocked") return "blocked";
  return "failed";
}

function CampaignCard({ campaign, onStop, stopping }: { campaign: AdaptiveCampaignSnapshot; onStop: (id: string) => void; stopping: boolean }) {
  const [showEvents, setShowEvents] = useState(false);
  const settled = campaign.items.filter((item) => ["succeeded", "failed", "blocked", "cancelled"].includes(item.status)).length;
  const progress = campaign.items.length ? Math.round((settled / campaign.items.length) * 100) : 0;
  const recentEvents = campaign.events.slice(-8).reverse();
  return (
    <article className="surface-panel campaign-card">
      <div className="campaign-card-heading">
        <div><span className="section-label">CAMPAIGN / {campaign.id.slice(0, 8)}</span><h2>{campaign.name}</h2><p>{formatDateTime(campaign.createdAt)} · {campaign.raceAgents} 条独立探索 lane · 最多 {campaign.concurrency} 个并行 worker</p></div>
        <div className="campaign-card-actions"><Badge tone={campaign.status === "completed" ? "success" : campaign.status === "running" ? "running" : campaign.status === "failed" ? "danger" : "neutral"}>{statusLabels[campaign.status] ?? campaign.status}</Badge>{activeStatuses.has(campaign.status) && <Button className="button danger-button compact-action" loading={stopping} onClick={() => onStop(campaign.id)}><CircleStop size={14} aria-hidden="true" />停止</Button>}</div>
      </div>
      <div className="campaign-progress-copy"><span><strong>{settled}</strong> / {campaign.items.length} 个调查任务已结算</span><span>当前层级：{campaign.tiers[campaign.currentTier]?.label ?? `Tier ${campaign.currentTier}`}</span></div>
      <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
      <div className="campaign-metrics"><span><strong>{campaign.runsStarted}</strong><small>已启动 Run</small></span><span><strong>{campaign.verifiedRuns}</strong><small>独立验证</small></span><span><strong>{campaign.evidence.length}</strong><small>共享证据</small></span><span><strong>{campaign.curation.length}</strong><small>整理轮次</small></span></div>
      <div className="campaign-item-list">
        {campaign.items.map((item) => <div className="campaign-item-row" key={item.id}><span className="campaign-item-index">{String(item.rootIndex + 1).padStart(2, "0")}</span><span className="campaign-item-main"><strong>Tier {item.tier} · lane {item.lane + 1}</strong><small>{item.task.task}</small>{item.summary && <em>{item.summary}</em>}</span><Badge tone={itemTone(item.status)}>{itemLabels[item.status]}</Badge>{item.runId && <Link className="icon-link" to={`/runs/${item.runId}`} title="查看该 Agent 的完整运行轨迹" aria-label="查看该 Agent 的完整运行轨迹"><ArrowRight size={15} /></Link>}</div>)}
      </div>
      <div className="campaign-events-toggle"><Button className="button secondary compact-action" onClick={() => setShowEvents((value) => !value)}><ListChecks size={14} aria-hidden="true" />{showEvents ? "收起编排事件" : `查看最近 ${recentEvents.length} 条编排事件`}</Button></div>
      {showEvents && <div className="campaign-event-list">{recentEvents.map((event) => <div className="campaign-event-row" key={event.id}><span className="campaign-event-marker" /><span><strong>{eventLabel(event.type)}</strong><small>{event.detail ?? "无公开摘要"}{event.runId ? ` · run ${event.runId.slice(0, 8)}` : ""}</small></span><time>{formatDateTime(event.createdAt)}</time></div>)}</div>}
    </article>
  );
}

export function CampaignPage() {
  const queryClient = useQueryClient();
  const [taskText, setTaskText] = useState("");
  const [concurrency, setConcurrency] = useState(2);
  const [raceAgents, setRaceAgents] = useState(2);
  const [formError, setFormError] = useState("");
  const campaigns = useQuery({ queryKey: ["campaigns"], queryFn: ({ signal }) => getCampaigns(signal), refetchInterval: (query) => (query.state.data?.campaigns.some((item) => activeStatuses.has(item.status)) ? 1_500 : 8_000) });
  const start = useMutation({ mutationFn: () => startCampaign({ tasks: splitTasks(taskText), concurrency, raceAgents }, undefined), onSuccess: () => { setTaskText(""); setFormError(""); void queryClient.invalidateQueries({ queryKey: ["campaigns"] }); }, onError: (error) => setFormError(error.message) });
  const stop = useMutation({ mutationFn: (id: string) => stopCampaign(id), onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["campaigns"] }) });
  const tasks = useMemo(() => splitTasks(taskText), [taskText]);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!tasks.length) { setFormError("请输入至少一个调查任务"); return; } if (tasks.length > 64) { setFormError("单个 Campaign 最多 64 个调查任务"); return; } start.mutate(); };
  if (campaigns.isPending) return <LoadingState label="正在读取 Adaptive Campaign…" />;
  if (campaigns.isError) return <ErrorState message={campaigns.error.message} onRetry={() => void campaigns.refetch()} />;
  const records = campaigns.data?.campaigns ?? [];
  return (
    <div className="page campaign-page">
      <div className="page-heading"><div><div className="eyebrow">ADAPTIVE ORCHESTRATION</div><h1>自主编排</h1><p>把一次任务拆成可认领的调查工作，让你看清每个 Agent 正在做什么、为什么升级、得到什么证据。</p></div><IconButton className="icon-button bordered" label="刷新 Campaign" onClick={() => void campaigns.refetch()} disabled={campaigns.isFetching}><RefreshCw size={17} className={campaigns.isFetching ? "spinning" : ""} /></IconButton></div>
      <div className="campaign-layout">
        <form className="surface-panel campaign-composer" onSubmit={submit}><div className="panel-heading"><div><span className="section-label">CAMPAIGN INTAKE</span><h2>启动一次自适应调查</h2></div><GitBranch size={19} aria-hidden="true" /></div><textarea value={taskText} onChange={(event) => { setTaskText(event.target.value); setFormError(""); }} placeholder="输入开放式安全任务；多项任务用单独一行 --- 分隔" aria-label="Campaign 任务" /><div className="campaign-composer-fields"><label><span>并行 worker</span><input type="number" min={1} max={8} value={concurrency} onChange={(event) => setConcurrency(Math.min(8, Math.max(1, Number(event.target.value) || 1)))} /></label><label><span>每题独立 lane</span><input type="number" min={1} max={8} value={raceAgents} onChange={(event) => setRaceAgents(Math.min(8, Math.max(1, Number(event.target.value) || 1)))} /></label><span className="campaign-budget-note"><ShieldCheck size={14} aria-hidden="true" />所有真实动作仍由 PolicyEngine、scope 和沙箱预算控制</span></div>{formError && <div className="inline-error" role="alert">{formError}</div>}<div className="campaign-composer-footer"><span>{tasks.length || 0} 个任务 · 先广度勘察，失败后自动升级到重点分析、独立验证和恢复层</span><Button className="button submit-task-button" type="submit" loading={start.isPending} disabled={Boolean(formError && !tasks.length)}><Play size={15} aria-hidden="true" />启动编排</Button></div></form>
        <section className="surface-panel campaign-explainer"><div className="panel-heading"><div><span className="section-label">HOW TO READ</span><h2>你将看到什么</h2></div><Bot size={19} aria-hidden="true" /></div><div className="campaign-step"><strong>1. 认领</strong><span>每个 lane 领取一个明确调查焦点，避免多个 Agent 重复盲查。</span></div><div className="campaign-step"><strong>2. 观察</strong><span>受控运行把公开结果写回共享证据板，curator 会去重并整理矛盾。</span></div><div className="campaign-step"><strong>3. 升级</strong><span>只有失败或受阻才进入下一层；提示不会提前泄漏给广度探索。</span></div><div className="campaign-step"><strong>4. 回放</strong><span>点击具体 Run 可查看完整模型可见上下文、策略判定和工具结果。</span></div></section>
      </div>
      <div className="section-heading-row campaign-history-heading"><div><span className="section-label">CAMPAIGN HISTORY</span><h2>编排记录</h2></div><span>{records.length} 个 Campaign</span></div>
      {records.length ? <div className="campaign-list">{records.map((campaign) => <CampaignCard key={campaign.id} campaign={campaign} onStop={(id) => stop.mutate(id)} stopping={stop.isPending && stop.variables === campaign.id} />)}</div> : <EmptyState title="尚无编排记录" description="启动一次自适应调查后，每个 Agent 的认领、动作和证据会显示在这里。" />}
      {stop.error && <div className="inline-error" role="alert">{stop.error.message}</div>}
    </div>
  );
}

