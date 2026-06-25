import { useEffect, useState } from 'react'
import { BarChart3, TrendingUp, Clock, Activity, Trophy, AlertCircle } from 'lucide-react'
import { ctfBenchmark, ctfListTasks, type CtfBenchmark, type CtfTask } from '../api'

export default function Benchmark() {
  const [bench, setBench] = useState<CtfBenchmark | null>(null)
  const [tasks, setTasks] = useState<CtfTask[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([ctfBenchmark(), ctfListTasks()])
      .then(([b, t]) => {
        setBench(b.data)
        setTasks(t.data)
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center">
        <Activity className="animate-pulse text-amber-400" size={32} />
      </div>
    )
  }

  if (!bench) return null

  const total = bench.total
  const solved = bench.solved
  const successRate = (bench.success_rate * 100).toFixed(1)
  const humanRate = total > 0 ? ((bench.human_takeover / total) * 100).toFixed(0) : '0'

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0a0e1a] via-[#0d1426] to-[#0a0e1a] p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <BarChart3 className="text-amber-400" size={24} /> 能力评测
        </h1>
        <p className="text-sm text-gray-400 mt-1">
          基于 {total} 个任务的实测数据
        </p>
      </div>

      {/* Top Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Metric label="总任务数" value={total} icon={<Trophy size={18} />} color="text-cyan-300" />
        <Metric label="自动解题成功" value={solved} icon={<TrendingUp size={18} />} color="text-green-300" />
        <Metric label="成功率" value={`${successRate}%`} icon={<Activity size={18} />} color="text-amber-300" />
        <Metric label="人工接管" value={`${bench.human_takeover} (${humanRate}%)`} icon={<AlertCircle size={18} />} color="text-yellow-300" />
      </div>

      {/* Category Breakdown */}
      <div className="bg-[#0d1426]/80 border border-amber-500/20 rounded-xl p-4 mb-6">
        <h2 className="text-sm font-semibold text-amber-300 mb-3 uppercase tracking-wider">
          按题型分布
        </h2>
        {Object.keys(bench.category_breakdown).length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-8">
            暂无数据，先到 <a href="/ctf" className="text-amber-400">CTF 作战</a> 运行 demo
          </div>
        ) : (
          <div className="space-y-3">
            {Object.entries(bench.category_breakdown).map(([cat, stats]) => {
              const rate = stats.total > 0 ? (stats.solved / stats.total) * 100 : 0
              return (
                <div key={cat}>
                  <div className="flex items-center justify-between mb-1 text-xs">
                    <span className="text-gray-300 uppercase">{cat}</span>
                    <span className="text-gray-500 tabular-nums">
                      {stats.solved} / {stats.total} ({rate.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="h-2 bg-[#1f2937] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-amber-500 to-orange-400 rounded-full"
                      style={{ width: `${rate}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Task Table */}
      <div className="bg-[#0d1426]/80 border border-cyan-500/20 rounded-xl overflow-hidden">
        <h2 className="text-sm font-semibold text-cyan-300 p-4 uppercase tracking-wider border-b border-cyan-500/20">
          任务详情
        </h2>
        {tasks.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-12">暂无任务</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-[10px] uppercase text-gray-500 border-b border-[#1f2937]">
                <th className="text-left px-4 py-2 font-medium">标题</th>
                <th className="text-left px-4 py-2 font-medium">题型</th>
                <th className="text-left px-4 py-2 font-medium">状态</th>
                <th className="text-left px-4 py-2 font-medium">Flag</th>
                <th className="text-right px-4 py-2 font-medium">耗时</th>
                <th className="text-right px-4 py-2 font-medium">轮次</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map(t => {
                const duration = ((t.updated_at - t.created_at)).toFixed(1)
                return (
                  <tr key={t.task_id} className="border-b border-[#1f2937] hover:bg-cyan-500/5">
                    <td className="px-4 py-2 text-sm text-white">{t.title}</td>
                    <td className="px-4 py-2 text-xs text-gray-400 uppercase">{t.plan?.category || '-'}</td>
                    <td className={`px-4 py-2 text-xs font-mono ${
                      t.state === 'DONE' ? 'text-green-300' :
                      t.state === 'FAILED' ? 'text-red-300' :
                      'text-yellow-300'
                    }`}>{t.state}</td>
                    <td className="px-4 py-2 text-xs font-mono text-green-300">
                      {t.best_flag ? t.best_flag.slice(0, 40) + (t.best_flag.length > 40 ? '...' : '') : '-'}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400 text-right tabular-nums">
                      <Clock size={10} className="inline mr-1" />
                      {duration}s
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500 text-right tabular-nums">{t.rounds_used}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Limitations */}
      <div className="mt-6 px-4 py-3 bg-yellow-500/5 border border-yellow-500/20 rounded-lg text-xs text-yellow-200/80">
        <div className="font-semibold text-yellow-300 mb-1">评测说明</div>
        <ul className="space-y-0.5 list-disc list-inside">
          <li>所有测试题均为离线本地 demo，无公网访问</li>
          <li>Mock LLM 模式下使用启发式规则推理；真实 LLM 接入后成功率会更高</li>
          <li>每个任务限制最大 8 轮推理，超出后转人工接管</li>
          <li>沙箱限制：单脚本 15s 超时、20000 字符输出截断、禁网、禁危险命令</li>
        </ul>
      </div>
    </div>
  )
}

function Metric({
  label,
  value,
  icon,
  color,
}: {
  label: string
  value: number | string
  icon: React.ReactNode
  color: string
}) {
  return (
    <div className="bg-[#0d1426]/80 border border-amber-500/20 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400 uppercase tracking-wider">{label}</span>
        <span className={color}>{icon}</span>
      </div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  )
}
