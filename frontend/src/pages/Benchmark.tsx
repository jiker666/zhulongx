import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Activity, AlertCircle, Clock, GitBranch, Route, Trophy } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ctfBenchmark, ctfListTasks, type CtfBenchmark, type CtfTask } from '../api'
import CapabilityRadar from '../components/charts/CapabilityRadar'
import RingGauge from '../components/charts/RingGauge'
import { DataEmpty, ErrorState, GlassPanel, LoadingState, SectionShell, StatePill, StatusBadge } from '../components/ui'
import { categoryTone, ctfStateLabel, toneForState } from '../lib/status'
import { formatDuration, formatPercent } from '../lib/format'

function MetricCard({ label, value, detail, icon }: { label: string; value: string | number; detail?: string; icon: ReactNode }) {
  return (
    <GlassPanel tone="cyan" compact>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-400">{label}</div>
          <div className="mt-3 text-3xl font-bold tabular-nums text-white">{value}</div>
          {detail && <div className="mt-1 text-xs text-slate-500">{detail}</div>}
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-cyan-300">{icon}</div>
      </div>
    </GlassPanel>
  )
}

export default function Benchmark() {
  const [bench, setBench] = useState<CtfBenchmark | null>(null)
  const [tasks, setTasks] = useState<CtfTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    setLoading(true)
    setError(null)
    Promise.all([ctfBenchmark(), ctfListTasks()])
      .then(([benchmarkResponse, taskResponse]) => {
        setBench(benchmarkResponse.data)
        setTasks(taskResponse.data)
      })
      .catch((e) => setError(e?.message || '同步失败'))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const radarMetrics = useMemo(() => {
    const source = bench?.category_breakdown || {}
    return Object.entries(source).map(([label, stats]) => ({
      label,
      value: stats.total ? (stats.solved / stats.total) * 100 : 0,
    }))
  }, [bench])

  if (loading) return <div className="mx-auto max-w-[1500px] p-6"><LoadingState message="加载能力评测中心" /></div>
  if (error) return <div className="mx-auto max-w-[1500px] p-6"><ErrorState title="评测数据不可用" detail={error} onRetry={load} /></div>
  if (!bench) return null

  const successRate = (bench.success_rate || (bench.total ? bench.solved / bench.total : 0)) * 100
  const humanRate = bench.total > 0 ? (bench.human_takeover / bench.total) * 100 : 0
  const failed = tasks.filter((task) => ['FAILED', 'HUMAN_REQUIRED'].includes(task.state))

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6 lg:p-8">
      <GlassPanel tone="violet" className="p-0">
        <div className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:p-6">
          <div>
            <div className="mb-4 flex flex-wrap gap-2">
              <StatePill tone="violet" icon={<Activity size={13} />}>能力评测中心</StatePill>
              <StatePill tone="jade">通过率 {formatPercent(successRate, 1)}</StatePill>
              <StatePill tone={humanRate > 20 ? 'ember' : 'cyan'}>人工接管 {formatPercent(humanRate)}</StatePill>
            </div>
            <h1 className="text-3xl font-black text-white md:text-5xl">证明 Agent 能打，而不只是能跑</h1>
            <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-300">
              这里用通过率、耗时、题型覆盖、fallback 次数和失败归因展示玄枢的实战能力，并把成本路由和人工接管作为可信边界。
            </p>
          </div>
          <RingGauge value={successRate} label="自动解题通过率" detail={`${bench.solved}/${bench.total} solved · ${formatDuration(bench.avg_duration_ms)}`} tone="jade" />
        </div>
      </GlassPanel>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="总任务数" value={bench.total} detail="参与评测样本" icon={<Trophy size={18} />} />
        <MetricCard label="平均耗时" value={formatDuration(bench.avg_duration_ms)} detail="端到端 solve 时间" icon={<Clock size={18} />} />
        <MetricCard label="工具调用" value={bench.tool_calls_total} detail="沙箱与分析工具" icon={<GitBranch size={18} />} />
        <MetricCard label="人工接管" value={bench.human_takeover} detail="超过边界或置信不足" icon={<AlertCircle size={18} />} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <GlassPanel tone="cyan">
          <div className="mb-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Capability Radar</div>
            <h2 className="mt-1 text-lg font-semibold text-white">题型覆盖雷达</h2>
          </div>
          <CapabilityRadar metrics={radarMetrics} />
        </GlassPanel>

        <SectionShell
          eyebrow="Scenario Matrix"
          title="题型通过矩阵"
          description="按题型展示 solved/total，比单一平均值更能暴露短板。"
        >
          {Object.keys(bench.category_breakdown).length === 0 ? (
            <DataEmpty title="暂无数据" description="先到 CTF 作战大厅运行 demo。" />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {Object.entries(bench.category_breakdown).map(([category, stats]) => {
                const rate = stats.total > 0 ? (stats.solved / stats.total) * 100 : 0
                return (
                  <GlassPanel key={category} tone={categoryTone(category)} compact>
                    <div className="flex items-center justify-between gap-3">
                      <StatePill tone={categoryTone(category)}>{category}</StatePill>
                      <div className="font-mono text-sm text-slate-300">{stats.solved}/{stats.total}</div>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
                      <div className="h-full rounded-full bg-ember-400" style={{ width: `${Math.max(4, Math.min(100, rate))}%` }} />
                    </div>
                    <div className="mt-2 text-xs text-slate-500">{formatPercent(rate)} pass</div>
                  </GlassPanel>
                )
              })}
            </div>
          )}
        </SectionShell>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <GlassPanel tone="ember">
          <div className="mb-4 flex items-center gap-2">
            <Route size={17} className="text-ember-300" />
            <h2 className="text-lg font-semibold text-white">成本感知模型路由</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              ['便宜模型', '题型分类、摘要压缩、简单计划'],
              ['专家模型', '复杂推理、失败反思、WP 生成'],
              ['人工复核', '授权确认、候选提交、异常接管'],
            ].map(([title, desc], index) => (
              <div key={title} className="rounded-lg border border-ember-500/20 bg-ember-500/10 p-3">
                <div className="font-mono text-xs text-ember-300">0{index + 1}</div>
                <div className="mt-2 text-sm font-semibold text-white">{title}</div>
                <p className="mt-2 text-xs leading-5 text-slate-400">{desc}</p>
              </div>
            ))}
          </div>
        </GlassPanel>

        <GlassPanel tone={failed.length ? 'crimson' : 'jade'}>
          <div className="mb-4 flex items-center gap-2">
            <AlertCircle size={17} className={failed.length ? 'text-crimson-300' : 'text-jade-300'} />
            <h2 className="text-lg font-semibold text-white">失败归因 L1-L4</h2>
          </div>
          {failed.length === 0 ? (
            <p className="text-sm leading-6 text-slate-400">当前评测样本暂无失败任务。继续扩大题型覆盖后，这里会展示超时、工具失败、置信不足和安全边界接管。</p>
          ) : (
            <div className="space-y-2">
              {failed.slice(0, 6).map((task) => (
                <Link key={task.task_id} to={`/ctf/${task.task_id}`} className="block rounded-lg border border-crimson-500/20 bg-crimson-500/10 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-white">{task.title}</span>
                    <StatusBadge state={task.state} label={ctfStateLabel[task.state] || task.state} />
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-crimson-100">{task.error || '失败原因待补充'}</p>
                </Link>
              ))}
            </div>
          )}
        </GlassPanel>
      </div>

      <GlassPanel tone="slate">
        <div className="mb-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">Task Audit</div>
          <h2 className="mt-1 text-lg font-semibold text-white">任务明细</h2>
        </div>
        {tasks.length === 0 ? (
          <DataEmpty title="暂无任务" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-left text-sm">
              <thead className="text-xs text-slate-500">
                <tr className="border-b border-slate-800">
                  <th className="py-2 pr-3 font-medium">题目</th>
                  <th className="py-2 pr-3 font-medium">题型</th>
                  <th className="py-2 pr-3 font-medium">状态</th>
                  <th className="py-2 pr-3 font-medium">候选</th>
                  <th className="py-2 pr-3 font-medium">耗时</th>
                  <th className="py-2 pr-3 font-medium">轮次</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.task_id} className="border-b border-slate-900/80 hover:bg-white/[0.025]">
                    <td className="py-3 pr-3"><Link className="text-white hover:text-ember-200" to={`/ctf/${task.task_id}`}>{task.title}</Link></td>
                    <td className="py-3 pr-3"><StatePill tone={categoryTone(task.plan?.category || task.category_hint)} className="min-h-6 px-2 py-0.5">{task.plan?.category || task.category_hint || '-'}</StatePill></td>
                    <td className="py-3 pr-3"><StatusBadge state={task.state} label={ctfStateLabel[task.state] || task.state} /></td>
                    <td className="max-w-[240px] truncate py-3 pr-3 font-mono text-xs text-jade-300">{task.best_flag || '-'}</td>
                    <td className="py-3 pr-3 font-mono text-xs text-slate-400">{formatDuration(task.updated_at - task.created_at, 's')}</td>
                    <td className="py-3 pr-3 font-mono text-xs text-slate-400">{task.rounds_used}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassPanel>
    </div>
  )
}
