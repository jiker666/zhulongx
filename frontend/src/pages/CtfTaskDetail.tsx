import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft, Flame, Loader2, Play, Terminal, FileText,
  CheckCircle2, XCircle, Clock, Code, ShieldAlert,
  Download, RefreshCw, AlertCircle, Brain, DollarSign,
  Eye, Upload, Paperclip, Zap, BrainCircuit, Flag,
  Bug, Info, Sparkles, Radio, Shield, Target, X, Square,
} from 'lucide-react'
import {
  ctfGetTask, ctfGetEvents, ctfGetWriteup, ctfSolveTask, ctfStopTask,
  ctfGetBlackboard, ctfAddHint, ctfGetTaskCost, ctfUploadAttachment,
  type CtfTask, type BlackboardSnapshot, type TaskCostSummary,
} from '../api'
import { z, statusStyle, categoryStyle } from '../styles/tokens'
import {
  Surface, GlowButton, StatusBadge, SectionHeader, CodeBlock,
  CopyButton, ProgressRing, EmptyState, LoadingState, ErrorState,
} from '../components/ui'
import { BrandMark } from '../components/brand'
import { PageHeader } from '../components/layout'

interface AgentLiveEvent {
  type: 'agent_live'
  task_id: string
  event_type: 'thinking' | 'action' | 'result' | 'flag' | 'error' | 'info'
  phase: string
  title: string
  detail: string
  code: string
  output: string
  success: boolean | null
  extra: Record<string, any>
  ts: number
}

const EVT_STYLE: Record<string, { icon: React.ReactNode; dot: string; border: string; bg: string; text: string; label: string }> = {
  thinking: { icon: <BrainCircuit size={13} />, dot: 'bg-violet-400', border: 'border-violet-500', bg: 'bg-violet-500/10', text: 'text-violet-300', label: '思考' },
  action:   { icon: <Zap size={13} />,          dot: 'bg-cyan-400',   border: 'border-cyan-500',   bg: 'bg-cyan-500/10',   text: 'text-cyan-300',   label: '行动' },
  result:   { icon: <CheckCircle2 size={13} />,   dot: 'bg-jade-400',  border: 'border-jade-500',  bg: 'bg-jade-500/10',  text: 'text-jade-300',  label: '结果' },
  flag:     { icon: <Flag size={13} />,            dot: 'bg-ember-400', border: 'border-ember-500', bg: 'bg-ember-500/10', text: 'text-ember-300', label: 'Flag' },
  error:    { icon: <Bug size={13} />,             dot: 'bg-crimson-400',border: 'border-crimson-500',bg: 'bg-crimson-500/10',text: 'text-crimson-300',label: '错误' },
  info:     { icon: <Info size={13} />,            dot: 'bg-slate-400', border: 'border-slate-500', bg: 'bg-slate-500/10', text: 'text-slate-300', label: '信息' },
}

const STATE_LABELS: Record<string, string> = {
  INIT: '初始化', CLASSIFY: '题型识别', PLAN: '生成计划',
  ANALYZE_FILES: '附件分析', AGENT_THINK: '🧠 思考中',
  RUN_SHELL: '⚡ 执行命令', GENERATE_SCRIPT: '生成脚本',
  RUN_SCRIPT: '执行脚本', REFLECT_ERROR: '反思修复',
  VERIFY_FLAG: '校验 Flag', GENERATE_WRITEUP: '生成 WP',
  DONE: '已完成', FAILED: '失败', HUMAN_REQUIRED: '需人工接管',
}

function formatTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false })
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-center text-xs">
      <span className="text-slate-500">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} text-slate-200 text-right`}>{value}</span>
    </div>
  )
}

function KindTag({ kind }: { kind: string }) {
  const m: Record<string, string> = {
    candidate: 'bg-jade-500/15 text-jade-400',
    error: 'bg-crimson-500/15 text-crimson-400',
    file: 'bg-cyan-500/15 text-cyan-400',
    clue: 'bg-ember-500/15 text-ember-400',
    tool_result: 'bg-violet-500/15 text-violet-400',
    constraint: 'bg-slate-500/15 text-slate-400',
  }
  return <span className={`inline-block px-1.5 py-0.5 text-[9px] rounded ${m[kind] || 'bg-slate-500/15 text-slate-400'}`}>{kind}</span>
}

function IntentTag({ status }: { status: string }) {
  const m: Record<string, string> = {
    completed: 'bg-jade-500/15 text-jade-400',
    in_progress: 'bg-ember-500/15 text-ember-400',
    failed: 'bg-crimson-500/15 text-crimson-400',
    deprecated: 'bg-slate-500/15 text-slate-500 line-through',
    pending: 'bg-cyan-500/15 text-cyan-400',
  }
  return <span className={`inline-block px-1.5 py-0.5 text-[9px] rounded ${m[status] || 'bg-slate-500/15 text-slate-400'}`}>{status}</span>
}

export default function CtfTaskDetail() {
  const { taskId } = useParams<{ taskId: string }>()
  const [task, setTask] = useState<CtfTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [writeup, setWriteup] = useState<string | null>(null)
  const [showWriteup, setShowWriteup] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [solving, setSolving] = useState(false)
  const [blackboard, setBlackboard] = useState<BlackboardSnapshot | null>(null)
  const [costSummary, setCostSummary] = useState<TaskCostSummary | null>(null)
  const [hintInput, setHintInput] = useState('')
  const [hintSubmitting, setHintSubmitting] = useState(false)
  const [v6Error, setV6Error] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [liveEvents, setLiveEvents] = useState<AgentLiveEvent[]>([])
  const liveLogRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [wsConnected, setWsConnected] = useState(false)

  const refresh = useCallback(() => {
    if (!taskId) return
    setRefreshing(true); setError(null)
    ctfGetTask(taskId)
      .then((r) => setTask(r.data))
      .catch((e) => setError(e?.response?.data?.detail || e.message || '无法加载任务'))
      .finally(() => { setLoading(false); setRefreshing(false) })
    ctfGetBlackboard(taskId).then((r) => setBlackboard(r.data)).catch(() => setBlackboard(null))
    ctfGetTaskCost(taskId).then((r) => setCostSummary(r.data)).catch(() => setCostSummary(null))
  }, [taskId])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!task) return
    if (['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(task.state)) return
    const iv = setInterval(refresh, 1500)
    return () => clearInterval(iv)
  }, [task?.state, refresh])

  useEffect(() => {
    if (!taskId || !task) return
    if (['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(task.state) && wsRef.current) return
    if (wsRef.current) return
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/ctf/${taskId}`)
    wsRef.current = ws
    ws.onopen = () => setWsConnected(true)
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (data.type === 'agent_live') setLiveEvents((p) => [...p.slice(-200), data as AgentLiveEvent])
      } catch {}
    }
    ws.onclose = () => { setWsConnected(false); wsRef.current = null }
    ws.onerror = () => setWsConnected(false)
    const ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('ping') }, 15000)
    return () => { clearInterval(ping); ws.close(); wsRef.current = null }
  }, [taskId, task?.state])

  useEffect(() => {
    if (task && ['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(task.state) && wsRef.current) {
      wsRef.current.close(); wsRef.current = null
    }
  }, [task?.state])

  useEffect(() => { if (liveLogRef.current) liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight }, [liveEvents])

  const handleSolve = () => {
    if (!taskId) return
    setSolving(true)
    ctfSolveTask(taskId, { mode: 'auto', max_rounds: 0, max_time_sec: 600 })
      .then(() => setTimeout(refresh, 200))
      .catch((e) => setError(`启动解题失败: ${e?.response?.data?.detail || e.message}`))
      .finally(() => setSolving(false))
  }

  const [stopping, setStopping] = useState(false)
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
    setHintSubmitting(true); setV6Error(null)
    ctfAddHint(taskId, { content: hintInput.trim(), source: 'human' })
      .then(() => { setHintInput(''); ctfGetBlackboard(taskId).then((r) => setBlackboard(r.data)) })
      .catch((e) => setV6Error(e?.response?.data?.detail || e.message))
      .finally(() => setHintSubmitting(false))
  }

  const fetchWriteup = () => {
    if (!taskId) return
    ctfGetWriteup(taskId)
      .then((r) => { setWriteup(typeof r.data === 'string' ? r.data : (r.data as any)); setShowWriteup(true) })
      .catch((e) => setError(`WP 不可用: ${e?.response?.data?.detail || e.message}`))
  }

  const handleUploadAttachment = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!taskId || !e.target.files) return
    const files = Array.from(e.target.files)
    setUploading(true)
    Promise.all(files.map((f) => ctfUploadAttachment(taskId, f).catch(() => null)))
      .finally(() => { setUploading(false); setTimeout(refresh, 300); e.target.value = '' })
  }

  if (loading) return <LoadingState />
  if (error && !task) return <ErrorState title="作战中枢暂时离线" detail={error} onRetry={refresh} />
  if (!task) return <EmptyState icon={<Target size={32} />} title="任务不存在" />

  const ss = statusStyle(task.is_running ? 'RUNNING' : task.state)
  const cs = categoryStyle(task.plan?.category || task.category_hint || 'misc')
  const isSolved = task.state === 'DONE'
  const isFailed = task.state === 'FAILED'
  const needsHuman = task.state === 'HUMAN_REQUIRED'
  const canSolve = !task.is_running && task.state !== 'DONE'
const canStop = task.is_running && !['DONE','FAILED','HUMAN_REQUIRED'].includes(task.state)

  return (
    <div className="min-h-screen bg-obsidian-950">
      <PageHeader
        title={task.title}
        subtitle={`ID: ${task.task_id}`}
        icon={<BrandMark size={22} className="text-ember-400" />}
        action={
          <div className="flex items-center gap-2">
            <Link to="/ctf">
              <GlowButton variant="ghost" size="sm">
                <ArrowLeft size={14} /> 返回
              </GlowButton>
            </Link>
            <StatusBadge state={task.is_running ? 'RUNNING' : task.state} pulse={task.is_running} label={STATE_LABELS[task.state] || task.state} />
            {canSolve && (
              <GlowButton onClick={handleSolve} disabled={solving} size="sm" loading={solving}>
                <Play size={14} /> 启动解题
              </GlowButton>
            )}
            {canStop && (
              <GlowButton onClick={handleStop} disabled={stopping} size="sm" variant="danger" loading={stopping}>
                <Square size={14} /> 停止
              </GlowButton>
            )}
            <GlowButton variant="secondary" onClick={refresh} size="sm" loading={refreshing}>
              <RefreshCw size={13} /> 刷新
            </GlowButton>
            {task.has_writeup && (
              <GlowButton variant="secondary" onClick={fetchWriteup} size="sm" disabled={!task.has_writeup}>
                <Download size={13} /> 导出 WP
              </GlowButton>
            )}
          </div>
        }
      />

      {error && <ErrorState title="同步失败" detail={error} onRetry={refresh} />}

      <div className="px-6 md:px-8 pb-8">
        {/* Victory / Failure Banner */}
        {isSolved && (
          <Surface variant="success" glow="jade" className="mb-4 p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-jade-500/20 flex items-center justify-center">
              <Flag size={24} className="text-jade-400" />
            </div>
            <div>
              <div className="text-jade-300 font-bold text-lg">攻克成功</div>
              <div className="text-jade-400/70 text-sm font-mono">{task.best_flag}</div>
            </div>
          </Surface>
        )}
        {(isFailed || needsHuman) && (
          <Surface variant="danger" glow="crimson" className="mb-4 p-4 flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-crimson-500/20 flex items-center justify-center">
              <ShieldAlert size={24} className="text-crimson-400" />
            </div>
            <div>
              <div className="text-crimson-300 font-bold">{needsHuman ? '需人工接管' : '攻克失败'}</div>
              <div className="text-crimson-400/70 text-sm">{task.error || 'Agent 未能确定 flag'}</div>
            </div>
          </Surface>
        )}

        {/* Main 3-column grid */}
        <div className="grid grid-cols-12 gap-4">
          {/* LEFT: Task Info + Plan + Attachments */}
          <div className="col-span-12 lg:col-span-3 space-y-4">
            <Surface variant="panel" className="p-4">
              <SectionHeader title="任务情报"><span /></SectionHeader>
              <div className="space-y-2">
                <InfoRow label="题型" value={task.plan?.category || task.category_hint || '—'} />
                <InfoRow label="置信度" value={`${((task.plan?.confidence || 0) * 100).toFixed(0)}%`} mono />
                <InfoRow label="授权" value={task.authorized ? '✓ 已授权' : '✗ 未授权'} />
                <InfoRow label="联网" value={task.allow_network ? '✓ 允许' : '✗ 默认禁用'} />
                <InfoRow label="轮次" value={task.max_rounds > 0 ? `${task.rounds_used} / ${task.max_rounds}` : `${task.rounds_used} (无限)`} mono />
                <InfoRow label="附件" value={`${task.attachments.length}`} mono />
                <InfoRow label="创建" value={formatTime(task.created_at)} mono />
              </div>
              <div className="mt-3 pt-3 border-t border-obsidian-600/40">
                <div className="text-[10px] text-ember-400 uppercase tracking-wider mb-1.5">题面</div>
                <div className="bg-obsidian-950/60 p-3 rounded-lg text-xs text-slate-300 max-h-32 overflow-y-auto leading-relaxed">
                  {task.description || '(无)'}
                </div>
              </div>
            </Surface>

            {task.plan && (
              <Surface variant="panel" className="p-4">
                <SectionHeader title="解题计划" icon={<Flame size={14} className="text-cyan-400" />} />
                <div className="space-y-2 text-xs">
                  <div className="text-slate-400">{task.plan.initial_guess}</div>
                  {task.plan.script_plan.length > 0 && (
                    <div>
                      <div className="text-violet-400 text-[10px] uppercase tracking-wider mb-1">执行计划</div>
                      <ol className="list-decimal list-inside text-slate-300 space-y-0.5">
                        {task.plan.script_plan.map((s, i) => <li key={i}>{s}</li>)}
                      </ol>
                    </div>
                  )}
                  {task.plan.risks.length > 0 && (
                    <div>
                      <div className="text-ember-400 text-[10px] uppercase tracking-wider mb-1">风险</div>
                      <ul className="list-disc list-inside text-slate-400 text-[11px] space-y-0.5">
                        {task.plan.risks.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              </Surface>
            )}

            <Surface variant="panel" className="p-4">
              <SectionHeader title={`附件 · ${task.attachments.length}`} icon={<Paperclip size={14} className="text-ember-400" />} />
              {task.attachments.length > 0 ? (
                <ul className="space-y-1">
                  {task.attachments.map((a, i) => (
                    <li key={i} className="text-xs font-mono text-slate-400 truncate" title={a}>{a.split('/').pop()}</li>
                  ))}
                </ul>
              ) : (
                <div className="text-xs text-slate-500 text-center py-2">暂无附件</div>
              )}
              {canSolve && (
                <label className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-xs bg-ember-500/10 border border-ember-500/30 rounded-lg text-ember-300 cursor-pointer hover:bg-ember-500/20 w-fit">
                  {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  上传附件
                  <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUploadAttachment} />
                </label>
              )}
            </Surface>
          </div>

          {/* MIDDLE: Agent Live + Evidence + Script */}
          <div className="col-span-12 lg:col-span-5 space-y-4">
            <Surface variant="glass" className="p-4" glow={task.is_running ? 'cyan' : undefined}>
              <div className="flex items-center justify-between mb-3">
                <SectionHeader title="Agent 实时思考" icon={<Sparkles size={14} className="text-cyan-400" />} />
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-jade-400 animate-pulse' : 'bg-slate-500'}`} />
                  <span className="text-[10px] text-slate-500">{wsConnected ? '已连接' : '等待连接'}</span>
                  {liveEvents.length > 0 && (
                    <span className="text-[10px] text-slate-500 font-mono">{liveEvents.length} 条</span>
                  )}
                </div>
              </div>
              <div ref={liveLogRef} className="space-y-1 max-h-[360px] overflow-y-auto font-mono text-xs">
                {liveEvents.length === 0 ? (
                  <div className="text-center text-slate-500 text-sm py-6">
                    {task.is_running ? '🧠 Agent 正在启动，思考日志即将推送...' : '等待 Agent 启动后实时推送思考过程'}
                  </div>
                ) : (
                  liveEvents.map((evt, idx) => {
                    const sty = EVT_STYLE[evt.event_type] || EVT_STYLE.info
                    const ts = new Date(evt.ts * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
                    return (
                      <div key={idx} className={`relative pl-7 border-l-2 ${sty.border} pb-1.5`}>
                        <div className={`absolute -left-[7px] top-0.5 w-3 h-3 rounded-full flex items-center justify-center ${sty.bg}`}>
                          {sty.icon}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[9px] text-slate-600 tabular-nums">{ts}</span>
                          <span className={`px-1 py-0 rounded text-[9px] ${sty.bg} ${sty.text}`}>{sty.label}</span>
                          <span className="text-slate-200 font-sans font-semibold text-[11px]">{evt.title}</span>
                          {evt.success !== null && (evt.success ? <CheckCircle2 size={10} className="text-jade-400" /> : <XCircle size={10} className="text-crimson-400" />)}
                        </div>
                        {evt.detail && (
                          <div className="mt-0.5 text-slate-400 whitespace-pre-wrap break-all leading-relaxed font-sans text-[11px]">
                            {evt.detail.length > 600 ? <>{evt.detail.slice(0, 600)}<span className="text-slate-600 cursor-pointer" onClick={(e) => { e.currentTarget.parentElement!.textContent = evt.detail }}> ...</span></> : evt.detail}
                          </div>
                        )}
                        {evt.code && (
                          <div className="mt-1 bg-obsidian-950/80 border border-obsidian-600/40 rounded-lg p-2 text-[10px] text-slate-300 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                            {evt.code.length > 800 ? evt.code.slice(0, 800) + '\n...' : evt.code}
                          </div>
                        )}
                        {evt.output && evt.event_type === 'result' && (
                          <div className="mt-1 bg-obsidian-950/60 border border-obsidian-600/30 rounded-lg p-1.5 text-[10px] whitespace-pre-wrap break-all max-h-28 overflow-y-auto">
                            <span className="text-slate-600">output:</span>{' '}
                            <span className={evt.success ? 'text-slate-300' : 'text-crimson-300'}>
                              {evt.output.length > 600 ? evt.output.slice(0, 600) + '...' : evt.output}
                            </span>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </Surface>

            <Surface variant="panel" className="p-4">
              <SectionHeader title={`推理时间线 · ${task.evidence.length} 步`} icon={<Play size={14} className="text-ember-400" />} />
              <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
                {task.evidence.length === 0 ? (
                  <div className="text-center text-slate-500 text-sm py-4">等待 Agent 启动...</div>
                ) : (
                  task.evidence.map((e, idx) => (
                    <div key={idx} className={`relative pl-5 border-l-2 ${e.success ? 'border-jade-500' : 'border-crimson-500'} pb-1`}>
                      <div className={`absolute -left-[5px] top-1 w-2.5 h-2.5 rounded-full ${e.success ? 'bg-jade-500' : 'bg-crimson-500'} ring-2 ring-obsidian-800`} />
                      <div className="flex items-center gap-1.5">
                        <span className="text-[9px] text-slate-600 font-mono tabular-nums">{formatTime(e.timestamp)}</span>
                        <span className="text-[10px] font-bold text-ember-300 uppercase tracking-wider">{e.step}</span>
                        {e.success ? <CheckCircle2 size={10} className="text-jade-400" /> : <XCircle size={10} className="text-crimson-400" />}
                      </div>
                      <div className="text-[11px] text-slate-400">{e.input_summary}</div>
                    </div>
                  ))
                )}
              </div>
            </Surface>

            {task.current_script && (
              <CodeBlock code={task.current_script} title="当前 solve.py" language="python" className="max-h-72 overflow-y-auto" />
            )}
          </div>

          {/* RIGHT: Flags + Shell + Script Runs + Error */}
          <div className="col-span-12 lg:col-span-4 space-y-4">
            <Surface variant={isSolved ? 'success' : 'panel'} glow={isSolved ? 'jade' : undefined} className="p-4">
              <SectionHeader title="候选 Flag" icon={<Flag size={14} className="text-ember-400" />} />
              {task.best_flag ? (
                <div className="px-3 py-2 bg-jade-500/10 border border-jade-500/30 rounded-lg">
                  <div className="text-[10px] text-jade-300 uppercase mb-1">最佳候选</div>
                  <div className="font-mono text-sm text-jade-200 break-all">{task.best_flag}</div>
                  <CopyButton text={task.best_flag} className="mt-1" />
                </div>
              ) : (
                <div className="text-center text-slate-500 text-xs py-4">{task.state === 'DONE' ? '未提取到 flag' : 'Agent 正在推理...'}</div>
              )}
              {task.candidate_flags.length > 1 && (
                <div className="mt-3 space-y-1">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">其他候选</div>
                  {task.candidate_flags.slice(1, 5).map((c, i) => (
                    <div key={i} className="text-xs font-mono text-slate-400 px-2 py-1 bg-obsidian-950/60 rounded break-all">
                      {c.flag} <span className="text-[10px] text-slate-500">({(c.confidence * 100).toFixed(0)}%)</span>
                    </div>
                  ))}
                </div>
              )}
            </Surface>

            {task.shell_history.length > 0 && (
              <Surface variant="panel" className="p-4">
                <SectionHeader title={`Shell · ${task.shell_history.length} 条`} icon={<Terminal size={14} className="text-cyan-400" />} />
                <div className="space-y-2 max-h-52 overflow-y-auto">
                  {task.shell_history.map((h, i) => (
                    <div key={i} className="bg-obsidian-950/60 rounded-lg p-2 text-xs">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-slate-600 font-mono">$ </span>
                        <span className="text-cyan-300 font-mono break-all">{h.command}</span>
                      </div>
                      {h.exit_code !== null && (
                        <div className="flex items-center gap-2 text-[10px]">
                          <span className={`px-1 py-0.5 rounded font-mono ${h.exit_code === 0 ? 'bg-jade-500/15 text-jade-400' : 'bg-crimson-500/15 text-crimson-400'}`}>
                            exit={h.exit_code}
                          </span>
                          {h.duration_ms > 0 && (
                            <span className="text-slate-500 flex items-center gap-0.5">
                              <Clock size={9} /> {h.duration_ms}ms
                            </span>
                          )}
                        </div>
                      )}
                      {h.stdout && (
                        <div className="font-mono text-[10px] text-slate-400 whitespace-pre-wrap break-all mt-0.5 max-h-16 overflow-y-auto">
                          {h.stdout.slice(0, 300)}{h.stdout.length > 300 ? '...' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Surface>
            )}

            {task.script_runs.length > 0 && (
              <Surface variant="panel" className="p-4">
                <SectionHeader title={`脚本执行 · ${task.script_runs.length} 次`} icon={<Terminal size={14} className="text-ember-400" />} />
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {task.script_runs.map((r, i) => (
                    <div key={i} className="bg-obsidian-950/60 rounded-lg p-2 text-xs">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-slate-500">Run #{i + 1}</span>
                        <span className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${r.success ? 'bg-jade-500/15 text-jade-400' : 'bg-crimson-500/15 text-crimson-400'}`}>
                          exit={r.exit_code}
                        </span>
                        <span className="text-[10px] text-slate-500 flex items-center gap-1">
                          <Clock size={10} /> {r.duration_ms}ms
                        </span>
                        {r.timed_out && <span className="text-[10px] text-ember-400">⏱ timeout</span>}
                      </div>
                      {r.stdout && (
                        <div className="font-mono text-[11px] text-slate-300 whitespace-pre-wrap break-all mb-1">
                          <span className="text-slate-500">stdout:</span> {r.stdout.slice(0, 200)}{r.stdout.length > 200 ? '...' : ''}
                        </div>
                      )}
                      {r.stderr && (
                        <div className="font-mono text-[11px] text-crimson-300 whitespace-pre-wrap break-all">
                          <span className="text-slate-500">stderr:</span> {r.stderr.slice(0, 150)}{r.stderr.length > 150 ? '...' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </Surface>
            )}

            {task.error && !isSolved && (
              <Surface variant="danger" className="p-3 flex items-start gap-2">
                <ShieldAlert size={14} className="text-crimson-400 flex-shrink-0 mt-0.5" />
                <span className="text-xs text-crimson-300">{task.error}</span>
              </Surface>
            )}
          </div>
        </div>

        {/* v6: Blackboard / Cost / Observer */}
        <div className="grid grid-cols-12 gap-4 mt-4">
          <div className="col-span-12 lg:col-span-5">
            <Surface variant="panel" className="p-4">
              <SectionHeader
                title="事实黑板 Blackboard"
                icon={<Brain size={14} className="text-violet-400" />}
              />
              {!blackboard ? (
                <div className="text-xs text-slate-500 text-center py-4">黑板数据不可用</div>
              ) : (
                <div className="space-y-3 max-h-80 overflow-y-auto">
                  {blackboard.facts.length > 0 && (
                    <div>
                      <div className="text-[10px] text-cyan-400 uppercase tracking-wider mb-1.5">事实</div>
                      <div className="space-y-1">
                        {blackboard.facts.slice(0, 20).map((f) => (
                          <div key={f.fact_id} className="bg-obsidian-950/60 rounded-lg px-2 py-1.5 text-xs">
                            <div className="flex items-center gap-2 mb-0.5">
                              <KindTag kind={f.kind} />
                              <span className="text-slate-500 text-[10px]">{f.source_step}</span>
                            </div>
                            <div className="text-slate-300 break-all">{f.content}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {blackboard.intents.length > 0 && (
                    <div>
                      <div className="text-[10px] text-violet-400 uppercase tracking-wider mb-1.5">意图</div>
                      <div className="space-y-1">
                        {blackboard.intents.slice(0, 10).map((i) => (
                          <div key={i.intent_id} className="bg-obsidian-950/60 rounded-lg px-2 py-1.5 text-xs flex items-center gap-2">
                            <IntentTag status={i.status} />
                            <span className="text-slate-300">{i.title}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="text-[10px] text-ember-400 uppercase tracking-wider mb-1.5">提示</div>
                    {blackboard.hints.length > 0 && (
                      <div className="space-y-1 mb-2">
                        {blackboard.hints.slice(0, 10).map((h) => (
                          <div key={h.hint_id} className={`text-xs rounded-lg px-2 py-1.5 ${
                            h.source === 'observer' ? 'bg-violet-500/10 text-violet-200' :
                            h.source === 'human' ? 'bg-ember-500/10 text-ember-200' :
                            'bg-obsidian-950/60 text-slate-300'
                          } ${h.consumed ? 'opacity-50 line-through' : ''}`}>
                            <span className="text-[9px] text-slate-500 mr-1">[{h.source}]</span>
                            {h.content}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={hintInput}
                        onChange={(e) => setHintInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddHint()}
                        placeholder="添加人工提示..."
                        className="flex-1 text-xs bg-obsidian-950/60 border border-obsidian-600/40 rounded-lg px-3 py-1.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-ember-500/40"
                      />
                      <GlowButton onClick={handleAddHint} disabled={hintSubmitting || !hintInput.trim()} size="sm" loading={hintSubmitting}>
                        添加
                      </GlowButton>
                    </div>
                    {v6Error && <div className="text-[10px] text-crimson-400 mt-1">{v6Error}</div>}
                  </div>
                </div>
              )}
            </Surface>
          </div>

          <div className="col-span-12 lg:col-span-4">
            <Surface variant="panel" className="p-4">
              <SectionHeader title="模型成本 Cost" icon={<DollarSign size={14} className="text-ember-400" />} />
              {!costSummary ? (
                <div className="text-xs text-slate-500 text-center py-4">成本数据不可用</div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between px-3 py-2 bg-obsidian-950/60 rounded-lg">
                    <span className="text-xs text-slate-400">本题估算成本</span>
                    <span className={`font-mono font-bold text-sm ${costSummary.budget_exceeded ? 'text-crimson-300' : 'text-jade-300'}`}>
                      ${costSummary.total_cost_usd.toFixed(6)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="px-3 py-2 bg-obsidian-950/60 rounded-lg">
                      <div className="text-[10px] text-slate-500">预算上限</div>
                      <div className="text-slate-200 font-mono text-sm">${costSummary.budget_per_task_usd.toFixed(4)}</div>
                    </div>
                    <div className={`px-3 py-2 rounded-lg ${costSummary.budget_exceeded ? 'bg-crimson-500/10' : 'bg-obsidian-950/60'}`}>
                      <div className="text-[10px] text-slate-500">预算状态</div>
                      <div className={costSummary.budget_exceeded ? 'text-crimson-300 font-bold' : 'text-jade-300'}>{costSummary.budget_exceeded ? '⚠ 超支' : '✓ 正常'}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-1 text-center">
                    <div className="px-2 py-1.5 bg-cyan-500/10 rounded-lg">
                      <div className="text-[9px] text-cyan-300">cheap</div>
                      <div className="text-cyan-200 font-mono text-sm">{costSummary.cheap_calls}</div>
                    </div>
                    <div className="px-2 py-1.5 bg-violet-500/10 rounded-lg">
                      <div className="text-[9px] text-violet-300">expert</div>
                      <div className="text-violet-200 font-mono text-sm">{costSummary.expert_calls}</div>
                    </div>
                    <div className="px-2 py-1.5 bg-slate-500/10 rounded-lg">
                      <div className="text-[9px] text-slate-400">static</div>
                      <div className="text-slate-300 font-mono text-sm">{costSummary.static_only_calls}</div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                    <div className="text-slate-400">输入 tokens: <span className="text-slate-200 font-mono">{costSummary.total_input_tokens}</span></div>
                    <div className="text-slate-400">输出 tokens: <span className="text-slate-200 font-mono">{costSummary.total_output_tokens}</span></div>
                    <div className="text-slate-400">成功: <span className="text-jade-300 font-mono">{costSummary.successful_calls}</span></div>
                    <div className="text-slate-400">失败: <span className="text-crimson-300 font-mono">{costSummary.failed_calls}</span></div>
                    <div className="text-slate-400">缓存命中: <span className="text-ember-300 font-mono">{costSummary.cache_hits}</span></div>
                  </div>
                  {Object.keys(costSummary.by_model).length > 0 && (
                    <div className="pt-2 border-t border-obsidian-600/30">
                      <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1">按模型</div>
                      {Object.entries(costSummary.by_model).map(([m, n]) => (
                        <div key={m} className="flex justify-between text-[11px]">
                          <span className="text-slate-400 font-mono">{m}</span>
                          <span className="text-slate-200 font-mono">{n}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Surface>
          </div>

          <div className="col-span-12 lg:col-span-3">
            <Surface variant="panel" className="p-4">
              <SectionHeader title="Observer 旁路监督" icon={<Eye size={14} className="text-violet-400" />} />
              {!blackboard || blackboard.hints.filter((h) => h.source === 'observer').length === 0 ? (
                <div className="text-xs text-slate-500 text-center py-4">Observer 暂无建议</div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {blackboard.hints.filter((h) => h.source === 'observer').slice(0, 15).map((h) => (
                    <div key={h.hint_id} className={`text-xs bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-1.5 ${h.consumed ? 'opacity-50' : ''}`}>
                      <div className="text-[10px] text-violet-400 mb-0.5">{formatTime(h.created_at)}</div>
                      <div className="text-violet-100 break-all">{h.content}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3 text-[10px] text-slate-500 leading-relaxed">
                Observer 旁路监督循环、跑偏、预算浪费，不直接执行工具
              </div>
            </Surface>
          </div>
        </div>
      </div>

      {/* Writeup Modal */}
      {showWriteup && writeup && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-8" onClick={() => setShowWriteup(false)}>
          <div className="max-w-4xl w-full max-h-[90vh] overflow-y-auto bg-obsidian-900 border border-ember-500/30 rounded-2xl p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-ember-300 flex items-center gap-2">
                <BrandMark size={20} className="text-ember-400" /> 解题报告 WP
              </h3>
              <button onClick={() => setShowWriteup(false)} className="text-slate-400 hover:text-white"><X size={18} /></button>
            </div>
            <CodeBlock code={writeup} language="markdown" />
          </div>
        </div>
      )}
    </div>
  )
}
