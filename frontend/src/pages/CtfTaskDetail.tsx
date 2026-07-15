import { type ChangeEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft, Download, Play, RefreshCw, ShieldAlert, Square, Upload,
} from 'lucide-react'
import {
  ctfAddHint,
  ctfGetBlackboard,
  ctfGetEvents,
  ctfGetTask,
  ctfGetTaskCost,
  ctfGetWriteup,
  ctfSolveTask,
  ctfStopTask,
  ctfUploadAttachment,
  answerAgentRun,
  getAgentRunAudit,
  getAgentRunProjection,
  validateAgentRunExternally,
  type AgentRunProjection,
  type BlackboardSnapshot,
  type CtfTask,
  type TaskCostSummary,
} from '../api'
import {
  AgentDecisionTrace,
  AgentRunOverview,
  FlagCandidateStack,
  ReasoningTimeline,
  RetryReflectionCard,
  SandboxConsole,
  TaskContextPanel,
  type AgentLiveEvent,
} from '../components/ctf'
import { BrandMark } from '../components/brand'
import { CodeBlock, DataEmpty, ErrorState, GlassPanel, GlowButton, LoadingState, StatePill, StatusBadge } from '../components/ui'
import { ctfStateLabel, toneForState } from '../lib/status'
import { formatDuration, formatTime } from '../lib/format'

function normalizeTask(data: CtfTask): CtfTask {
  return {
    ...data,
    shell_history: data.shell_history || [],
    attachments: data.attachments || [],
    script_runs: data.script_runs || [],
    evidence: data.evidence || [],
    candidate_flags: data.candidate_flags || [],
    current_script: data.current_script || '',
    error: data.error || '',
    plan: data.plan ? {
      ...data.plan,
      script_plan: data.plan.script_plan || [],
      risks: data.plan.risks || [],
    } : data.plan,
  }
}

function toLiveEvent(event: CtfTask['evidence'][number], taskId: string): AgentLiveEvent {
  const type = event.type || event.step || 'state.updated'
  const eventType = type === 'candidate.detected' || type === 'candidate.validated'
    ? 'flag'
    : type === 'tool.failed' || type === 'policy.denied' || type === 'run.failed'
      ? 'error'
      : type === 'tool.requested' || type === 'tool.started'
        ? 'action'
        : type === 'tool.finished'
          ? 'result'
          : type.startsWith('model.')
            ? 'thinking'
            : 'info'
  return {
    type: 'agent_live',
    task_id: taskId,
    event_type: eventType,
    phase: type,
    title: type,
    detail: event.output_summary || event.input_summary || '',
    code: '',
    output: '',
    success: event.success,
    extra: event.payload || {},
    ts: event.timestamp,
  }
}

export default function CtfTaskDetail() {
  const { taskId } = useParams<{ taskId: string }>()
  const [task, setTask] = useState<CtfTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [solving, setSolving] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [writeup, setWriteup] = useState<string | null>(null)
  const [showWriteup, setShowWriteup] = useState(false)
  const [blackboard, setBlackboard] = useState<BlackboardSnapshot | null>(null)
  const [costSummary, setCostSummary] = useState<TaskCostSummary | null>(null)
  const [hintInput, setHintInput] = useState('')
  const [hintSubmitting, setHintSubmitting] = useState(false)
  const [hintError, setHintError] = useState<string | null>(null)
  const [liveEvents, setLiveEvents] = useState<AgentLiveEvent[]>([])
  const [streamConnected, setStreamConnected] = useState(false)
  const [agentProjection, setAgentProjection] = useState<AgentRunProjection | null>(null)
  const [agentRefreshing, setAgentRefreshing] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const liveLogRef = useRef<HTMLDivElement>(null)
  const lastSequenceRef = useRef(0)
  const pollingRef = useRef(false)

  const refresh = useCallback(() => {
    if (!taskId) return
    setRefreshing(true)
    setError(null)
    ctfGetTask(taskId)
      .then((response) => {
        const next = normalizeTask(response.data)
        lastSequenceRef.current = next.last_event_sequence || next.evidence.reduce(
          (highest, event) => Math.max(highest, event.sequence || 0),
          0,
        )
        setTask(next)
        setLiveEvents(next.evidence.slice(-200).map((event) => toLiveEvent(event, taskId)))
        setStreamConnected(true)
        if (next.agent_run_id) {
          getAgentRunProjection(next.agent_run_id)
            .then((projection) => setAgentProjection(projection.data))
            .catch(() => setAgentProjection(null))
        } else {
          setAgentProjection(null)
        }
      })
      .catch((e) => setError(e?.response?.data?.detail || e.message || '无法加载任务'))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
    ctfGetBlackboard(taskId).then((response) => setBlackboard(response.data)).catch(() => setBlackboard(null))
    ctfGetTaskCost(taskId).then((response) => setCostSummary(response.data)).catch(() => setCostSummary(null))
  }, [taskId])

  useEffect(() => { refresh() }, [refresh])

  const pollEvents = useCallback(() => {
    if (!taskId || pollingRef.current) return
    pollingRef.current = true
    ctfGetEvents(taskId, lastSequenceRef.current)
      .then((response) => {
        const data = response.data
        lastSequenceRef.current = Math.max(lastSequenceRef.current, data.last_sequence)
        setStreamConnected(true)
        if (data.events.length > 0) {
          setLiveEvents((previous) => [
            ...previous,
            ...data.events.map((event) => toLiveEvent(event, taskId)),
          ].slice(-200))
        }
        setTask((previous) => {
          if (!previous) return previous
          const knownSequences = new Set(previous.evidence.map((event) => event.sequence).filter(Boolean))
          const unseen = data.events.filter((event) => !event.sequence || !knownSequences.has(event.sequence))
          return normalizeTask({
            ...previous,
            state: data.state,
            agent_status: data.agent_status,
            is_running: data.is_running,
            last_event_sequence: data.last_sequence,
            evidence: [...previous.evidence, ...unseen],
            script_runs: data.script_runs,
            shell_history: data.shell_history,
            candidate_flags: data.candidate_flags,
            best_flag: data.best_flag,
            current_script: data.current_script,
          })
        })
        if (task?.agent_run_id) {
          getAgentRunProjection(task.agent_run_id)
            .then((projection) => setAgentProjection(projection.data))
            .catch(() => undefined)
        }
      })
      .catch(() => setStreamConnected(false))
      .finally(() => { pollingRef.current = false })
  }, [taskId, task?.agent_run_id])

  useEffect(() => {
    if (!task || ['DONE', 'FAILED', 'HUMAN_REQUIRED', 'PENDING_EXTERNAL'].includes(task.state)) return
    pollEvents()
    const timer = setInterval(pollEvents, 1000)
    return () => clearInterval(timer)
  }, [pollEvents, task?.state])

  useEffect(() => {
    if (liveLogRef.current) liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight
  }, [liveEvents])

  const handleSolve = () => {
    if (!taskId) return
    setSolving(true)
    ctfSolveTask(taskId, { mode: 'auto', max_rounds: 0, max_time_sec: 600 })
      .then(() => setTimeout(refresh, 200))
      .catch((e) => setError(`启动解题失败: ${e?.response?.data?.detail || e.message}`))
      .finally(() => setSolving(false))
  }

  const handleStop = () => {
    if (!taskId) return
    setStopping(true)
    ctfStopTask(taskId)
      .then(() => setTimeout(refresh, 200))
      .catch((e) => setError(`停止失败: ${e?.response?.data?.detail || e.message}`))
      .finally(() => setStopping(false))
  }

  const handleAddHint = () => {
    if (!taskId || !hintInput.trim()) return
    setHintSubmitting(true)
    setHintError(null)
    ctfAddHint(taskId, { content: hintInput.trim(), source: 'human' })
      .then(() => {
        setHintInput('')
        return ctfGetBlackboard(taskId).then((response) => setBlackboard(response.data))
      })
      .catch((e) => setHintError(e?.response?.data?.detail || e.message))
      .finally(() => setHintSubmitting(false))
  }

  const fetchWriteup = () => {
    if (!taskId) return
    ctfGetWriteup(taskId)
      .then((response) => {
        setWriteup(typeof response.data === 'string' ? response.data : (response.data as any))
        setShowWriteup(true)
      })
      .catch((e) => setError(`WP 不可用: ${e?.response?.data?.detail || e.message}`))
  }

  const handleUploadAttachment = (event: ChangeEvent<HTMLInputElement>) => {
    if (!taskId || !event.target.files) return
    const files = Array.from(event.target.files)
    setUploading(true)
    Promise.all(files.map((file) => ctfUploadAttachment(taskId, file).catch(() => null)))
      .finally(() => {
        setUploading(false)
        setTimeout(refresh, 300)
        event.target.value = ''
      })
  }

  const refreshAgentProjection = () => {
    if (!task?.agent_run_id) return
    setAgentRefreshing(true)
    getAgentRunProjection(task.agent_run_id)
      .then((response) => setAgentProjection(response.data))
      .catch(() => undefined)
      .finally(() => setAgentRefreshing(false))
  }

  const handleHumanAnswer = async (answer: string) => {
    if (!task?.agent_run_id) return
    await answerAgentRun(task.agent_run_id, { answer })
    refreshAgentProjection()
    setTimeout(refresh, 200)
  }

  const handleExternalValidation = async (accepted: boolean) => {
    if (!task?.agent_run_id) return
    await validateAgentRunExternally(
      task.agent_run_id,
      accepted,
      accepted ? 'external judge accepted candidate' : 'external judge rejected candidate',
    )
    refreshAgentProjection()
    setTimeout(refresh, 200)
  }

  const handleAudit = () => {
    if (!task?.agent_run_id) return
    getAgentRunAudit(task.agent_run_id).then((response) => {
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${task.task_id}-agent-audit.json`
      anchor.click()
      URL.revokeObjectURL(url)
    })
  }

  if (loading) return <div className="mx-auto max-w-[1500px] p-6"><LoadingState message="加载单题推理驾驶舱" /></div>
  if (error && !task) return <div className="mx-auto max-w-[1500px] p-6"><ErrorState title="作战中枢暂时离线" detail={error} onRetry={refresh} /></div>
  if (!task) return <div className="mx-auto max-w-[1500px] p-6"><DataEmpty title="任务不存在" description="该任务可能已被删除，或后端暂时不可用。" /></div>

  const canSolve = !task.is_running && !['DONE', 'PENDING_EXTERNAL'].includes(task.state)
  const canStop = task.is_running && !['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(task.state)
  const stateTone = toneForState(task.is_running ? 'RUNNING' : task.state)
  const latestRun = task.script_runs[task.script_runs.length - 1]

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-6 lg:p-8">
      <GlassPanel tone={stateTone} className="p-0">
        <div className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:p-6">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Link to="/ctf">
                <GlowButton variant="ghost" size="sm"><ArrowLeft size={14} /> 返回大厅</GlowButton>
              </Link>
              <StatusBadge state={task.is_running ? 'RUNNING' : task.state} label={ctfStateLabel[task.state] || task.state} pulse={task.is_running} />
              <StatePill tone={task.authorized ? 'jade' : 'ember'}>ScopeGuard {task.authorized ? '授权' : '禁网'}</StatePill>
              <StatePill tone={streamConnected ? 'jade' : 'slate'}>Events {streamConnected ? 'live' : 'standby'}</StatePill>
            </div>
            <div className="flex items-start gap-4">
              <BrandMark size={36} className="mt-1 text-ember-300" />
              <div className="min-w-0">
                <h1 className="text-2xl font-black text-white md:text-4xl">{task.title}</h1>
                <p className="mt-2 break-all font-mono text-xs text-slate-500">ID: {task.task_id}</p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[520px]">
            <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3">
              <div className="text-[11px] text-slate-500">状态更新</div>
              <div className="mt-1 font-mono text-sm text-white">{formatTime(task.updated_at)}</div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3">
              <div className="text-[11px] text-slate-500">证据</div>
              <div className="mt-1 font-mono text-2xl font-bold text-white">{task.evidence.length}</div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3">
              <div className="text-[11px] text-slate-500">耗时</div>
              <div className="mt-1 font-mono text-sm text-white">{latestRun ? formatDuration(latestRun.duration_ms) : '-'}</div>
            </div>
            <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3">
              <div className="text-[11px] text-slate-500">候选</div>
              <div className="mt-1 font-mono text-2xl font-bold text-white">{task.candidate_flags.length + (task.best_flag ? 1 : 0)}</div>
            </div>
            <div className="col-span-2 flex flex-wrap gap-2 sm:col-span-4">
              {canSolve && <GlowButton size="sm" onClick={handleSolve} loading={solving}><Play size={14} /> 启动解题</GlowButton>}
              {canStop && <GlowButton size="sm" variant="danger" onClick={handleStop} loading={stopping}><Square size={14} /> 停止</GlowButton>}
              <GlowButton size="sm" variant="secondary" onClick={refresh} loading={refreshing}><RefreshCw size={13} /> 刷新</GlowButton>
              <GlowButton size="sm" variant="secondary" onClick={fetchWriteup} disabled={!task.has_writeup}><Download size={13} /> WP</GlowButton>
              {canSolve && (
                <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-700/70 bg-obsidian-800/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-obsidian-700">
                  <Upload size={13} /> {uploading ? '上传中' : '附件'}
                  <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUploadAttachment} />
                </label>
              )}
            </div>
          </div>
        </div>
      </GlassPanel>

      {error && <ErrorState title="同步失败" detail={error} onRetry={refresh} />}

      {task.state === 'DONE' && task.best_flag && (
        <GlassPanel tone="jade">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-jade-500/10 text-jade-300">
              <ShieldAlert size={22} />
            </div>
            <div>
              <div className="text-lg font-bold text-jade-100">攻克成功</div>
              <div className="break-all font-mono text-sm text-jade-300">{task.best_flag}</div>
            </div>
          </div>
        </GlassPanel>
      )}

      <RetryReflectionCard task={task} />

      {agentProjection && (
        <AgentRunOverview
          projection={agentProjection}
          refreshing={agentRefreshing}
          onRefresh={refreshAgentProjection}
          onHumanAnswer={handleHumanAnswer}
          onExternalValidation={handleExternalValidation}
          onAudit={handleAudit}
        />
      )}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[320px_minmax(0,1fr)_380px]">
        <TaskContextPanel
          task={task}
          canUpload={canSolve}
          uploading={uploading}
          fileInputRef={fileInputRef}
          onUpload={handleUploadAttachment}
        />
        <ReasoningTimeline task={task} liveEvents={liveEvents} streamConnected={streamConnected} liveLogRef={liveLogRef} />
        <div className="space-y-4">
          <FlagCandidateStack task={task} onWriteup={fetchWriteup} />
          <SandboxConsole task={task} />
        </div>
      </div>

      <AgentDecisionTrace
        blackboard={blackboard}
        costSummary={costSummary}
        hintInput={hintInput}
        hintSubmitting={hintSubmitting}
        error={hintError}
        onHintChange={setHintInput}
        onAddHint={handleAddHint}
      />

      {showWriteup && writeup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="writeup-title" onClick={() => setShowWriteup(false)}>
          <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg border border-ember-500/30 bg-obsidian-900 p-5" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 id="writeup-title" className="flex items-center gap-2 text-lg font-bold text-ember-200">
                <BrandMark size={20} className="text-ember-300" /> 解题报告 WP
              </h2>
              <GlowButton variant="secondary" size="sm" onClick={() => setShowWriteup(false)}>关闭</GlowButton>
            </div>
            <CodeBlock code={writeup} language="markdown" />
          </div>
        </div>
      )}
    </div>
  )
}
