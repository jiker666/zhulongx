import { useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, Bot, CheckCircle2, ClipboardCheck, CornerDownRight,
  Download, FileBox, FileSearch, GitBranch, GitCommit, Layers3, Pause, Play,
  RefreshCw, RotateCcw, Send, ShieldCheck, Square, Wrench, XCircle,
} from 'lucide-react'
import { type AgentPlanNode, type AgentRunProjection } from '../../api'
import { formatDuration } from '../../lib/format'
import { GlowButton, StatePill } from '../ui'

type View = 'plan' | 'agents' | 'knowledge'
type Control = 'pause' | 'resume' | 'cancel'
type BranchControl = 'cancel' | 'retry'

interface AgentRunOverviewProps {
  projection: AgentRunProjection
  refreshing: boolean
  onRefresh: () => void
  onHumanAnswer: (answer: Record<string, any>) => Promise<void>
  onExternalValidation: (accepted: boolean) => Promise<void>
  onAudit: () => void
  onControl: (action: Control) => Promise<void>
  onBranchControl: (taskId: string, action: BranchControl) => Promise<void>
}

const STATUS_TONE: Record<string, 'jade' | 'cyan' | 'ember' | 'crimson' | 'slate' | 'violet'> = {
  completed: 'jade', succeeded: 'jade', accepted: 'jade', validated: 'jade',
  running: 'cyan', started: 'cyan', pending_external: 'cyan', ready: 'cyan',
  pending: 'slate', created: 'slate', scheduled: 'violet', human_required: 'ember',
  blocked: 'ember', insufficient: 'ember', failed: 'crimson', rejected: 'crimson',
  cancelled: 'crimson', refuted: 'crimson',
}

function graphLevels(nodes: AgentPlanNode[]) {
  const byId = new Map(nodes.map((node) => [node.task_id, node]))
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (taskId: string): number => {
    if (memo.has(taskId)) return memo.get(taskId) || 0
    if (visiting.has(taskId)) return 0
    visiting.add(taskId)
    const node = byId.get(taskId)
    const dependencies = (node?.dependencies || []).filter((item) => byId.has(item))
    const value = dependencies.length ? Math.max(...dependencies.map(depth)) + 1 : 0
    visiting.delete(taskId)
    memo.set(taskId, value)
    return value
  }
  const levels = new Map<number, AgentPlanNode[]>()
  nodes.forEach((node) => {
    const value = depth(node.task_id)
    levels.set(value, [...(levels.get(value) || []), node])
  })
  return [...levels.entries()].sort(([left], [right]) => left - right)
}

function compactId(value: string) {
  return value.length > 24 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value
}

export default function AgentRunOverview({
  projection,
  refreshing,
  onRefresh,
  onHumanAnswer,
  onExternalValidation,
  onAudit,
  onControl,
  onBranchControl,
}: AgentRunOverviewProps) {
  const [view, setView] = useState<View>('plan')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [controlError, setControlError] = useState('')
  const planNodes = projection.plan.nodes || []
  const levels = useMemo(() => graphLevels(planNodes), [planNodes])
  const criticalPath = useMemo(() => new Set(projection.plan.critical_path || []), [projection.plan.critical_path])
  const revisions = projection.plan_history.filter((item) => item.type === 'plan.revised')
  const latestVerification = projection.verification[projection.verification.length - 1]
  const budgetSeconds = Number(projection.budget.elapsed_seconds || 0)
  const humanQuestions = projection.human_handoff?.questions || []

  const runControl = async (action: Control) => {
    setBusy(`run:${action}`)
    setControlError('')
    try {
      await onControl(action)
    } catch (error: any) {
      setControlError(error?.response?.data?.detail || error?.message || '控制请求失败')
    } finally {
      setBusy('')
    }
  }

  const branchControl = async (taskId: string, action: BranchControl) => {
    setBusy(`${taskId}:${action}`)
    setControlError('')
    try {
      await onBranchControl(taskId, action)
    } catch (error: any) {
      setControlError(error?.response?.data?.detail || error?.message || '分支控制失败')
    } finally {
      setBusy('')
    }
  }

  const submitAnswer = async () => {
    const response = Object.fromEntries(
      humanQuestions.map((question) => [question.id, (answers[question.id] || '').trim()]),
    )
    if (humanQuestions.some((question) => !response[question.id])) return
    setBusy('human')
    setControlError('')
    try {
      await onHumanAnswer(response)
      setAnswers({})
    } catch (error: any) {
      setControlError(error?.response?.data?.detail || error?.message || '人工输入提交失败')
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="border-y border-slate-800 bg-obsidian-950/35 py-5" aria-label="Agent Engine v3">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 px-4 md:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <GitBranch size={18} className="mt-0.5 shrink-0 text-cyan-300" />
          <div className="min-w-0">
            <div className="break-words text-sm font-semibold text-white">{projection.plan.goal || projection.run_id}</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span className="font-mono">{projection.plan.plan_id || 'plan pending'}</span>
              <span>v{projection.plan.version || 0}</span>
              <span>{planNodes.length} nodes</span>
              <span>{formatDuration(Math.round(budgetSeconds * 1000))}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <StatePill tone={STATUS_TONE[projection.state] || 'slate'}>{projection.state}</StatePill>
          {projection.state === 'running' && (
            <GlowButton variant="ghost" size="sm" onClick={() => runControl('pause')} loading={busy === 'run:pause'} title="暂停运行">
              <Pause size={14} /> 暂停
            </GlowButton>
          )}
          {projection.state === 'human_required' && (
            <GlowButton variant="ghost" size="sm" onClick={() => runControl('resume')} loading={busy === 'run:resume'} title="恢复运行">
              <Play size={14} /> 恢复
            </GlowButton>
          )}
          {!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(projection.state) && (
            <GlowButton variant="danger" size="sm" onClick={() => runControl('cancel')} loading={busy === 'run:cancel'} title="取消运行">
              <Square size={13} /> 取消
            </GlowButton>
          )}
          <GlowButton variant="ghost" size="sm" onClick={onRefresh} loading={refreshing} title="刷新 Agent 状态">
            <RefreshCw size={14} /> 刷新
          </GlowButton>
          <GlowButton variant="ghost" size="sm" onClick={onAudit} title="导出审计记录">
            <Download size={14} /> 审计
          </GlowButton>
        </div>
      </div>

      {controlError && (
        <div className="mx-4 mb-4 flex items-start gap-2 border-l-2 border-crimson-500 bg-crimson-500/5 px-3 py-2 text-xs text-crimson-200 md:mx-5">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="break-words">{controlError}</span>
        </div>
      )}

      <div className="mb-4 flex gap-1 overflow-x-auto px-4 md:px-5" role="tablist" aria-label="Agent run views">
        {([
          ['plan', GitBranch, '计划'],
          ['agents', Bot, 'Agent'],
          ['knowledge', FileSearch, '知识'],
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
          <div className="space-y-4">
            <div className="overflow-x-auto pb-2" data-testid="agent-dag-scroll">
              <div className="flex min-w-max items-start gap-3">
                {levels.map(([depth, nodes]) => (
                  <div key={depth} className="w-[250px] shrink-0">
                    <div className="mb-2 flex h-7 items-center gap-2 border-b border-slate-800 text-[11px] font-semibold text-slate-500">
                      <Layers3 size={13} /> Stage {depth + 1}
                    </div>
                    <div className="space-y-2">
                      {nodes.map((node) => {
                        const isCritical = criticalPath.has(node.task_id)
                        const canCancel = ['pending', 'ready', 'running', 'scheduled'].includes(node.status)
                        const canRetry = ['blocked', 'failed', 'cancelled'].includes(node.status)
                        return (
                          <article
                            key={node.task_id}
                            className={`min-h-[150px] rounded-md border bg-black/15 p-3 ${isCritical ? 'border-ember-500/50' : 'border-slate-800'}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 break-words text-sm font-medium text-slate-100">{node.title}</div>
                              <StatePill tone={STATUS_TONE[node.status] || 'slate'} className="shrink-0">{node.status}</StatePill>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px]">
                              <span className="text-cyan-300">{node.role}</span>
                              <span className="text-slate-500">P{node.priority ?? 0}</span>
                              <span className="text-slate-500">try {node.attempt ?? 1}</span>
                              {isCritical && <span className="text-ember-300">critical</span>}
                            </div>
                            <div className="mt-2 min-h-8 space-y-1 text-[11px] text-slate-500">
                              {(node.dependencies || []).length ? node.dependencies?.map((dependency) => (
                                <div key={dependency} className="flex items-start gap-1.5">
                                  <CornerDownRight size={12} className="mt-0.5 shrink-0" />
                                  <span className="break-all font-mono">{compactId(dependency)}</span>
                                </div>
                              )) : <span>root</span>}
                            </div>
                            {node.status_reason && <div className="mt-2 break-words text-xs text-ember-200">{node.status_reason}</div>}
                            {(canCancel || canRetry) && (
                              <div className="mt-3 flex justify-end gap-1 border-t border-slate-800 pt-2">
                                {canRetry && (
                                  <button
                                    type="button"
                                    onClick={() => branchControl(node.task_id, 'retry')}
                                    disabled={busy !== ''}
                                    className="inline-flex h-8 w-8 items-center justify-center text-slate-500 hover:text-cyan-200 disabled:opacity-40"
                                    title="重新执行分支"
                                    aria-label={`重新执行 ${node.title}`}
                                  >
                                    <RotateCcw size={14} className={busy === `${node.task_id}:retry` ? 'animate-spin' : ''} />
                                  </button>
                                )}
                                {canCancel && (
                                  <button
                                    type="button"
                                    onClick={() => branchControl(node.task_id, 'cancel')}
                                    disabled={busy !== ''}
                                    className="inline-flex h-8 w-8 items-center justify-center text-slate-500 hover:text-crimson-300 disabled:opacity-40"
                                    title="取消分支"
                                    aria-label={`取消 ${node.title}`}
                                  >
                                    <XCircle size={15} />
                                  </button>
                                )}
                              </div>
                            )}
                          </article>
                        )
                      })}
                    </div>
                  </div>
                ))}
                {planNodes.length === 0 && <div className="w-full py-6 text-sm text-slate-500">等待计划事件</div>}
              </div>
            </div>

            {revisions.length > 0 && (
              <div className="border-t border-slate-800 pt-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-violet-200">
                  <GitCommit size={14} /> Plan revisions
                </div>
                <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
                  {revisions.slice().reverse().map((revision) => (
                    <details key={revision.event_id} className="rounded-md border border-slate-800 bg-black/10 px-3 py-2">
                      <summary className="cursor-pointer text-xs text-slate-300">
                        v{revision.old_version || '?'} to v{revision.new_version || revision.plan?.version || '?'}: {revision.reason}
                      </summary>
                      <div className="mt-2 space-y-1 font-mono text-[11px] text-slate-500">
                        {(revision.diff || []).map((item, index) => (
                          <div key={`${revision.event_id}-${index}`} className="break-all">
                            {String(item.operation || 'change')} {String(item.task_id || item.replacement_task_id || '')}
                          </div>
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {view === 'agents' && (
          <div className="divide-y divide-slate-800/80">
            {projection.agent_lanes.map((agent) => {
              const tokens = Number(agent.usage?.total_tokens || agent.budget?.tokens || 0)
              return (
                <div key={agent.agent_id} className="grid min-h-20 gap-2 py-3 sm:grid-cols-[28px_minmax(0,1.2fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-3">
                  <Bot size={17} className="hidden text-violet-300 sm:block" />
                  <div className="min-w-0">
                    <div className="break-words text-sm text-slate-100">{agent.task_id}</div>
                    <div className="mt-1 break-all font-mono text-[11px] text-slate-500">
                      {agent.role} / {compactId(agent.agent_id)}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-600">parent {agent.parent_agent_id || 'root'}</div>
                  </div>
                  <div className="min-w-0 text-[11px] text-slate-400">
                    {agent.active_tool ? (
                      <div className="flex items-center gap-2 text-cyan-200"><Wrench size={13} className="animate-pulse" /> {agent.active_tool}</div>
                    ) : agent.last_tool ? (
                      <div className="flex items-center gap-2"><Wrench size={13} /> {agent.last_tool}</div>
                    ) : <div>tool idle</div>}
                    <div className="mt-1 font-mono text-slate-500">{tokens.toLocaleString()} tokens</div>
                    {(agent.handoff_summary || agent.decision_summary) && (
                      <div className="mt-1 line-clamp-2 break-words text-slate-500">{agent.handoff_summary || agent.decision_summary}</div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2 sm:block sm:text-right">
                    <StatePill tone={STATUS_TONE[agent.status] || 'slate'}>{agent.status}</StatePill>
                    {agent.verdict && <div className="mt-1 text-[11px] text-jade-300">{agent.verdict}</div>}
                  </div>
                </div>
              )
            })}
            {projection.agent_lanes.length === 0 && <div className="py-6 text-sm text-slate-500">当前由主 Agent 执行</div>}
          </div>
        )}

        {view === 'knowledge' && (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-jade-200"><ShieldCheck size={14} /> 事实</div>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {projection.facts.map((fact) => (
                  <div key={fact.fact_id} className="border-l-2 border-jade-500/50 pl-3 text-xs leading-5 text-slate-300">
                    <div>{fact.statement}</div>
                    {(fact.evidence_ids || []).length > 0 && <div className="mt-1 break-all font-mono text-[10px] text-slate-600">{fact.evidence_ids?.join(', ')}</div>}
                  </div>
                ))}
                {projection.facts.length === 0 && <div className="text-xs text-slate-600">-</div>}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-violet-200"><Activity size={14} /> 假设</div>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {projection.open_hypotheses.map((item) => (
                  <div key={item.hypothesis_id} className="border-l-2 border-violet-500/50 pl-3 text-xs leading-5 text-slate-300">{item.statement}</div>
                ))}
                {projection.failed_hypotheses.map((item) => (
                  <div key={item.hypothesis_id} className="border-l-2 border-crimson-500/50 pl-3 text-xs leading-5 text-slate-500 line-through">{item.statement}</div>
                ))}
                {projection.open_hypotheses.length + projection.failed_hypotheses.length === 0 && <div className="text-xs text-slate-600">-</div>}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-cyan-200"><ClipboardCheck size={14} /> 证据</div>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {projection.evidence.map((item) => (
                  <div key={item.evidence_id} className="text-xs leading-5 text-slate-300">
                    <div>{item.summary}</div>
                    <div className="break-all font-mono text-[10px] text-slate-600">{item.evidence_id}</div>
                  </div>
                ))}
                {projection.artifacts.map((item, index) => (
                  <div key={item.artifact_id || index} className="flex items-start gap-2 text-xs text-slate-400">
                    <FileBox size={13} className="mt-0.5 shrink-0" />
                    <span className="break-all">{item.original_name || item.storage_path || item.artifact_id}</span>
                  </div>
                ))}
                {projection.evidence.length + projection.artifacts.length === 0 && <div className="text-xs text-slate-600">-</div>}
              </div>
            </div>
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-ember-200"><CheckCircle2 size={14} /> 复核</div>
              {latestVerification ? (
                <div className="text-xs leading-5 text-slate-300">
                  <div>{latestVerification.type}</div>
                  <div className="mt-1 break-words text-slate-500">{String(latestVerification.payload.reason || '')}</div>
                  {latestVerification.payload.level && <div className="mt-1 font-mono text-[10px] text-slate-600">{String(latestVerification.payload.level)}</div>}
                </div>
              ) : <div className="text-xs text-slate-600">-</div>}
              <div className="mt-3 space-y-2">
                {projection.agent_lanes.filter((agent) => agent.verdict).map((agent) => (
                  <div key={agent.agent_id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-slate-400">{agent.task_id}</span>
                    <StatePill tone={STATUS_TONE[agent.verdict || ''] || 'slate'}>{agent.verdict}</StatePill>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {projection.human_handoff && (
        <div className="mt-5 border-t border-ember-500/20 px-4 pt-4 md:px-5">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-ember-200">
            <Activity size={15} /> {projection.human_handoff.minimal_blocker}
          </div>
          <div className="space-y-3">
            {humanQuestions.map((question) => (
              <label key={question.id} className="block">
                <span className="mb-1 block text-xs text-slate-400">{question.question}</span>
                {question.choices?.length ? (
                  <select
                    value={answers[question.id] || ''}
                    onChange={(event) => setAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))}
                    className="input h-10"
                  >
                    <option value="">选择</option>
                    {question.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                  </select>
                ) : (
                  <input
                    value={answers[question.id] || ''}
                    onChange={(event) => setAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))}
                    onKeyDown={(event) => { if (event.key === 'Enter') submitAnswer() }}
                    className="input h-10"
                  />
                )}
              </label>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <GlowButton
              onClick={submitAnswer}
              loading={busy === 'human'}
              disabled={humanQuestions.some((question) => !(answers[question.id] || '').trim())}
            >
              <Send size={14} /> 提交并恢复
            </GlowButton>
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
