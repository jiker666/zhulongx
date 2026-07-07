import { useEffect, useState } from 'react'
import { getTools, setToolEnabled, type Tool } from '../api'
import { Wrench, Loader2, Globe, Code2, FileText, BarChart2, CheckCircle2, XCircle, Power, Shield } from 'lucide-react'
import { z } from '../styles/tokens'
import { Surface, GlowButton, SectionHeader, LoadingState, EmptyState, StatusBadge } from '../components/ui'
import { PageHeader } from '../components/layout'

const CAT_ICONS: Record<string, React.ReactNode> = {
  web: <Globe size={14} />, code: <Code2 size={14} />, audit: <Code2 size={14} />,
  file: <FileText size={14} />, log: <BarChart2 size={14} />, general: <Wrench size={14} />,
}

const CAT_STYLE: Record<string, { bg: string; text: string; border: string }> = {
  web:     { bg: 'bg-cyan-500/10',  text: 'text-cyan-400',   border: 'border-cyan-500/30' },
  code:    { bg: 'bg-violet-500/10', text: 'text-violet-400', border: 'border-violet-500/30' },
  audit:   { bg: 'bg-violet-500/10', text: 'text-violet-400', border: 'border-violet-500/30' },
  file:    { bg: 'bg-ember-500/10',  text: 'text-ember-400',  border: 'border-ember-500/30' },
  log:     { bg: 'bg-jade-500/10',   text: 'text-jade-400',   border: 'border-jade-500/30' },
  general: { bg: 'bg-slate-500/10', text: 'text-slate-400',  border: 'border-slate-500/30' },
}

function parseJson(v: string) { try { return JSON.parse(v) } catch { return v } }
function compactSchema(v: string) {
  const p = parseJson(v)
  if (typeof p === 'string') return p
  const props = p?.properties ? Object.keys(p.properties) : []
  return props.length ? props.join(', ') : JSON.stringify(p)
}
function parseList(v: string): string[] { const p = parseJson(v); return Array.isArray(p) ? p : [] }

function RiskDot({ level }: { level: string }) {
  const c = level === 'high' ? 'bg-crimson-400' : level === 'medium' ? 'bg-ember-400' : 'bg-jade-400'
  return <span className={`w-1.5 h-1.5 rounded-full ${c}`} />
}

export default function ToolCenter() {
  const [tools, setTools] = useState<Tool[]>([])
  const [loading, setLoading] = useState(true)

  const loadTools = () => getTools().then((r) => setTools(r.data))

  useEffect(() => {
    loadTools().finally(() => setLoading(false))
  }, [])

  const toggleTool = async (tool: Tool) => {
    await setToolEnabled(tool.name, !tool.enabled)
    await loadTools()
  }

  const enabled = tools.filter((t) => t.enabled).length
  const disabled = tools.filter((t) => !t.enabled).length

  return (
    <div className="p-6 md:p-8 max-w-[1440px] mx-auto">
      <PageHeader
        title="工具矩阵"
        subtitle={`${enabled} 已启用 / ${disabled} 已禁用 · 演示模式：默认工具均为只读低风险`}
        icon={<Wrench size={20} className="text-ember-400" />}
      />

      {loading ? (
        <LoadingState message="加载工具" />
      ) : tools.length === 0 ? (
        <EmptyState title="暂无工具" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tools.map((tool) => {
            const cs = CAT_STYLE[tool.category] || CAT_STYLE.general
            const permissions = parseList(tool.permissions)
            const tags = parseList(tool.tags)
            return (
              <Surface key={tool.name} variant="panel" className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`p-1.5 rounded-lg border ${cs.bg} ${cs.text} ${cs.border}`}>
                      {CAT_ICONS[tool.category] || <Wrench size={14} />}
                    </span>
                    <div>
                      <div className="font-semibold text-white text-sm">{tool.name}</div>
                      <div className={`text-xs mt-0.5 ${cs.text}`}>{tool.category}</div>
                    </div>
                  </div>
                  <GlowButton
                    variant={tool.enabled ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => toggleTool(tool)}
                  >
                    {tool.enabled ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                    <Power size={11} />
                    {tool.enabled ? '已启用' : '已禁用'}
                  </GlowButton>
                </div>

                <p className="text-sm text-slate-400 leading-relaxed mb-3">{tool.description}</p>

                <div className="space-y-1.5 text-xs">
                  <div className="flex gap-2">
                    <span className="text-slate-600 w-12 shrink-0">输入</span>
                    <span className="text-slate-400 font-mono break-all">{compactSchema(tool.input_schema)}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-slate-600 w-12 shrink-0">输出</span>
                    <span className="text-slate-400 font-mono break-all">{compactSchema(tool.output_schema)}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-slate-600 w-12 shrink-0">权限</span>
                    <span className="text-cyan-400">{permissions.join(', ') || '[]'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-600 w-12 shrink-0">风险</span>
                    <RiskDot level={tool.risk_level} />
                    <span className={tool.risk_level === 'low' ? 'text-jade-400' : tool.risk_level === 'medium' ? 'text-ember-400' : 'text-crimson-400'}>
                      {tool.risk_level}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-slate-600 w-12 shrink-0">超时</span>
                    <span className="text-slate-500">{tool.timeout_seconds}s</span>
                  </div>
                  {tags.length > 0 && (
                    <div className="flex gap-2">
                      <span className="text-slate-600 w-12 shrink-0">标签</span>
                      <span className="text-slate-500">{tags.join(', ')}</span>
                    </div>
                  )}
                </div>
              </Surface>
            )
          })}
        </div>
      )}
    </div>
  )
}
