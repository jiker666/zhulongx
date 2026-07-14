import { useState } from 'react'
import {
  Activity, Bot, CheckCircle2, ClipboardCheck, Download, FileSearch, GitBranch,
  RefreshCw, Send, ShieldCheck, XCircle,
} from 'lucide-react'
import { type AgentRunProjection } from '../../api'
import { formatDuration } from '../../lib/format'
import { GlowButton, StatePill } from '../ui'

type View = 'plan' | 'agents' | 'knowledge'

interface AgentRunOverviewProps {
  projection: AgentRunProjection
  refreshing: boolean
  onRefresh: () => void
  onHumanAnswer: (answer: string) => Promise<void>
  onExternalValidation: (accepted: boolean) => Promise<void>
  onAudit: () => void
}

const STATUS_TONE: Record<string, 'jade' | 'cyan' | 'ember' | 'crimson' | 'slate' | 'violet'> = {
  completed: 'jade', succeeded: 'jade', running: 'cyan', started: 'cyan', pending: 'slate',
  scheduled: 'violet', blocked: 'ember', failed: 'crimson', cancelled: 'crimson', refuted: 'crimson',
}

export default function AgentRunOverview({
  projection,
  refreshing,
  onRefresh,
  onHumanAnswer,
  onExternalValidation,
  onAudit,
}: AgentRunOverviewProps) {
  const [view, setView] = useState<View>('plan')
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const planNodes = projection.plan.nodes || []
  const latestVerification = projection.verification[projection.verification.length - 1]
  const budgetSeconds = Number(projection.budget.elapsed_seconds || 0)

  const submitAnswer = () => {
    if (!answer.trim()) return
    setSubmitting(true)
    onHumanAnswer(answer.trim()).then(() => setAnswer('')).finally(() => setSubmitting(false))
  }

  return (
    <section className="border-y border-slate-800 bg-obsidian-950/35 py-5" aria-label="Agent Engine v3">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 px-4 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <GitBranch size={18} className="shrink-0 text-cyan-300" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{projection.plan.goal || projection.run_id}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span className="font-mono">{projection.plan.plan_id || 'plan pending'}</span>
              <span>v{projection.plan.version || 0}</span>
              <span>{formatDuration(Math.round(budgetSeconds * 1000))}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatePill tone={STATUS_TONE[projection.state] || 'slate'}>{projection.state}</StatePill>
          <GlowButton variant="ghost" size="sm" onClick={onRefresh} loading={refreshing} title="刷新 Agent 状态">
            <RefreshCw size={14} /> 刷新
          </GlowButton>
          <GlowButton variant="ghost" size="sm" onClick={onAudit} title="导出审计记录">
            <Download size={14} /> 审计
          </GlowButton>
        </div>
      </div>

      <div className="mb-4 flex gap-1 overflow-x-auto px-4 md:px-5" role="tablist" aria-label="Agent run views">
        {([
          ['plan', GitBranch, '计划'],
          ['agents', Bot, 'Agent'],
          ['knowledge', FileSearch, '证据'],
        ] as const).map(([key, Icon, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className={`flex h-9 min-w-24 items-center justify-center gap-2 border-b-2 px-3 text-xs font-semibold transition-colors ${
              view === key ? 'border-cyan-400 text-cyan-200' : 'border-transparent text-slate-500 hover:text-slate-200'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      <div className="px-4 md:px-5">
        {view === 'plan' && (
          <div className="grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
            {planNodes.map((node) => (
              <div key={node.task_id} className="min-h-24 border-l-2 border-slate-700 bg-black/15 px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 text-sm font-medium text-slate-100">{node.title}</div>
                  <StatePill tone={STATUS_TONE[node.status] || 'slate'} className="shrink-0">{node.status}</StatePill>
                </div>
                <div className="mt-2 font-mono text-[11px] text-cyan-300">{node.role}</div>
                <div className="mt-1 truncate text-[11px] text-slate-500">
                  {(node.dependencies || []).length ? `deps: ${node.dependencies?.join(', ')}` : 'root'}
                </div>
                {node.status_reason && <div className="mt-2 break-words text-xs text-ember-200">{node.status_reason}</div>}
              </div>
            ))}
            {planNodes.length === 0 && <div className="py-6 text-sm text-slate-500">等待计划事件</div>}
          </div>
        )}

        {view === 'agents' && (
          <div className="space-y-2">
            {projection.agent_lanes.map((agent) => (
              <div key={agent.agent_id} className="grid min-h-12 grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-3 border-b border-slate-800/80 py-2">
                <Bot size={16} className="text-violet-300" />
                <div className="min-w-0">
                  <div className="truncate text-sm text-slate-100">{agent.task_id}</div>
                  <div className="truncate font-mono text-[11px] text-slate-500">{agent.role} / {agent.agent_id}</div>
                </div>
                <StatePill tone={STATUS_TONE[agent.status] || 'slate'}>{agent.status}</StatePill>
              </div>
            ))}
            {projection.agent_lanes.length === 0 && <div className="py-6 text-sm text-slate-500">当前由主 Agent 执行</div>}
          </div>
        )}

        {view === 'knowledge' && (
          <div className="grid gap-5 lg:grid-cols-3">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-jade-200"><ShieldCheck size={14} /> 事实</div>
              <div className="space-y-2">
                {projection.facts.map((fact) => <div key={fact.fact_id} className="border-l-2 border-jade-500/50 pl-3 text-xs leading-5 text-slate-300">{fact.statement}</div>)}
                {projection.facts.length === 0 && <div className="text-xs text-slate-600">-</div>}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-violet-200"><Activity size={14} /> 假设</div>
              <div className="space-y-2">
                {projection.open_hypotheses.map((item) => <div key={item.hypothesis_id} className="border-l-2 border-violet-500/50 pl-3 text-xs leading-5 text-slate-300">{item.statement}</div>)}
                {projection.open_hypotheses.length === 0 && <div className="text-xs text-slate-600">-</div>}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-cyan-200"><ClipboardCheck size={14} /> 验证</div>
              {latestVerification ? (
                <div className="text-xs leading-5 text-slate-300">
                  <div>{latestVerification.type}</div>
                  <div className="mt-1 text-slate-500">{String(latestVerification.payload.reason || '')}</div>
                </div>
              ) : <div className="text-xs text-slate-600">-</div>}
            </div>
          </div>
        )}
      </div>

      {projection.human_handoff && (
        <div className="mt-5 border-t border-ember-500/20 px-4 pt-4 md:px-5">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-ember-200">
            <Activity size={15} /> {projection.human_handoff.minimal_blocker}
          </div>
          <div className="mb-3 text-xs text-slate-400">{projection.human_handoff.questions[0]?.question}</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submitAnswer() }}
              className="h-10 min-w-0 flex-1 border border-slate-700 bg-black/30 px-3 text-sm text-white outline-none focus:border-cyan-500"
              aria-label="人工回答"
            />
            <GlowButton onClick={submitAnswer} loading={submitting} disabled={!answer.trim()}><Send size={14} /> 回答并恢复</GlowButton>
          </div>
        </div>
      )}

      {projection.state === 'pending_external' && (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-cyan-500/20 px-4 pt-4 md:px-5">
          <GlowButton onClick={() => onExternalValidation(true)}><CheckCircle2 size={14} /> 接受</GlowButton>
          <GlowButton variant="danger" onClick={() => onExternalValidation(false)}><XCircle size={14} /> 驳回并恢复</GlowButton>
        </div>
      )}
    </section>
  )
}
