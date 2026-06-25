import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Flame,
  Activity,
  CheckCircle,
  XCircle,
  Clock,
  Wrench,
  Target,
  TrendingUp,
  Cpu,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react'
import {
  getHealth,
  ctfListTasks,
  ctfBenchmark,
  ctfLlmStatus,
  getTools,
  type HealthStatus,
  type CtfTask,
  type CtfBenchmark,
  type Tool,
} from '../api'

const STATE_COLORS: Record<string, string> = {
  INIT: 'text-gray-300 border-gray-500',
  CLASSIFY: 'text-blue-300 border-blue-500',
  PLAN: 'text-blue-300 border-blue-500',
  ANALYZE_FILES: 'text-cyan-300 border-cyan-500',
  GENERATE_SCRIPT: 'text-purple-300 border-purple-500',
  RUN_SCRIPT: 'text-amber-300 border-amber-500',
  REFLECT_ERROR: 'text-orange-300 border-orange-500',
  VERIFY_FLAG: 'text-yellow-300 border-yellow-500',
  GENERATE_WRITEUP: 'text-teal-300 border-teal-500',
  DONE: 'text-green-300 border-green-500',
  FAILED: 'text-red-300 border-red-500',
  HUMAN_REQUIRED: 'text-yellow-300 border-yellow-500',
}

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
  HUMAN_REQUIRED: '需人工',
}

function MetricCard({
  label,
  value,
  sub,
  icon: Icon,
  glow,
}: {
  label: string
  value: number | string
  sub?: string
  icon: any
  glow: string
}) {
  return (
    <div className="relative bg-gradient-to-br from-[#0d1426] to-[#0a0e1a] border border-amber-500/20 rounded-xl p-5 overflow-hidden group hover:border-amber-500/40 transition-all">
      <div className={`absolute -right-6 -top-6 w-24 h-24 rounded-full blur-2xl opacity-30 ${glow}`} />
      <div className="relative flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400 uppercase tracking-wider">{label}</span>
        <Icon size={18} className="text-amber-400" />
      </div>
      <div className="relative text-3xl font-bold text-white tabular-nums">
        {value}
      </div>
      {sub && <div className="relative text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

function StateBadge({ state }: { state: string }) {
  const color = STATE_COLORS[state] || 'text-gray-300 border-gray-500'
  const label = STATE_LABELS[state] || state
  return (
    <span className={`px-2 py-0.5 text-[10px] uppercase rounded border ${color} bg-black/40`}>
      {label}
    </span>
  )
}

export default function Dashboard() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [tasks, setTasks] = useState<CtfTask[]>([])
  const [bench, setBench] = useState<CtfBenchmark | null>(null)
  const [tools, setTools] = useState<Tool[]>([])
  const [llm, setLlm] = useState<{ mode: string; model: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([getHealth(), ctfListTasks(), ctfBenchmark(), getTools(), ctfLlmStatus()])
      .then(([h, t, b, tl, l]) => {
        setHealth(h.data)
        setTasks(t.data)
        setBench(b.data)
        setTools(tl.data)
        setLlm(l.data)
        setError(null)
      })
      .catch((e) => {
        setError(e?.message || '无法连接后端，请确认后端已启动 (cd backend && python3 -m uvicorn app.main:app --port 8000)')
      })
      .finally(() => setLoading(false))
  }, [])

  const solved = bench?.solved ?? 0
  const total = bench?.total ?? 0
  const successRate = total > 0 ? ((solved / total) * 100).toFixed(0) : '0'
  const avgDuration = bench?.avg_duration_ms ?? 0
  const toolCalls = bench?.tool_calls_total ?? 0

  // Aggregate recent events across all tasks
  const recentEvents = tasks
    .flatMap(t => t.evidence.map(e => ({ ...e, task_id: t.task_id, task_title: t.title })))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 8)

  // Aggregate candidate flags
  const candidates = tasks
    .filter(t => t.best_flag)
    .slice(0, 5)

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0a0e1a] via-[#0d1426] to-[#0a0e1a] p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="relative">
            <div className="absolute inset-0 blur-xl bg-amber-500/40 rounded-full" />
            <Flame className="relative text-amber-400" size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-white tracking-wide">
              烛龙·玄枢
              <span className="ml-2 text-xs text-amber-300/70 tracking-[0.3em] uppercase">
                ZHULONG-X
              </span>
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              面向 CTF 实战的自主决策通用安全智能体 · 烛照隐微，枢决攻防
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="px-3 py-1 bg-amber-500/10 border border-amber-500/30 rounded-full">
              <span className="text-[10px] text-amber-300 uppercase tracking-wider">v5.0</span>
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-400">
          <Activity className="animate-pulse" size={18} /> 加载作战数据中...
        </div>
      ) : error ? (
        <div className="px-4 py-6 bg-red-500/10 border border-red-500/30 rounded-lg flex flex-col items-center gap-3 text-red-300">
          <AlertTriangle size={24} />
          <div className="text-sm">{error}</div>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 bg-red-500/20 border border-red-500/40 rounded text-xs"
          >
            重试
          </button>
        </div>
      ) : (
        <>
          {/* Metrics Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <MetricCard
              label="已解题数"
              value={solved}
              sub={`共 ${total} 个任务`}
              icon={CheckCircle}
              glow="bg-green-500"
            />
            <MetricCard
              label="自动解题成功率"
              value={`${successRate}%`}
              sub={`平均 ${Math.round(avgDuration / 1000)}s`}
              icon={TrendingUp}
              glow="bg-amber-500"
            />
            <MetricCard
              label="工具调用总数"
              value={toolCalls}
              sub={`已注册 ${tools.length} 个工具`}
              icon={Wrench}
              glow="bg-cyan-500"
            />
            <MetricCard
              label="LLM 状态"
              value={llm ? (llm.mode === 'mock' ? 'Mock' : llm.mode === 'live' ? 'Live' : 'Disabled') : 'N/A'}
              sub={llm?.model || health?.llm?.model || '本地推理'}
              icon={Cpu}
              glow="bg-purple-500"
            />
          </div>

          {/* Main Grid */}
          <div className="grid grid-cols-12 gap-4">
            {/* Left: Active Tasks */}
            <div className="col-span-12 lg:col-span-5 bg-[#0d1426]/80 backdrop-blur border border-amber-500/20 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-amber-300 flex items-center gap-2">
                  <Target size={16} /> 当前作战任务
                </h2>
                <Link to="/ctf" className="text-xs text-cyan-400 hover:text-cyan-300">
                  进入 CTF 作战 →
                </Link>
              </div>
              <div className="space-y-2 max-h-[420px] overflow-y-auto">
                {tasks.length === 0 ? (
                  <div className="text-center text-gray-500 text-sm py-12">
                    暂无任务，前往{' '}
                    <Link to="/ctf" className="text-amber-400 underline">
                      CTF 作战
                    </Link>{' '}
                    创建一个
                  </div>
                ) : (
                  tasks.slice(0, 8).map(t => (
                    <Link
                      to={`/ctf/${t.task_id}`}
                      key={t.task_id}
                      className="block px-3 py-2 rounded-lg bg-black/40 hover:bg-amber-500/10 border border-transparent hover:border-amber-500/30 transition-all"
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-white truncate">{t.title}</span>
                        <StateBadge state={t.state} />
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-gray-500">
                        <span>{t.plan?.category || 'unknown'}</span>
                        <span>·</span>
                        <span>{t.rounds_used} 轮</span>
                        {t.best_flag && (
                          <>
                            <span>·</span>
                            <span className="text-green-400 font-mono truncate max-w-[180px]">
                              {t.best_flag}
                            </span>
                          </>
                        )}
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </div>

            {/* Middle: Live Event Stream */}
            <div className="col-span-12 lg:col-span-4 bg-[#0d1426]/80 backdrop-blur border border-cyan-500/20 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-cyan-300 flex items-center gap-2">
                  <Activity size={16} /> 实时推理流
                </h2>
                <span className="text-[10px] text-gray-500">最近 8 条事件</span>
              </div>
              <div className="space-y-1.5 max-h-[420px] overflow-y-auto font-mono">
                {recentEvents.length === 0 ? (
                  <div className="text-center text-gray-500 text-sm py-12">
                    等待 Agent 启动...
                  </div>
                ) : (
                  recentEvents.map((e, idx) => {
                    const time = new Date(e.timestamp * 1000).toLocaleTimeString('zh-CN', { hour12: false })
                    return (
                      <div
                        key={idx}
                        className={`text-xs px-2 py-1 rounded border-l-2 ${
                          e.success
                            ? 'border-green-500 bg-green-500/5'
                            : 'border-red-500 bg-red-500/5'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-gray-500 text-[10px] tabular-nums">{time}</span>
                          <span className="text-cyan-400 uppercase text-[10px] font-bold">{e.step}</span>
                        </div>
                        <div className="text-gray-400 text-[11px] truncate">
                          {e.input_summary || '(no summary)'}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            {/* Right: Best Flags */}
            <div className="col-span-12 lg:col-span-3 bg-[#0d1426]/80 backdrop-blur border border-green-500/20 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-green-300 flex items-center gap-2">
                  <ShieldCheck size={16} /> 候选 Flag
                </h2>
              </div>
              <div className="space-y-2 max-h-[420px] overflow-y-auto">
                {candidates.length === 0 ? (
                  <div className="text-center text-gray-500 text-sm py-12">
                    暂无候选 flag
                  </div>
                ) : (
                  candidates.map(t => (
                    <Link
                      to={`/ctf/${t.task_id}`}
                      key={t.task_id}
                      className="block px-3 py-2 rounded-lg bg-green-500/5 border border-green-500/20 hover:bg-green-500/10"
                    >
                      <div className="text-[10px] text-gray-500 truncate mb-1">{t.title}</div>
                      <div className="text-xs font-mono text-green-300 break-all">
                        {t.best_flag}
                      </div>
                    </Link>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Bottom: Category Stats */}
          {bench && (
            <div className="mt-4 grid grid-cols-2 md:grid-cols-6 gap-3">
              {Object.entries(bench.category_breakdown).map(([cat, stats]) => (
                <div key={cat} className="bg-[#0d1426]/80 border border-amber-500/20 rounded-xl p-3">
                  <div className="text-[10px] text-amber-300 uppercase tracking-wider mb-1">{cat}</div>
                  <div className="text-xl font-bold text-white tabular-nums">
                    {stats.solved}<span className="text-gray-500 text-sm">/{stats.total}</span>
                  </div>
                  <div className="text-[10px] text-gray-500">
                    成功率 {((stats.solved / stats.total) * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Safety Notice */}
          <div className="mt-6 px-4 py-3 bg-yellow-500/5 border border-yellow-500/20 rounded-lg flex items-center gap-2 text-yellow-200/80 text-xs">
            <AlertTriangle size={14} />
            <span>
              烛龙·玄枢 仅用于授权 CTF / 靶场 / 教学 / 合法安全测试。默认禁止访问真实公网目标，
              allow_network 必须配合 authorized=true 才会放行。所有执行均受 ScopeGuard + 沙箱双重限制。
            </span>
          </div>
        </>
      )}
    </div>
  )
}
