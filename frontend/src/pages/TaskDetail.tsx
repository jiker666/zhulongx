import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { confirmStep, denyStep, getTask, getSteps, runTask, Task, Step } from '../api'
import {
  Play, FileText, Loader2, CheckCircle2, XCircle, Clock,
  ChevronDown, ChevronUp, Wifi, WifiOff, RefreshCw, Copy, Check,
} from 'lucide-react'

const STATUS_ICONS: Record<string, React.ReactNode> = {
  success: <CheckCircle2 size={16} className="text-green-400 shrink-0" />,
  failed: <XCircle size={16} className="text-red-400 shrink-0" />,
  skipped: <Clock size={16} className="text-gray-400 shrink-0" />,
  waiting_confirmation: <Clock size={16} className="text-yellow-400 shrink-0" />,
}

const PHASE_COLORS: Record<string, string> = {
  planning: 'text-blue-400 bg-blue-400/10',
  execution: 'text-yellow-400 bg-yellow-400/10',
  reporting: 'text-green-400 bg-green-400/10',
}

const RISK_COLORS: Record<string, string> = {
  high: 'text-red-400 bg-red-400/10',
  medium: 'text-yellow-400 bg-yellow-400/10',
  low: 'text-green-400 bg-green-400/10',
}

const SOURCE_COLORS: Record<string, string> = {
  llm: 'text-purple-400 bg-purple-400/10',
  rule: 'text-cyan-400 bg-cyan-400/10',
  fallback: 'text-orange-400 bg-orange-400/10',
}

const STATUS_LABELS: Record<string, string> = {
  created: '已创建', planning: '规划中', running: '执行中', completed: '已完成', failed: '失败',
  waiting_confirmation: '等待确认',
}
const STATUS_COLORS: Record<string, string> = {
  created: 'text-gray-400', planning: 'text-blue-400',
  running: 'text-yellow-400', completed: 'text-green-400', failed: 'text-red-400',
  waiting_confirmation: 'text-yellow-400',
}

function parseTrace(value?: any): any | null {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const doCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button onClick={doCopy} className="p-1 rounded hover:bg-[#374151] text-gray-500 hover:text-cyan-400 transition-colors">
      {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
    </button>
  )
}

function StepCard({ step }: { step: Step }) {
  const [expanded, setExpanded] = useState(false)
  const trace = parseTrace(step.decision_trace)
  return (
    <div className="bg-[#1f2937]/50 border border-[#374151] rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-[#1f2937]/80 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        {STATUS_ICONS[step.status] || <Clock size={16} className="text-gray-400 shrink-0" />}
        <span className="text-xs font-mono text-gray-500 w-6 shrink-0">#{step.step_index}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${PHASE_COLORS[step.phase] || 'text-gray-400'}`}>
          {step.phase}
        </span>
        <span className="text-sm font-medium text-gray-200 flex-1 min-w-0 truncate">{step.action}</span>
        {step.risk_level && (
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${RISK_COLORS[step.risk_level] || ''}`}>
            {step.risk_level.toUpperCase()}
          </span>
        )}
        {step.plan_source && (
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium shrink-0 ${SOURCE_COLORS[step.plan_source] || ''}`}>
            {step.plan_source}
          </span>
        )}
        <span className="text-xs text-gray-500 shrink-0 hidden sm:block">{step.tool_name}</span>
        {expanded ? <ChevronUp size={14} className="text-gray-500 shrink-0" /> : <ChevronDown size={14} className="text-gray-500 shrink-0" />}
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-2.5 text-sm border-t border-[#374151]">
          <Row label="执行原因" value={step.reason} />
          <Row label="使用工具" value={step.tool_name} />
          <Row label="计划来源" value={step.plan_source || ''} />
          <Row label="风险等级" value={step.risk_level?.toUpperCase() || ''} />
          <Row label="置信度" value={step.confidence !== undefined ? `${(step.confidence * 100).toFixed(0)}%` : ''} />
          <Row label="需人工确认" value={step.requires_confirmation ? '是' : ''} />
          <Row label="输入摘要" value={step.input_summary} />
          <Row label="输出摘要" value={step.output_summary} />
          <Row label="下一步决策" value={step.next_decision} />
          {trace && (
            <div className="pt-2 mt-2 border-t border-[#374151] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">决策审计链</span>
                <CopyBtn text={JSON.stringify(trace, null, 2)} />
              </div>
              <Row label="观察" value={trace.observation || ''} />
              <Row label="证据" value={Array.isArray(trace.evidence) ? trace.evidence.slice(0, 6).join('；') : ''} />
              <Row label="判断" value={trace.hypothesis || ''} />
              <Row label="选择" value={trace.selected_action || ''} />
              <Row label="未选动作" value={Array.isArray(trace.rejected_actions) ? trace.rejected_actions.join('；') : ''} />
              <Row label="安全检查" value={trace.safety_check ? JSON.stringify(trace.safety_check) : ''} />
              <Row label="置信度" value={trace.confidence !== undefined ? `${(Number(trace.confidence) * 100).toFixed(0)}%` : ''} />
              <Row label="可复现" value={trace.reproducibility ? JSON.stringify(trace.reproducibility) : ''} />
              <Row label="结果 Hash" value={trace.reproducibility?.result_hash || ''} />
              {trace.evidence?.length > 0 && (
                <pre className="text-xs text-gray-400 bg-[#111827] border border-[#374151] rounded p-2 whitespace-pre-wrap max-h-40 overflow-auto">
                  {trace.evidence.slice(0, 8).join('\n')}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <span className="text-gray-500 shrink-0 w-20 pt-0.5 text-xs">{label}</span>
      <span className="text-gray-300 text-xs leading-relaxed break-words min-w-0">{value}</span>
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
  const wsFailedRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([getTask(taskId), getSteps(taskId)])
      setTask(t.data)
      setSteps(s.data)
      if (t.data.status === 'completed') setReportReady(true)
    } catch {}
  }, [taskId])

  // Polling fallback
  const startPolling = useCallback(() => {
    if (intervalRef.current) return
    setWsStatus('polling')
    intervalRef.current = setInterval(load, 3000)
  }, [load])

  const stopPolling = () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = undefined
    }
  }

  // WebSocket
  const connectWs = useCallback(() => {
    if (wsRef.current) wsRef.current.close()
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${proto}://${window.location.host}/ws/tasks/${taskId}`
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    setWsStatus('connecting')

    ws.onopen = () => {
      setWsStatus('connected')
      stopPolling()
      wsFailedRef.current = false
    }

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'step_created') {
          setSteps(prev => {
            const exists = prev.find(s => s.step_index === msg.data.step_index)
            if (exists) return prev
            return [...prev, { id: Date.now(), task_id: taskId, created_at: new Date().toISOString(), ...msg.data }]
          })
        } else if (msg.type === 'task_status') {
          setTask(prev => prev ? { ...prev, status: msg.data.status } : prev)
          if (msg.data.status === 'completed') {
            load()
            stopPolling()
          }
        } else if (msg.type === 'report_ready') {
          setReportReady(true)
          load()
        } else if (msg.type === 'task_reset') {
          setSteps([])
          setReportReady(false)
          setTask(prev => prev ? { ...prev, status: msg.data.status } : prev)
        }
      } catch {}
    }

    ws.onclose = () => {
      wsFailedRef.current = true
      setWsStatus('disconnected')
      startPolling()
    }

    ws.onerror = () => {
      wsFailedRef.current = true
      setWsStatus('disconnected')
      ws.close()
      startPolling()
    }
  }, [taskId, load, startPolling])

  useEffect(() => {
    load().finally(() => setLoading(false))
    connectWs()
    return () => {
      wsRef.current?.close()
      stopPolling()
    }
  }, [taskId])

  const handleRun = async () => {
    setRunning(true)
    setSteps([])
    setReportReady(false)
    await runTask(taskId)
    setRunning(false)
    await load()
  }

  const handleConfirm = async () => {
    await confirmStep(taskId)
    await load()
  }

  const handleDeny = async () => {
    await denyStep(taskId)
    await load()
  }

  const copyLog = () => {
    const text = steps.map(s =>
      `#${s.step_index} [${s.phase}] ${s.action} (${s.tool_name})\n` +
      `  原因: ${s.reason}\n` +
      `  输出: ${s.output_summary}\n` +
      `  决策: ${s.next_decision}`
    ).join('\n\n')
    navigator.clipboard.writeText(text)
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-gray-400">
        <Loader2 className="animate-spin" size={18} /> 加载中...
      </div>
    )
  }
  if (!task) return <div className="p-8 text-gray-400">任务不存在</div>

  const isRunning = ['running', 'planning'].includes(task.status)

  const wsLabel: Record<WsStatus, { text: string; cls: string; icon: React.ReactNode }> = {
    connecting: { text: '连接中...', cls: 'text-yellow-400', icon: <Loader2 size={12} className="animate-spin" /> },
    connected: { text: '实时连接中', cls: 'text-green-400', icon: <Wifi size={12} /> },
    disconnected: { text: '实时连接断开，已切换轮询', cls: 'text-orange-400', icon: <WifiOff size={12} /> },
    polling: { text: '轮询模式', cls: 'text-blue-400', icon: <RefreshCw size={12} /> },
  }
  const wsInfo = wsLabel[task.status === 'completed' ? 'connected' : wsStatus]

  return (
    <div className="p-8 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
            <Link to="/tasks" className="hover:text-gray-300">任务列表</Link>
            <span>/</span>
            <span>#{task.id}</span>
          </div>
          <h1 className="text-xl font-bold text-white">{task.title}</h1>
          {task.description && <p className="text-gray-400 text-sm mt-1">{task.description}</p>}
        </div>
        <div className="flex items-center gap-2 ml-4">
          {(task.status === 'created' || task.status === 'failed') && (
            <button
              onClick={handleRun}
              disabled={running}
              className="flex items-center gap-1.5 px-4 py-2 bg-cyan-500 rounded-lg text-sm text-white font-medium hover:bg-cyan-400 disabled:opacity-50"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              运行任务
            </button>
          )}
          {task.status === 'waiting_confirmation' && (
            <>
              <button
                onClick={handleConfirm}
                className="flex items-center gap-1.5 px-4 py-2 bg-yellow-600 rounded-lg text-sm text-white font-medium hover:bg-yellow-500"
              >
                确认步骤
              </button>
              <button
                onClick={handleDeny}
                className="flex items-center gap-1.5 px-4 py-2 bg-red-600 rounded-lg text-sm text-white font-medium hover:bg-red-500"
              >
                拒绝
              </button>
            </>
          )}
          {(task.status === 'completed' || reportReady) && (
            <Link
              to={`/tasks/${task.id}/report`}
              className="flex items-center gap-1.5 px-4 py-2 bg-green-600 rounded-lg text-sm text-white font-medium hover:bg-green-500"
            >
              <FileText size={14} />
              查看报告
            </Link>
          )}
        </div>
      </div>

      {/* Report Ready Banner */}
      {reportReady && task.status !== 'completed' && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg text-sm text-green-400 flex items-center gap-2">
          <CheckCircle2 size={16} /> 报告已生成，点击右上角"查看报告"按钮查看
        </div>
      )}

      {/* Task Info */}
      <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-5 mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <div>
            <div className="text-gray-500 text-xs mb-1">任务类型</div>
            <div className="text-gray-200">{task.task_type}</div>
          </div>
          <div>
            <div className="text-gray-500 text-xs mb-1">状态</div>
            <div className={`font-medium ${STATUS_COLORS[task.status]}`}>
              {isRunning && <Loader2 size={12} className="inline mr-1 animate-spin" />}
              {STATUS_LABELS[task.status] || task.status}
            </div>
          </div>
          <div>
            <div className="text-gray-500 text-xs mb-1">计划来源</div>
            <div className={`text-xs px-1.5 py-0.5 rounded font-medium inline-block ${SOURCE_COLORS[task.plan_source || 'rule'] || 'text-gray-400'}`}>
              {task.plan_source || 'rule'}
              {task.llm_enabled && task.llm_model && (
                <span className="ml-1 text-gray-500">({task.llm_model})</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-gray-500 text-xs mb-1">目标</div>
            <div className="text-gray-200 text-xs truncate">{task.target || '(上传文件)'}</div>
          </div>
          <div>
            <div className="text-gray-500 text-xs mb-1">报告状态</div>
            <div className="text-gray-200 text-xs">{task.report_status || (reportReady ? 'ready' : 'missing')}</div>
          </div>
        </div>
        {task.uploaded_file && (
          <div className="mt-4 text-xs text-gray-500 break-all">
            uploaded_file: <span className="text-gray-300">{task.uploaded_file}</span>
          </div>
        )}
      </div>

      {/* WS Status + Copy */}
      <div className="flex items-center justify-between mb-3">
        <div className={`flex items-center gap-1.5 text-xs ${wsInfo.cls}`}>
          {wsInfo.icon} {task.status === 'completed' ? '任务已完成' : wsInfo.text}
        </div>
        {steps.length > 0 && (
          <button
            onClick={copyLog}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-cyan-400 px-2 py-1 rounded hover:bg-[#1f2937] transition-colors"
          >
            <Copy size={12} /> 复制执行日志
          </button>
        )}
      </div>

      {/* Execution Timeline */}
      <div className="bg-[#111827] border border-[#1f2937] rounded-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#1f2937]">
          <h2 className="font-semibold text-white">执行步骤</h2>
          <span className="text-xs text-gray-500">{steps.length} 个步骤</span>
        </div>
        {steps.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            {isRunning ? (
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="animate-spin" size={16} /> Agent 正在执行中...
              </div>
            ) : (
              '暂无执行步骤，请先运行任务'
            )}
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {steps.map(step => (
              <StepCard key={`${step.id}-${step.step_index}`} step={step} />
            ))}
            {isRunning && (
              <div className="flex items-center gap-2 text-gray-500 text-sm py-2 pl-4">
                <Loader2 className="animate-spin" size={14} /> 正在执行下一步...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
