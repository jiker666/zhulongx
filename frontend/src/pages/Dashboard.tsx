import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, CheckCircle2, Database, Flag, Gauge, RadioTower, ShieldCheck, Wrench,
} from 'lucide-react'
import {
  getHealth, ctfListTasks, ctfBenchmark, ctfLlmStatus, getTools,
  type HealthStatus, type CtfTask, type CtfBenchmark, type Tool, type LlmStatus,
} from '../api'
import { AgentPipelineBeam, CapabilityMatrix, CommandHero, EvidenceConstellation, JudgePitchStrip } from '../components/dashboard'
import { GlassPanel, StatePill, StatusBadge, SectionShell, DataEmpty, ErrorState, LoadingState } from '../components/ui'
import RingGauge from '../components/charts/RingGauge'
import { compactNumber, formatDuration, formatPercent } from '../lib/format'
import { categoryTone, ctfStateLabel, toneForRisk, toneForState } from '../lib/status'

function MetricTile({
  label,
  value,
  detail,
  icon,
  tone = 'slate',
}: {
  label: string
  value: string | number
  detail?: string
  icon: React.ReactNode
  tone?: 'ember' | 'cyan' | 'violet' | 'jade' | 'crimson' | 'slate'
}) {
  return (
    <GlassPanel compact tone={tone} className="min-h-[116px]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-slate-400">{label}</div>
          <div className="mt-3 text-3xl font-bold tabular-nums text-white">{value}</div>
          {detail && <div className="mt-1 text-xs leading-5 text-slate-500">{detail}</div>}
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-slate-200">
          {icon}
        </div>
      </div>
    </GlassPanel>
  )
}

export default function Dashboard() {
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [tasks, setTasks] = useState<CtfTask[]>([])
  const [bench, setBench] = useState<CtfBenchmark | null>(null)
  const [tools, setTools] = useState<Tool[]>([])
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = () => {
    setLoading(true)
    setError(null)
    Promise.all([getHealth(), ctfListTasks(), ctfBenchmark(), getTools(), ctfLlmStatus()])
      .then(([h, t, b, tl, l]) => {
        setHealth(h.data)
        setTasks(t.data)
        setBench(b.data)
        setTools(tl.data)
        setLlm(l.data)
      })
      .catch((e) => setError(e?.message || '无法同步后端状态，请确认服务已启动'))
      .finally(() => setLoading(false))
  }

  useEffect(loadData, [])

  const stats = useMemo(() => {
    const total = bench?.total ?? tasks.length
    const solved = bench?.solved ?? tasks.filter((task) => task.state === 'DONE').length
    const running = tasks.filter((task) => task.is_running || ['AGENT_THINK', 'RUN_SCRIPT', 'RUN_SHELL', 'ANALYZE_FILES'].includes(task.state)).length
    const candidates = tasks.reduce((sum, task) => sum + task.candidate_flags.length + (task.best_flag ? 1 : 0), 0)
    const evidence = tasks.reduce((sum, task) => sum + task.evidence.length, 0)
    const safety = tasks.filter((task) => !task.authorized || task.state === 'HUMAN_REQUIRED' || task.error).length
    const successRate = total ? (solved / total) * 100 : 0
    return { total, solved, running, candidates, evidence, safety, successRate }
  }, [bench, tasks])

  const activeIndex = useMemo(() => {
    const latest = tasks.find((task) => task.is_running) ?? tasks[0]
    const state = latest?.state ?? 'INIT'
    const map: Record<string, number> = {
      INIT: 0,
      CLASSIFY: 1,
      PLAN: 2,
      ANALYZE_FILES: 3,
      AGENT_THINK: 4,
      RUN_SCRIPT: 5,
      RUN_SHELL: 5,
      VERIFY_FLAG: 6,
      GENERATE_WRITEUP: 7,
      DONE: 7,
    }
    return map[state] ?? 2
  }, [tasks])

  const highRiskTools = tools.filter((tool) => ['high', 'critical'].includes(tool.risk_level?.toLowerCase()))

  if (loading) return <div className="mx-auto max-w-[1500px] p-6"><LoadingState message="同步玄枢作战态势" /></div>
  if (error) return <div className="mx-auto max-w-[1500px] p-6"><ErrorState title="作战中枢暂时离线" detail={error} onRetry={loadData} /></div>

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6 lg:p-8">
      <CommandHero
        backendStatus={health?.status}
        llmMode={llm?.mode}
        llmModel={llm?.model}
        runningCount={stats.running}
        scopeConfigured={health?.scope_config_summary?.configured}
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <MetricTile label="总任务数" value={compactNumber(stats.total)} detail={`${stats.solved} 已解决`} tone="ember" icon={<Database size={18} />} />
        <MetricTile label="运行中" value={stats.running} detail="Agent 正在推进" tone="cyan" icon={<RadioTower size={18} />} />
        <MetricTile label="成功率" value={formatPercent(stats.successRate)} detail={bench ? `平均 ${formatDuration(bench.avg_duration_ms)}` : '等待评测样本'} tone="jade" icon={<CheckCircle2 size={18} />} />
        <MetricTile label="候选 Flag" value={stats.candidates} detail="待人工复核战果" tone="violet" icon={<Flag size={18} />} />
        <MetricTile label="证据链" value={stats.evidence} detail="输入、输出、工具痕迹" tone="cyan" icon={<Gauge size={18} />} />
        <MetricTile label="安全拦截" value={stats.safety} detail="未授权或人工接管" tone={stats.safety ? 'crimson' : 'jade'} icon={<ShieldCheck size={18} />} />
      </section>

      <SectionShell
        eyebrow="Agent Pipeline"
        title="理解 → 计划 → 工具 → 沙箱 → Flag → WP"
        description="玄枢把自动化解题拆成可解释阶段，每一步都有状态、证据和可回看的失败原因。"
        action={<Link to="/ctf" className="text-sm font-medium text-ember-300 hover:text-ember-200">管理题目</Link>}
      >
        <AgentPipelineBeam activeIndex={activeIndex} />
      </SectionShell>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <SectionShell
          eyebrow="Capability Matrix"
          title="题型能力矩阵"
          description="不是孤立工具清单，而是按题型组织的解题经验、工具链和 fallback 路由。"
        >
          <CapabilityMatrix breakdown={bench?.category_breakdown} successRate={bench?.category_success_rate} />
        </SectionShell>

        <GlassPanel tone="jade" className="flex flex-col justify-between gap-5">
          <RingGauge
            value={stats.successRate}
            label="自动解题闭环"
            detail={bench ? `${stats.solved}/${stats.total} solved · ${compactNumber(bench.tool_calls_total)} tool calls` : '暂无 benchmark 数据'}
            tone="jade"
          />
          <div className="space-y-2">
            <StatePill tone={llm?.mode === 'live' ? 'jade' : llm?.mode === 'mock' ? 'ember' : 'slate'}>
              模型通道 {llm?.mode ?? 'unknown'}
            </StatePill>
            <StatePill tone={health?.scope_config_summary?.competition_mode ? 'ember' : 'cyan'}>
              Competition Mode {health?.scope_config_summary?.competition_mode ? 'ON' : 'OFF'}
            </StatePill>
            <StatePill tone={health?.scope_config_summary?.allow_localhost ? 'cyan' : 'slate'}>
              Localhost {health?.scope_config_summary?.allow_localhost ? '允许' : '默认关闭'}
            </StatePill>
          </div>
        </GlassPanel>
      </div>

      <SectionShell
        eyebrow="Evidence Constellation"
        title="证据链星图"
        description="评委能看到 Agent 为什么可信：工具输入输出、执行结果、失败和候选 flag 都留在链路里。"
      >
        <EvidenceConstellation tasks={tasks} />
      </SectionShell>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <GlassPanel tone="ember">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ember-300">Recent Operations</div>
              <h2 className="mt-1 text-lg font-semibold text-white">当前作战任务</h2>
            </div>
            <Link to="/ctf" className="text-sm text-ember-300 hover:text-ember-200">进入大厅</Link>
          </div>
          {tasks.length === 0 ? (
            <DataEmpty title="导入第一道题" description="粘贴题面、上传附件、设定 flag 格式与授权边界后，Agent 会开始完整闭环。" actionLabel="打开 CTF 作战大厅" onAction={() => { window.location.href = '/ctf' }} />
          ) : (
            <div className="divide-y divide-slate-800/80">
              {tasks.slice(0, 8).map((task) => (
                <Link key={task.task_id} to={`/ctf/${task.task_id}`} className="grid gap-3 py-3 transition hover:bg-white/[0.025] md:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium text-white">{task.title}</span>
                      <StatePill tone={categoryTone(task.plan?.category || task.category_hint)} className="min-h-6 px-2 py-0.5">
                        {task.plan?.category || task.category_hint || 'unknown'}
                      </StatePill>
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs text-slate-500">
                      {task.plan?.initial_guess || task.description}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 md:justify-end">
                    <StatusBadge state={task.is_running ? 'RUNNING' : task.state} label={ctfStateLabel[task.state] || task.state} pulse={task.is_running} />
                    {task.best_flag && <span className="max-w-[220px] truncate font-mono text-xs text-jade-300">{task.best_flag}</span>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </GlassPanel>

        <GlassPanel tone={highRiskTools.length ? 'crimson' : 'cyan'}>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-500/20 bg-cyan-500/10 text-cyan-300">
              <Wrench size={18} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">工具链态势</h2>
              <p className="text-xs text-slate-400">{tools.filter((tool) => tool.enabled).length}/{tools.length} 工具启用</p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {tools.slice(0, 7).map((tool) => (
              <div key={tool.name} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/80 bg-obsidian-950/50 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs text-white">{tool.name}</div>
                  <div className="text-[11px] text-slate-500">{tool.category}</div>
                </div>
                <StatePill tone={toneForRisk(tool.risk_level)} className="min-h-6 px-2 py-0.5">
                  {tool.risk_level || 'unknown'}
                </StatePill>
              </div>
            ))}
          </div>
          <Link to="/tools" className="mt-4 inline-flex text-sm font-medium text-cyan-300 hover:text-cyan-200">查看风险控制中心</Link>
        </GlassPanel>
      </div>

      <JudgePitchStrip />

      <div className="flex items-start gap-3 rounded-lg border border-ember-500/25 bg-ember-500/[0.06] px-4 py-3 text-sm leading-6 text-slate-300">
        <AlertTriangle size={16} className="mt-1 flex-shrink-0 text-ember-300" />
        <span>烛龙·玄枢仅用于授权 CTF / 靶场 / 教学 / 合法安全测试。默认拒绝非授权目标，allow_network 必须配合 authorized=true 与 ScopeGuard 策略才会放行。</span>
      </div>
    </div>
  )
}
