import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Power, ShieldCheck, Wrench } from 'lucide-react'
import { getTools, setToolEnabled, type Tool } from '../api'
import { RiskLegend, ToolRiskCard } from '../components/security'
import { DataEmpty, ErrorState, GlassPanel, LoadingState, SectionShell, StatePill } from '../components/ui'
import { categoryTone } from '../lib/status'

function parseJson(value: string) {
  try { return JSON.parse(value) } catch { return value }
}

function compactSchema(value: string) {
  const parsed = parseJson(value)
  if (typeof parsed === 'string') return parsed || '-'
  const props = parsed?.properties ? Object.keys(parsed.properties) : []
  return props.length ? props.join(', ') : JSON.stringify(parsed)
}

function parseList(value: string): string[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed : []
}

export default function ToolCenter() {
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)

  const loadTools = () => {
    setError(null)
    return getTools()
      .then((response) => setTools(response.data))
      .catch((e) => setError(e?.response?.data?.detail || e.message || '加载工具失败'))
  }

  useEffect(() => {
    loadTools().finally(() => setLoading(false))
  }, [])

  const toggleTool = async (tool: Tool) => {
    setToggling(tool.name)
    try {
      await setToolEnabled(tool.name, !tool.enabled)
      await loadTools()
    } finally {
      setToggling(null)
    }
  }

  const grouped = useMemo(() => {
    return tools.reduce<Record<string, Tool[]>>((acc, tool) => {
      const category = tool.category || 'general'
      acc[category] = acc[category] || []
      acc[category].push(tool)
      return acc
    }, {})
  }, [tools])

  const enabled = tools.filter((tool) => tool.enabled).length
  const disabled = tools.length - enabled
  const highRisk = tools.filter((tool) => ['high', 'critical'].includes(tool.risk_level?.toLowerCase())).length

  if (loading) return <div className="mx-auto max-w-[1500px] p-6"><LoadingState message="加载工具链与风险控制中心" /></div>

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6 lg:p-8">
      <GlassPanel tone="cyan" className="p-0">
        <div className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:p-6">
          <div>
            <div className="mb-4 flex flex-wrap gap-2">
              <StatePill tone="cyan" icon={<Wrench size={13} />}>工具链与风险控制中心</StatePill>
              <StatePill tone="jade" icon={<Power size={13} />}>{enabled} enabled</StatePill>
              <StatePill tone={highRisk ? 'crimson' : 'jade'} icon={<AlertTriangle size={13} />}>{highRisk} high risk</StatePill>
            </div>
            <h1 className="text-3xl font-black text-white md:text-5xl">工具不是乱用，是被编排</h1>
            <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-300">
              每个工具都展示输入、输出、权限、风险、超时与启用状态。高风险工具必须在 ScopeGuard 和授权边界内使用。
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 lg:min-w-[420px]">
            <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3"><div className="text-[11px] text-slate-500">总工具</div><div className="mt-1 text-2xl font-bold text-white">{tools.length}</div></div>
            <div className="rounded-lg border border-jade-500/20 bg-jade-500/10 p-3"><div className="text-[11px] text-jade-300">启用</div><div className="mt-1 text-2xl font-bold text-white">{enabled}</div></div>
            <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3"><div className="text-[11px] text-slate-500">禁用</div><div className="mt-1 text-2xl font-bold text-white">{disabled}</div></div>
          </div>
        </div>
      </GlassPanel>

      {error && <ErrorState title="工具状态同步失败" detail={error} onRetry={loadTools} />}

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {tools.length === 0 ? (
            <DataEmpty title="暂无工具" />
          ) : (
            Object.entries(grouped).map(([category, items]) => (
              <SectionShell
                key={category}
                eyebrow="Tool Category"
                title={`${category} · ${items.length}`}
                description="按工具职责聚合，方便比较输入输出与权限边界。"
                action={<StatePill tone={categoryTone(category)}>{items.filter((tool) => tool.enabled).length}/{items.length} enabled</StatePill>}
              >
                <div className="grid gap-4 md:grid-cols-2">
                  {items.map((tool) => (
                    <ToolRiskCard
                      key={tool.name}
                      tool={tool}
                      permissions={parseList(tool.permissions)}
                      tags={parseList(tool.tags)}
                      input={compactSchema(tool.input_schema)}
                      output={compactSchema(tool.output_schema)}
                      toggling={toggling === tool.name}
                      onToggle={() => toggleTool(tool)}
                    />
                  ))}
                </div>
              </SectionShell>
            ))
          )}
        </div>

        <div className="space-y-4">
          <RiskLegend />
          <GlassPanel tone="jade">
            <div className="mb-3 flex items-center gap-2">
              <ShieldCheck size={16} className="text-jade-300" />
              <h2 className="text-sm font-semibold text-white">安全编排原则</h2>
            </div>
            <div className="space-y-3 text-xs leading-5 text-slate-400">
              <p>文件分析和报告工具默认离线执行，网络、写文件、长耗时工具必须明确展示风险。</p>
              <p>禁用状态不只靠颜色表达，所有开关都有文字、图标和 disabled/loading 状态。</p>
              <p>高风险工具应由任务授权、ScopeGuard 和人工复核共同放行。</p>
            </div>
          </GlassPanel>
          <GlassPanel tone="cyan">
            <div className="mb-3 flex items-center gap-2">
              <CheckCircle2 size={16} className="text-cyan-300" />
              <h2 className="text-sm font-semibold text-white">工具链覆盖</h2>
            </div>
            <div className="space-y-2">
              {Object.entries(grouped).map(([category, items]) => (
                <div key={category} className="flex items-center justify-between rounded-lg border border-slate-800 bg-obsidian-950/45 px-3 py-2 text-xs">
                  <StatePill tone={categoryTone(category)} className="min-h-6 px-2 py-0.5">{category}</StatePill>
                  <span className="font-mono text-slate-300">{items.length}</span>
                </div>
              ))}
            </div>
          </GlassPanel>
        </div>
      </div>
    </div>
  )
}
