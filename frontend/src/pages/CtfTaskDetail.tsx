import { useEffect, useState, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft,
  Flame,
  Loader2,
  Play,
  Terminal,
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  Code,
  ShieldAlert,
  Download,
  RefreshCw,
  AlertCircle,
} from 'lucide-react'
import {
  ctfGetTask,
  ctfGetEvents,
  ctfGetWriteup,
  ctfSolveTask,
  type CtfTask,
} from '../api'

const STATE_LABELS: Record<string, string> = {
  INIT: '初始化',
  CLASSIFY: '题型识别',
  PLAN: '生成计划',
  ANALYZE_FILES: '附件分析',
  GENERATE_SCRIPT: '生成脚本',
  RUN_SCRIPT: '执行脚本',
  REFLECT_ERROR: '反思修复',
  VERIFY_FLAG: '校验 Flag',
  GENERATE_WRITEUP: '生成 WP',
  DONE: '已完成',
  FAILED: '失败',
  HUMAN_REQUIRED: '需人工接管',
}

const STATE_COLORS: Record<string, string> = {
  INIT: 'text-gray-300 border-gray-500 bg-gray-500/10',
  CLASSIFY: 'text-blue-300 border-blue-500 bg-blue-500/10',
  PLAN: 'text-blue-300 border-blue-500 bg-blue-500/10',
  ANALYZE_FILES: 'text-cyan-300 border-cyan-500 bg-cyan-500/10',
  GENERATE_SCRIPT: 'text-purple-300 border-purple-500 bg-purple-500/10',
  RUN_SCRIPT: 'text-amber-300 border-amber-500 bg-amber-500/10',
  REFLECT_ERROR: 'text-orange-300 border-orange-500 bg-orange-500/10',
  VERIFY_FLAG: 'text-yellow-300 border-yellow-500 bg-yellow-500/10',
  GENERATE_WRITEUP: 'text-teal-300 border-teal-500 bg-teal-500/10',
  DONE: 'text-green-300 border-green-500 bg-green-500/10',
  FAILED: 'text-red-300 border-red-500 bg-red-500/10',
  HUMAN_REQUIRED: 'text-yellow-300 border-yellow-500 bg-yellow-500/10',
}

function formatTime(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false })
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

  const refresh = useCallback(() => {
    if (!taskId) return
    setRefreshing(true)
    setError(null)
    ctfGetTask(taskId)
      .then((r) => {
        setTask(r.data)
      })
      .catch((e) => {
        setError(e?.response?.data?.detail || e.message || '无法加载任务')
      })
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [taskId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Auto-refresh every 1.5s while running
  useEffect(() => {
    if (!task) return
    if (['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(task.state)) return
    const interval = setInterval(refresh, 1500)
    return () => clearInterval(interval)
  }, [task?.state, refresh])

  const handleSolve = () => {
    if (!taskId) return
    setSolving(true)
    ctfSolveTask(taskId, { mode: 'auto', max_rounds: 8 })
      .then(() => {
        // immediately refresh to show running state
        setTimeout(refresh, 200)
      })
      .catch((e) => {
        setError(`启动解题失败: ${e?.response?.data?.detail || e.message}`)
      })
      .finally(() => setSolving(false))
  }

  const fetchWriteup = () => {
    if (!taskId) return
    ctfGetWriteup(taskId)
      .then((r) => {
        setWriteup(typeof r.data === 'string' ? r.data : (r.data as any))
        setShowWriteup(true)
      })
      .catch((e) => setError(`WP 不可用: ${e?.response?.data?.detail || e.message}`))
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0e1a]">
        <Loader2 className="animate-spin text-amber-400" size={32} />
      </div>
    )
  }

  if (error && !task) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] p-6 flex items-center justify-center">
        <div className="max-w-md text-center">
          <AlertCircle className="mx-auto text-red-400 mb-3" size={32} />
          <h2 className="text-lg font-bold text-white mb-2">加载失败</h2>
          <p className="text-sm text-gray-400 mb-4">{error}</p>
          <div className="flex gap-2 justify-center">
            <button
              onClick={refresh}
              className="px-4 py-2 bg-amber-500/10 border border-amber-500/30 text-amber-300 rounded-lg text-sm hover:bg-amber-500/20"
            >
              重试
            </button>
            <Link
              to="/ctf"
              className="px-4 py-2 bg-[#1f2937] border border-[#374151] text-gray-300 rounded-lg text-sm"
            >
              返回 CTF 作战
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (!task) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] p-6">
        <p className="text-gray-400">Task not found.</p>
        <Link to="/ctf" className="text-amber-400 text-sm mt-4 inline-block">
          ← 返回 CTF 作战
        </Link>
      </div>
    )
  }

  const stateColor = STATE_COLORS[task.state] || STATE_COLORS.INIT

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0a0e1a] via-[#0d1426] to-[#0a0e1a] p-4">
      {/* Top Bar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Link
            to="/ctf"
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-[#1f2937] rounded-lg hover:border-amber-500/40"
          >
            <ArrowLeft size={12} className="inline mr-1" /> 返回
          </Link>
          <div>
            <h1 className="text-lg font-bold text-white">{task.title}</h1>
            <p className="text-xs text-gray-500">ID: {task.task_id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-3 py-1 rounded border text-xs font-mono ${stateColor}`}>
            {STATE_LABELS[task.state] || task.state}
            {task.is_running && (
              <Loader2 size={10} className="inline ml-1 animate-spin" />
            )}
          </span>
          {task.state === 'INIT' && !task.is_running && (
            <button
              onClick={handleSolve}
              disabled={solving}
              className="px-3 py-1.5 text-xs bg-amber-500/20 border border-amber-500/40 text-amber-200 rounded-lg hover:bg-amber-500/30 disabled:opacity-50 flex items-center gap-1"
            >
              {solving ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              启动解题
            </button>
          )}
          <button
            onClick={refresh}
            className="px-3 py-1.5 text-xs border border-[#1f2937] rounded-lg text-gray-400 hover:text-white hover:border-amber-500/40 flex items-center gap-1"
          >
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> 刷新
          </button>
          <button
            onClick={fetchWriteup}
            disabled={!task.has_writeup}
            className="px-3 py-1.5 text-xs bg-green-500/10 border border-green-500/30 text-green-300 rounded-lg hover:bg-green-500/20 disabled:opacity-40 flex items-center gap-1"
          >
            <Download size={12} /> 导出 WP
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2 text-red-300 text-sm">
          <AlertCircle size={16} />
          <span className="flex-1">{error}</span>
          <button onClick={refresh} className="text-red-200 underline text-xs">
            重试
          </button>
        </div>
      )}

      {/* Main Grid: 3 columns */}
      <div className="grid grid-cols-12 gap-3">
        {/* LEFT: Task Info + Plan */}
        <div className="col-span-12 lg:col-span-3 space-y-3">
          <Panel title="任务信息" icon={<FileText size={14} />}>
            <div className="text-xs space-y-1">
              <Row label="题型" value={task.plan?.category || task.category_hint} />
              <Row label="置信度" value={`${((task.plan?.confidence || 0) * 100).toFixed(0)}%`} />
              <Row label="授权" value={task.authorized ? '✅ 已授权' : '❌ 未授权'} />
              <Row label="联网" value={task.allow_network ? '✅ 允许' : '❌ 默认禁用'} />
              <Row label="轮次" value={`${task.rounds_used} / ${task.max_rounds}`} />
              <Row label="附件数" value={`${task.attachments.length}`} />
              <Row label="创建时间" value={formatTime(task.created_at)} />
            </div>
            <div className="mt-2 text-xs text-gray-400">
              <div className="text-amber-300 mb-1">题面</div>
              <div className="bg-black/40 p-2 rounded text-gray-300 max-h-32 overflow-y-auto">
                {task.description || '(无)'}
              </div>
            </div>
          </Panel>

          {task.plan && (
            <Panel title="解题计划" icon={<Flame size={14} />}>
              <div className="text-xs space-y-2">
                <div className="text-gray-400">{task.plan.initial_guess}</div>
                {task.plan.script_plan.length > 0 && (
                  <div>
                    <div className="text-purple-300 mb-1 text-[10px] uppercase">执行计划</div>
                    <ol className="list-decimal list-inside text-gray-300 space-y-0.5">
                      {task.plan.script_plan.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                )}
                {task.plan.risks.length > 0 && (
                  <div>
                    <div className="text-orange-300 mb-1 text-[10px] uppercase">风险</div>
                    <ul className="list-disc list-inside text-gray-400 text-[11px] space-y-0.5">
                      {task.plan.risks.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Panel>
          )}

          {task.attachments.length > 0 && (
            <Panel title="附件" icon={<FileText size={14} />}>
              <ul className="text-xs space-y-1">
                {task.attachments.map((a, i) => (
                  <li key={i} className="font-mono text-gray-400 truncate" title={a}>
                    {a.split('/').pop()}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        {/* MIDDLE: Evidence Timeline */}
        <div className="col-span-12 lg:col-span-5 space-y-3">
          <Panel title="Agent 推理时间线" icon={<Play size={14} />} badge={`${task.evidence.length} 步`}>
            <div className="space-y-2 max-h-[480px] overflow-y-auto">
              {task.evidence.length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-8">等待 Agent 启动...</div>
              ) : (
                task.evidence.map((e, idx) => (
                  <div
                    key={idx}
                    className={`relative pl-6 border-l-2 ${
                      e.success ? 'border-green-500' : 'border-red-500'
                    } pb-2`}
                  >
                    <div
                      className={`absolute -left-[7px] top-1 w-3 h-3 rounded-full ${
                        e.success ? 'bg-green-500' : 'bg-red-500'
                      } ring-2 ring-[#0d1426]`}
                    />
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-500 font-mono tabular-nums">
                        {formatTime(e.timestamp)}
                      </span>
                      <span className="text-xs font-bold text-amber-300 uppercase tracking-wider">
                        {e.step}
                      </span>
                      {e.success ? (
                        <CheckCircle size={12} className="text-green-400" />
                      ) : (
                        <XCircle size={12} className="text-red-400" />
                      )}
                    </div>
                    <div className="text-xs text-gray-300 mt-0.5">{e.input_summary}</div>
                  </div>
                ))
              )}
            </div>
          </Panel>

          {/* Current Script */}
          {task.current_script && (
            <Panel title="当前 solve.py" icon={<Code size={14} />}>
              <pre className="text-xs font-mono text-gray-300 bg-black/60 p-3 rounded max-h-72 overflow-auto whitespace-pre-wrap">
                {task.current_script}
              </pre>
            </Panel>
          )}
        </div>

        {/* RIGHT: Flags + Errors */}
        <div className="col-span-12 lg:col-span-4 space-y-3">
          <Panel title="候选 Flag" icon={<CheckCircle size={14} />}>
            {task.best_flag ? (
              <div className="px-3 py-2 bg-green-500/10 border border-green-500/30 rounded">
                <div className="text-[10px] text-green-300 uppercase mb-1">最佳候选</div>
                <div className="font-mono text-sm text-green-200 break-all">{task.best_flag}</div>
              </div>
            ) : (
              <div className="text-center text-gray-500 text-xs py-4">
                {task.state === 'DONE'
                  ? '未提取到 flag'
                  : 'Agent 正在推理...'}
              </div>
            )}
            {task.candidate_flags.length > 1 && (
              <div className="mt-2 space-y-1">
                <div className="text-[10px] text-gray-500 uppercase">其他候选</div>
                {task.candidate_flags.slice(1, 5).map((c, i) => (
                  <div key={i} className="text-xs font-mono text-gray-400 px-2 py-1 bg-black/40 rounded break-all">
                    {c.flag}{' '}
                    <span className="text-[10px] text-gray-500">({(c.confidence * 100).toFixed(0)}%)</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {task.script_runs.length > 0 && (
            <Panel title="脚本执行" icon={<Terminal size={14} />} badge={`${task.script_runs.length} 次`}>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {task.script_runs.map((r, i) => (
                  <div key={i} className="text-xs bg-black/40 rounded p-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-gray-500">Run #{i + 1}</span>
                      <span
                        className={`px-1.5 py-0.5 text-[10px] font-mono rounded ${
                          r.success
                            ? 'bg-green-500/20 text-green-300'
                            : 'bg-red-500/20 text-red-300'
                        }`}
                      >
                        exit={r.exit_code}
                      </span>
                      <span className="text-[10px] text-gray-500 flex items-center gap-1">
                        <Clock size={10} /> {r.duration_ms}ms
                      </span>
                      {r.timed_out && (
                        <span className="text-[10px] text-orange-400">⏱ timeout</span>
                      )}
                    </div>
                    {r.stdout && (
                      <div className="font-mono text-[11px] text-gray-300 whitespace-pre-wrap break-all mb-1">
                        <span className="text-gray-500">stdout:</span>{' '}
                        {r.stdout.slice(0, 200)}
                        {r.stdout.length > 200 ? '...' : ''}
                      </div>
                    )}
                    {r.stderr && (
                      <div className="font-mono text-[11px] text-red-300 whitespace-pre-wrap break-all">
                        <span className="text-gray-500">stderr:</span>{' '}
                        {r.stderr.slice(0, 150)}
                        {r.stderr.length > 150 ? '...' : ''}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {task.error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300 flex items-start gap-2">
              <ShieldAlert size={14} className="flex-shrink-0 mt-0.5" />
              <span>{task.error}</span>
            </div>
          )}

          {task.state === 'HUMAN_REQUIRED' && (
            <div className="px-3 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded text-xs text-yellow-200">
              <div className="font-semibold mb-1">需人工接管</div>
              <p className="text-yellow-200/80">
                Agent 已用尽 {task.max_rounds} 轮仍未能确定 flag。请人工分析附件并提交答案。
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Writeup Modal */}
      {showWriteup && writeup && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur flex items-center justify-center p-8"
          onClick={() => setShowWriteup(false)}
        >
          <div
            className="max-w-4xl w-full max-h-[90vh] overflow-y-auto bg-[#0d1426] border border-amber-500/30 rounded-xl p-6"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-amber-300">解题报告 WP</h3>
              <button
                onClick={() => setShowWriteup(false)}
                className="text-gray-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <pre className="text-xs text-gray-300 whitespace-pre-wrap font-mono">{writeup}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

function Panel({
  title,
  icon,
  badge,
  children,
}: {
  title: string
  icon: React.ReactNode
  badge?: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-[#0d1426]/80 backdrop-blur border border-amber-500/20 rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-amber-300 flex items-center gap-1.5 uppercase tracking-wider">
          {icon}
          {title}
        </h3>
        {badge && <span className="text-[10px] text-gray-500">{badge}</span>}
      </div>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-300 text-right">{value}</span>
    </div>
  )
}
