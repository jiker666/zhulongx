import { useEffect, useState } from 'react'
import { BarChart3, TrendingUp, Clock, Activity, Trophy, AlertCircle } from 'lucide-react'
import { ctfBenchmark, ctfListTasks, type CtfBenchmark, type CtfTask } from '../api'
import { z, categoryStyle, statusStyle } from '../styles/tokens'
import { Surface, SectionHeader, ProgressRing, EmptyState, LoadingState, ErrorState, StatusBadge } from '../components/ui'
import { PageHeader } from '../components/layout'

export default function Benchmark() {
  const [bench, setBench] = useState<CtfBenchmark | null>(null)
  const [tasks, setTasks] = useState<CtfTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([ctfBenchmark(), ctfListTasks()])
      .then(([b, t]) => { setBench(b.data); setTasks(t.data) })
      .catch((e) => setError(e?.message || '同步失败'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-6 md:p-8"><LoadingState message="加载评测数据" /></div>
  if (error) return <div className="p-6 md:p-8"><ErrorState title="评测数据不可用" detail={error} onRetry={() => window.location.reload()} /></div>
  if (!bench) return null

  const total = bench.total
  const solved = bench.solved
  const successRate = (bench.success_rate * 100).toFixed(1)
  const humanRate = total > 0 ? ((bench.human_takeover / total) * 100).toFixed(0) : '0'

  return (
    <div className="p-6 md:p-8 max-w-[1440px] mx-auto">
      <PageHeader
        title="能力评测"
        subtitle={`基于 ${total} 个任务的实测数据`}
        icon={<BarChart3 size={20} className="text-ember-400" />}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <MetricCard label="总任务数" value={total} icon={<Trophy size={18} className="text-cyan-400" />} />
        <MetricCard label="自动解题成功" value={solved} icon={<TrendingUp size={18} className="text-jade-400" />} />
        <MetricCard label="成功率" value={`${successRate}%`} icon={<Activity size={18} className="text-ember-400" />} />
        <MetricCard label="人工接管" value={`${bench.human_takeover} (${humanRate}%)`} icon={<AlertCircle size={18} className="text-crimson-400" />} />
      </div>

      <Surface variant="panel" className="p-5 mb-8">
        <SectionHeader title="按题型分布" icon={<BarChart3 size={14} className="text-ember-400" />} />
        {Object.keys(bench.category_breakdown).length === 0 ? (
          <EmptyState title="暂无数据" description="先到 CTF 擂台运行 demo" />
        ) : (
          <div className="space-y-3">
            {Object.entries(bench.category_breakdown).map(([cat, stats]) => {
              const rate = stats.total > 0 ? (stats.solved / stats.total) * 100 : 0
              const cs = categoryStyle(cat)
              return (
                <div key={cat}>
                  <div className="flex items-center justify-between mb-1 text-xs">
                    <span className={`uppercase ${cs.text}`}>{cat}</span>
                    <span className="text-slate-500 tabular-nums">{stats.solved} / {stats.total} ({rate.toFixed(0)}%)</span>
                  </div>
                  <div className="h-2 bg-obsidian-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-ember-500 to-ember-300 rounded-full transition-all duration-500"
                      style={{ width: `${rate}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Surface>

      <Surface variant="panel" className="overflow-hidden mb-8">
        <div className="px-5 py-3 border-b border-obsidian-600/30">
          <SectionHeader title="任务详情" icon={<Activity size={14} className="text-cyan-400" />} />
        </div>
        {tasks.length === 0 ? (
          <EmptyState title="暂无任务" />
        ) : (
          <div className="divide-y divide-obsidian-600/30">
            {tasks.map((t) => {
              const duration = (t.updated_at - t.created_at).toFixed(1)
              return (
                <a href={`/ctf/${t.task_id}`} key={t.task_id} className="flex items-center gap-4 px-5 py-3 hover:bg-obsidian-800/40 transition-colors">
                  <span className="text-sm text-white truncate flex-1">{t.title}</span>
                  <span className={`text-xs uppercase ${categoryStyle(t.plan?.category || '').text}`}>{t.plan?.category || '—'}</span>
                  <StatusBadge state={t.state} />
                  <span className="text-xs font-mono text-jade-400 truncate max-w-[200px]">{t.best_flag || '—'}</span>
                  <span className="text-xs text-slate-500 tabular-nums flex items-center gap-1"><Clock size={10} /> {duration}s</span>
                  <span className="text-xs text-slate-500 tabular-nums">{t.rounds_used}</span>
                </a>
              )
            })}
          </div>
        )}
      </Surface>

      <Surface variant="panel" className="p-4">
        <div className="text-xs text-ember-200/80 leading-relaxed">
          <div className="font-semibold text-ember-300 mb-1">评测说明</div>
          <ul className="space-y-0.5 list-disc list-inside text-slate-400">
            <li>所有测试题均为离线本地 demo，无公网访问</li>
            <li>Mock LLM 模式下使用启发式规则推理；真实 LLM 接入后成功率会更高</li>
            <li>每个任务限制最大 8 轮推理，超出后转人工接管</li>
            <li>沙箱限制：单脚本 15s 超时、20000 字符输出截断、禁网、禁危险命令</li>
          </ul>
        </div>
      </Surface>
    </div>
  )
}

function MetricCard({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }) {
  return (
    <Surface variant="panel" className="p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-slate-400 uppercase tracking-wider">{label}</span>
        {icon}
      </div>
      <div className="text-2xl font-bold text-white tabular-nums">{value}</div>
    </Surface>
  )
}
