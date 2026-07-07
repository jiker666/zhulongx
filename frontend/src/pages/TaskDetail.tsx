import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { confirmStep, denyStep, getTask, getSteps, runTask, type Task, type Step } from '../api'
import {
  Play, FileText, Loader2, CheckCircle2, XCircle, Clock,
  ChevronDown, ChevronUp, Wifi, WifiOff, RefreshCw, Copy, Check,
} from 'lucide-react'
import { statusStyle } from '../styles/tokens'
import { Surface, GlowButton, StatusBadge, SectionHeader, CodeBlock, CopyButton, LoadingState, EmptyState } from '../components/ui'
import { PageHeader } from '../components/layout'

const RISK_STYLE: Record<string, string> = {
  high: 'text-crimson-400 bg-crimson-500/10 border-crimson-500/30',
  medium: 'text-ember-400 bg-ember-500/10 border-ember-500/30',
  low: 'text-jade-400 bg-jade-500/10 border-jade-500/30',
}

const SOURCE_STYLE: Record<string, string> = {
  llm: 'text-violet-400 bg-violet-500/10 border-violet-500/30',
  rule: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/30',
  fallback: 'text-ember-400 bg-ember-500/10 border-ember-500/30',
}

function parseTrace(value?: any): any | null {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

function StepCard({ step }: { step: Step }) {
  const [expanded, setExpanded] = useState(false)
  const trace = parseTrace(step.decision_trace)
  const statusIcon = step.status === 'success' ? <CheckCircle2 size={14} className="text-jade-400" /> :
    step.status === 'failed' ? <XCircle size={14} className="text-crimson-400" /> :
    <Clock size={14} className="text-slate-400" />

  return (
    <Surface variant="panel" className="overflow-hidden">
      <button className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-obsidian-800/40 transition-colors" onClick={() => setExpanded((e) => !e)}>
        {statusIcon}
        <span className="text-xs font-mono text-slate-500 w-6 shrink-0">#{step.step_index}</span>
        <span className="text-xs text-ember-300 uppercase shrink-0">{step.phase}</span>
        <span className="text-sm font-medium text-white flex-1 min-w-0 truncate">{step.action}</span>
        {step.risk_level && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${RISK_STYLE[step.risk_level] || ''}`}>
            {step.risk_level.toUpperCase()}
          </span>
        )}
        {step.plan_source && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${SOURCE_STYLE[step.plan_source] || ''}`}>
            {step.plan_source}
          </span>
        )}
        {expanded ? <ChevronUp size={14} className="text-slate-500 shrink-0" /> : <ChevronDown size={14} className="text-slate-500 shrink-0" />}
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-2 text-xs border-t border-obsidian-600/30">
          <InfoRow label="执行原因" value={step.reason} />
          <InfoRow label="使用工具" value={step.tool_name} />
          <InfoRow label="计划来源" value={step.plan_source || ''} />
          <InfoRow label="风险等级" value={step.risk_level?.toUpperCase() || ''} />
          <InfoRow label="置信度" value={step.confidence !== undefined ? `${(step.confidence * 100).toFixed(0)}%` : ''} />
          <InfoRow label="需人工确认" value={step.requires_confirmation ? '是' : ''} />
          <InfoRow label="输入摘要" value={step.input_summary} />
          <InfoRow label="输出摘要" value={step.output_summary} />
          <InfoRow label="下一步决策" value={step.next_decision} />
          {trace && (
            <div className="pt-2 mt-2 border-t border-obsidian-600/30 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">决策审计链</span>
                <CopyButton text={JSON.stringify(trace, null, 2)} />
              </div>
              <InfoRow label="观察" value={trace.observation || ''} />
              <InfoRow label="判断" value={trace.hypothesis || ''} />
              <InfoRow label="选择" value={trace.selected_action || ''} />
              <InfoRow label="置信度" value={trace.confidence !== undefined ? `${(Number(trace.confidence) * 100).toFixed(0)}%` : ''} />
            </div>
          )}
        </div>
      )}
    </Surface>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <span className="text-slate-500 shrink-0 w-16">{label}</span>
      <span className="text-slate-300 leading-relaxed break-words min-w-0">{value}</span>
    </div>
  )
}

type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'polling'

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>()
  const taskId = Number(id)
  const [task, setTask] = useState<Task | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting')
  const [reportReady, setReportReady] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval>>()

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([getTask(taskId), getSteps(taskId)])
      setTask(t.data); setSteps(s.data)
      if (t.data.status === 'completed') setReportReady(true)
    } catch {}
  }, [taskId])

  const startPolling = useCallback(() => {
    if (intervalRef.current) return
    setWsStatus('polling')
    intervalRef.current = setInterval(load, 3000)
  }, [load])

  const stopPolling = () => { if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = undefined } }

  const connectWs = useCallback(() => {
    if (wsRef.current) wsRef.current.close()
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/tasks/${taskId}`)
    wsRef.current = ws
    setWsStatus('connecting')
    ws.onopen = () => { setWsStatus('connected'); stopPolling() }
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'step_created') {
          setSteps((prev) => { const exists = prev.find((s) => s.step_index === msg.data.step_index); if (exists) return prev; return [...prev, { id: Date.now(), task_id: taskId, created_at: new Date().toISOString(), ...msg.data }] })
        } else if (msg.type === 'task_status') {
          setTask((prev) => prev ? { ...prev, status: msg.data.status } : prev)
          if (msg.data.status === 'completed') { load(); stopPolling() }
        } else if (msg.type === 'report_ready') { setReportReady(true); load() }
        else if (msg.type === 'task_reset') { setSteps([]); setReportReady(false); setTask((prev) => prev ? { ...prev, status: msg.data.status } : prev) }
      } catch {}
    }
    ws.onclose = () => { setWsStatus('disconnected'); startPolling() }
    ws.onerror = () => { setWsStatus('disconnected'); ws.close(); startPolling() }
  }, [taskId, load, startPolling])

  useEffect(() => { load().finally(() => setLoading(false)); connectWs(); return () => { wsRef.current?.close(); stopPolling() } }, [taskId])

  const handleRun = async () => { setRunning(true); setSteps([]); setReportReady(false); await runTask(taskId); setRunning(false); await load() }
  const handleConfirm = async () => { await confirmStep(taskId); await load() }
  const handleDeny = async () => { await denyStep(taskId); await load() }

  const copyLog = () => {
    const text = steps.map((s) => `#${s.step_index} [${s.phase}] ${s.action} (${s.tool_name})\n  原因: ${s.reason}\n  输出: ${s.output_summary}\n  决策: ${s.next_decision}`).join('\n\n')
    navigator.clipboard.writeText(text)
  }

  if (loading) return <LoadingState message="加载任务" />
  if (!task) return <EmptyState title="任务不存在" />

  const isRunning = ['running', 'planning'].includes(task.status)

  const wsInfo = task.status === 'completed'
    ? { text: '任务已完成', cls: 'text-jade-400', icon: <CheckCircle2 size={12} /> }
    : wsStatus === 'connected' ? { text: '实时连接中', cls: 'text-jade-400', icon: <Wifi size={12} /> }
    : wsStatus === 'connecting' ? { text: '连接中...', cls: 'text-ember-400', icon: <Loader2 size={12} className="animate-spin" /> }
    : wsStatus === 'polling' ? { text: '轮询模式', cls: 'text-cyan-400', icon: <RefreshCw size={12} /> }
    : { text: '连接断开', cls: 'text-crimson-400', icon: <WifiOff size={12} /> }

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto">
      <PageHeader
        title={task.title}
        subtitle={task.description}
        action={
          <div className="flex items-center gap-2">
            {(task.status === 'created' || task.status === 'failed') && (
              <GlowButton onClick={handleRun} disabled={running} loading={running} size="sm">
                <Play size={14} /> 运行任务
              </GlowButton>
            )}
            {task.status === 'waiting_confirmation' && (
              <>
                <GlowButton onClick={handleConfirm} size="sm">确认步骤</GlowButton>
                <GlowButton variant="danger" onClick={handleDeny} size="sm">拒绝</GlowButton>
              </>
            )}
            {(task.status === 'completed' || reportReady) && (
              <Link to={`/tasks/${task.id}/report`}>
                <GlowButton variant="secondary" size="sm">
                  <FileText size={14} /> 查看报告
                </GlowButton>
              </Link>
            )}
          </div>
        }
      />

      {reportReady && task.status !== 'completed' && (
        <Surface variant="success" className="mb-4 p-3 flex items-center gap-2 text-sm text-jade-400">
          <CheckCircle2 size={16} /> 报告已生成，点击右上角"查看报告"按钮查看
        </Surface>
      )}

      <Surface variant="panel" className="p-4 mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div><div className="text-slate-500 text-xs mb-1">任务类型</div><div className="text-slate-200">{task.task_type}</div></div>
          <div><div className="text-slate-500 text-xs mb-1">状态</div><StatusBadge state={task.status} pulse={isRunning} /></div>
          <div><div className="text-slate-500 text-xs mb-1">计划来源</div><span className={`text-xs px-1.5 py-0.5 rounded border font-medium inline-block ${SOURCE_STYLE[task.plan_source || 'rule'] || ''}`}>{task.plan_source || 'rule'}{task.llm_enabled && task.llm_model && <span className="ml-1 text-slate-500">({task.llm_model})</span>}</span></div>
          <div><div className="text-slate-500 text-xs mb-1">目标</div><div className="text-slate-200 text-xs truncate">{task.target || '(上传文件)'}</div></div>
        </div>
      </Surface>

      <div className="flex items-center justify-between mb-3">
        <div className={`flex items-center gap-1.5 text-xs ${wsInfo.cls}`}>{wsInfo.icon} {wsInfo.text}</div>
        {steps.length > 0 && (
          <GlowButton variant="ghost" size="sm" onClick={copyLog}>
            <Copy size={12} /> 复制执行日志
          </GlowButton>
        )}
      </div>

      <Surface variant="panel" className="overflow-hidden">
        <div className="px-5 py-3 border-b border-obsidian-600/30 flex items-center justify-between">
          <SectionHeader title="执行步骤" icon={<Play size={14} className="text-ember-400" />} />
          <span className="text-xs text-slate-500 font-mono">{steps.length} 步</span>
        </div>
        {steps.length === 0 ? (
          <EmptyState title={isRunning ? 'Agent 正在执行中...' : '暂无执行步骤'} description={isRunning ? undefined : '请先运行任务'} />
        ) : (
          <div className="p-4 space-y-2">
            {steps.map((step) => <StepCard key={`${step.id}-${step.step_index}`} step={step} />)}
            {isRunning && (
              <div className="flex items-center gap-2 text-slate-500 text-sm py-2 pl-4">
                <Loader2 className="animate-spin" size={14} /> 正在执行下一步...
              </div>
            )}
          </div>
        )}
      </Surface>
    </div>
  )
}
