import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CheckCircle, TrendingUp, Wrench, Cpu, Target, Activity, ShieldCheck, AlertTriangle,
} from 'lucide-react'
import {
  getHealth, ctfListTasks, ctfBenchmark, ctfLlmStatus, getTools,
  type HealthStatus, type CtfTask, type CtfBenchmark, type Tool, type LlmStatus,
} from '../api'
import { ZhulongLogo } from '../components/brand'
import { AgentOrbit } from '../components/visual'
import { Surface, StatusBadge, MetricCard, SectionHeader, EmptyState, ErrorState, LoadingState } from '../components/ui'
import { categoryStyle, statusStyle } from '../styles/tokens'

export default function Dashboard() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [tasks, setTasks] = useState<CtfTask[]>([])
  const [bench, setBench] = useState<CtfBenchmark | null>(null)
  const [tools, setTools] = useState<Tool[]>([])
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = () => {
    setLoading(true); setError(null)
    Promise.all([getHealth(), ctfListTasks(), ctfBenchmark(), getTools(), ctfLlmStatus()])
      .then(([h, t, b, tl, l]) => {
        setHealth(h.data); setTasks(t.data); setBench(b.data); setTools(tl.data); setLlm(l.data)
      })
      .catch((e) => setError(e?.message || '无法同步后端状态，请确认服务已启动'))
      .finally(() => setLoading(false))
  }

  useEffect(loadData, [])

  const solved = bench?.solved ?? 0
  const total = bench?.total ?? 0
  const successRate = total > 0 ? ((solved / total) * 100).toFixed(0) : '0'
  const avgDuration = bench?.avg_duration_ms ?? 0
  const toolCalls = bench?.tool_calls_total ?? 0
  const recentEvents = tasks.flatMap(t => t.evidence.map(e => ({ ...e, task_id: t.task_id, task_title: t.title }))).sort((a, b) => b.timestamp - a.timestamp).slice(0, 10)
  const candidates = tasks.filter(t => t.best_flag).slice(0, 6)
  const runningTasks = tasks.filter(t => t.is_running)
  const activeTool = runningTasks.length > 0 ? 'run_shell' : undefined

  if (loading) return <div className="p-6 md:p-8"><LoadingState message="同步作战数据" /></div>
  if (error) return <div className="p-6 md:p-8"><ErrorState title="作战中枢暂时离线" detail={error} onRetry={loadData} /></div>

  return (
    <div className="p-6 md:p-8 max-w-[1440px] mx-auto">
      {/* ── Hero ── */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-10 gap-6">
        <div className="flex items-center gap-5">
          <ZhulongLogo size={56} glowing />
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-white tracking-tight">
              烛龙<span className="text-ember-400">X</span>
            </h1>
            <p className="text-sm text-slate-400 mt-1">自主决策网络安全智能体 · 面向复杂安全任务的感知、规划、执行与复盘中枢</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <AgentOrbit size={120} activeTool={activeTool} className="opacity-70 hidden md:block" />
          <div className="flex flex-col gap-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-ember-400 animate-pulse" />
              <span className="text-slate-400">后端</span>
              <span className="text-white font-mono">{health?.status ?? '—'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: llm?.mode === 'live' ? '#22c55e' : llm?.mode === 'mock' ? '#f59e0b' : '#64748b' }} />
              <span className="text-slate-400">LLM</span>
              <span className="text-white font-mono">{llm ? (llm.mode === 'live' ? 'Live' : llm.mode === 'mock' ? 'Mock' : 'Off') : '—'}</span>
              <span className="text-slate-500 font-mono ml-1">{llm?.model ?? ''}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Core Metrics ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <MetricCard label="已解题数" value={solved} unit={`/ ${total}`} icon={<CheckCircle size={16} />} hint={total > 0 ? `成功率 ${successRate}%` : undefined} />
        <MetricCard label="自动解题成功率" value={`${successRate}%`} icon={<TrendingUp size={16} />} hint={avgDuration > 0 ? `平均 ${Math.round(avgDuration / 1000)}s` : undefined} />
        <MetricCard label="工具调用总数" value={toolCalls} unit={`/ ${tools.length} 工具`} icon={<Wrench size={16} />} />
        <MetricCard label="LLM 通道" value={llm ? (llm.mode === 'live' ? 'Live' : llm.mode === 'mock' ? 'Mock' : 'Off') : 'N/A'} icon={<Cpu size={16} />} hint={llm?.model} />
      </div>

      {/* ── Main 3-Column Grid ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 mb-8">
        {/* Left: Active Tasks */}
        <Surface variant="panel" className="lg:col-span-5 p-5">
          <SectionHeader title="当前作战任务">
            <Link to="/ctf" className="text-xs text-ember-400 hover:text-ember-300 ml-auto">进入 CTF 擂台 →</Link>
          </SectionHeader>
          {tasks.length === 0 ? (
            <EmptyState title="暂无作战任务" description="选择一个 CTF 样例，启动智能体第一轮推理" action="进入 CTF 擂台" onAction={() => window.location.href = '/ctf'} />
          ) : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto">
              {tasks.slice(0, 10).map(t => (
                <Link to={`/ctf/${t.task_id}`} key={t.task_id} className="block px-3 py-2.5 rounded-xl hover:bg-obsidian-700/40 border border-transparent hover:border-ember-500/20 transition-all">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-white truncate">{t.title}</span>
                    <StatusBadge state={t.state} pulse={t.is_running} />
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span className={categoryStyle(t.category_hint ?? t.plan?.category ?? '').text}>{t.plan?.category || 'unknown'}</span>
                    <span>·</span>
                    <span>{t.rounds_used} 轮</span>
                    {t.best_flag && <><span>·</span><span className="text-jade-400 font-mono truncate max-w-[160px]">{t.best_flag}</span></>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Surface>

        {/* Middle: Event Stream */}
        <Surface variant="panel" className="lg:col-span-4 p-5" glow="cyan">
          <SectionHeader title="实时推理流">
            <span className="text-[10px] text-slate-500 ml-auto">最近事件</span>
          </SectionHeader>
          {recentEvents.length === 0 ? (
            <EmptyState title="等待 Agent 启动" description="智能体推理过程将在此实时展示" />
          ) : (
            <div className="space-y-1.5 max-h-[420px] overflow-y-auto font-mono">
              {recentEvents.map((e, idx) => {
                const time = new Date(e.timestamp * 1000).toLocaleTimeString('zh-CN', { hour12: false })
                return (
                  <div key={idx} className={`text-xs px-2.5 py-1.5 rounded-lg border-l-2 ${e.success ? 'border-jade-500 bg-jade-500/5' : 'border-crimson-500 bg-crimson-500/5'}`}>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500 text-[10px] tabular-nums">{time}</span>
                      <span className="text-cyan-400 uppercase text-[10px] font-bold">{e.step}</span>
                    </div>
                    <div className="text-slate-400 text-[11px] truncate mt-0.5">{e.input_summary || '(no summary)'}</div>
                  </div>
                )
              })}
            </div>
          )}
        </Surface>

        {/* Right: Flags */}
        <Surface variant="panel" className="lg:col-span-3 p-5" glow="jade">
          <SectionHeader title="候选 Flag"><span /></SectionHeader>
          {candidates.length === 0 ? (
            <EmptyState title="Agent 正在推理" description="候选 flag 将在此处展示" />
          ) : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto">
              {candidates.map(t => (
                <Link to={`/ctf/${t.task_id}`} key={t.task_id} className="block px-3 py-2 rounded-xl bg-jade-500/5 border border-jade-500/20 hover:bg-jade-500/10 transition-all">
                  <div className="text-[10px] text-slate-500 truncate mb-1">{t.title}</div>
                  <div className="text-xs font-mono text-jade-400 break-all">{t.best_flag}</div>
                </Link>
              ))}
            </div>
          )}
        </Surface>
      </div>

      {/* ── Category Breakdown ── */}
      {bench && bench.category_breakdown && (
        <Surface variant="panel" className="p-5 mb-8">
          <SectionHeader title="题型作战分布"><span /></SectionHeader>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {Object.entries(bench.category_breakdown).map(([cat, stats]) => {
              const cs = categoryStyle(cat)
              return (
                <div key={cat} className="rounded-xl p-3 bg-obsidian-800/60 border border-obsidian-500/30">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs">{cs.icon}</span>
                    <span className={`text-[10px] uppercase tracking-wider ${cs.text}`}>{cat}</span>
                  </div>
                  <div className="text-xl font-bold text-white tabular-nums">
                    {stats.solved}<span className="text-slate-500 text-sm">/{stats.total}</span>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5">
                    {stats.total > 0 ? `${((stats.solved / stats.total) * 100).toFixed(0)}%` : '—'}
                  </div>
                </div>
              )
            })}
          </div>
        </Surface>
      )}

      {/* ── Tool Matrix Preview ── */}
      {tools.length > 0 && (
        <Surface variant="panel" className="p-5 mb-8">
          <SectionHeader title="工具矩阵">
            <Link to="/tools" className="text-xs text-ember-400 hover:text-ember-300 ml-auto">查看全部 →</Link>
          </SectionHeader>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {tools.filter(t => t.enabled).slice(0, 10).map(t => (
              <div key={t.name} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-obsidian-800/40 border border-obsidian-500/30 text-xs">
                <span className={`w-1.5 h-1.5 rounded-full ${t.risk_level === 'high' ? 'bg-crimson-400' : t.risk_level === 'medium' ? 'bg-ember-400' : 'bg-jade-400'}`} />
                <span className="text-slate-300 font-mono truncate">{t.name}</span>
              </div>
            ))}
          </div>
        </Surface>
      )}

      {/* ── Safety ── */}
      <div className="px-4 py-3 bg-ember-500/5 border border-ember-500/20 rounded-xl flex items-start gap-3 text-xs text-slate-400">
        <AlertTriangle size={14} className="text-ember-400 mt-0.5 flex-shrink-0" />
        <span>烛龙 X 仅用于授权 CTF / 靶场 / 教学 / 合法安全测试。默认禁止访问真实公网目标，allow_network 须配合 authorized=true 方可放行。所有执行均受 ScopeGuard + 沙箱双重约束。</span>
      </div>
    </div>
  )
}
