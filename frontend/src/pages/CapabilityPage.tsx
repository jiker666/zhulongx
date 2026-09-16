import { useQuery } from "@tanstack/react-query";
import { BarChart3, ScrollText } from "lucide-react";
import { getCapability, getDisclosures } from "../api/integrity";
import { Card, EmptyState, ErrorState, LoadingState } from "../components/ui";
import { disclosureReasonLabels, formatDateTime, terminalReasonLabels } from "../features/decision-stream/formatters";
import type { DimensionStat } from "../types/api";

function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function DimensionRow({ dimension }: { dimension: DimensionStat }) {
  const percent = Math.round(dimension.solveRate * 100);
  return (
    <li className="capability-dimension">
      <div className="capability-dimension-head">
        <strong>{dimension.category}</strong>
        <span>{dimension.solved}/{dimension.runs} · {formatRate(dimension.solveRate)}</span>
      </div>
      <div className="capability-bar" role="img" aria-label={`${dimension.category} 解出率 ${percent}%`}>
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="capability-dimension-meta">
        <span>平均回合 {Math.round(dimension.avgTurns)}</span>
        {dimension.avgTurnsSolved !== null && <span>解出 {Math.round(dimension.avgTurnsSolved)} / 未解 {dimension.avgTurnsUnsolved === null ? "—" : Math.round(dimension.avgTurnsUnsolved)}</span>}
        {dimension.failureModes.map((mode) => (
          <span key={mode.reason} className={mode.reason === "none" ? "chip chip-muted" : "chip chip-warn"}>
            {mode.reason === "none" ? "正常结束" : terminalReasonLabels[mode.reason] ?? mode.reason} ×{mode.count}
          </span>
        ))}
      </div>
    </li>
  );
}

export function CapabilityPage() {
  const capability = useQuery({ queryKey: ["capability"], queryFn: ({ signal }) => getCapability(signal) });
  const disclosures = useQuery({ queryKey: ["disclosures"], queryFn: ({ signal }) => getDisclosures(90, signal) });
  if (capability.isPending) return <LoadingState label="正在读取能力台账…" />;
  if (capability.isError) return <ErrorState message={capability.error.message} onRetry={() => void capability.refetch()} />;
  const stats = capability.data;
  return (
    <div className="page capability-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CAPABILITY LEDGER</div>
          <h1>能力与公示</h1>
          <p>按类别统计真实解出率与失败模式，并公示所有与通用性原则不符的操作记录。</p>
        </div>
        <div className="heading-actions">
          <span className="experience-count"><BarChart3 size={16} aria-hidden="true" /><strong>{stats.total}</strong> 次结算运行 · 总解出率 <strong>{formatRate(stats.solveRate)}</strong></span>
        </div>
      </div>

      <div className="capability-ledger-grid">
        <Card className="capability-dimensions-panel">
          <div className="panel-heading">
            <div><span className="section-label">DIMENSIONS</span><h2>维度解出率</h2></div>
            <span className="panel-count">{stats.dimensions.length}</span>
          </div>
          {stats.dimensions.length ? (
            <ul className="capability-dimension-list">
              {stats.dimensions.map((dimension) => <DimensionRow key={dimension.category} dimension={dimension} />)}
            </ul>
          ) : (
            <EmptyState title="暂无已结算运行" description="能力台账在每次运行结算后写入；完成一次任务后这里会出现统计。" />
          )}
          <p className="capability-note">注入规则：某个维度累计 5 次以上结算运行后，弱维度的历史失败模式会作为开局提示注入新运行——只包含类别级统计，不包含任何题目知识。</p>
        </Card>

        <Card className="capability-models-panel">
          <div className="panel-heading">
            <div><span className="section-label">MODEL ATTRIBUTION</span><h2>模型归因</h2></div>
          </div>
          {stats.models.length ? (
            <ul className="capability-model-list">
              {stats.models.map((model) => (
                <li key={model.modelId} className="capability-model-row">
                  <code>{model.modelId}</code>
                  <div className="capability-bar"><i style={{ width: `${model.runs ? Math.round((model.solved / model.runs) * 100) : 0}%` }} /></div>
                  <span>{model.solved}/{model.runs}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="暂无模型记录" description="运行结算且记录了模型 ID 后才会进入归因表。" />
          )}
        </Card>
      </div>

      <Card className="disclosure-panel">
        <div className="panel-heading">
          <div><span className="section-label">DISCLOSURE LEDGER</span><h2>公示墙</h2></div>
          <span className="heading-status"><ScrollText size={14} aria-hidden="true" /><span><strong>{disclosures.data?.total ?? "…"}</strong><small>近 {disclosures.data?.windowDays ?? 90} 天</small></span></span>
        </div>
        {disclosures.isPending ? <p className="muted">正在读取公示记录…</p> : disclosures.isError ? (
          <p className="review-error" role="alert">{disclosures.error.message}</p>
        ) : disclosures.data && disclosures.data.items.length ? (
          <ul className="disclosure-list">
            {disclosures.data.items.map((item) => (
              <li key={item.id} className="disclosure-row">
                <span className="chip chip-warn">{disclosureReasonLabels[item.reason] ?? item.reason}</span>
                <div>
                  <p>{item.detail}</p>
                  <small>
                    {formatDateTime(item.disclosedAt)}
                    {item.runId ? ` · RUN ${item.runId}` : ""}
                    {item.taskId ? ` · TASK ${item.taskId}` : ""}
                    {item.disclosedBy ? ` · ${item.disclosedBy}` : ""}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="无公示记录" description="没有任何内置赛题信息、定向解法或违规外部记忆的记录。" />
        )}
      </Card>
    </div>
  );
}
