import { useEffect, useState } from 'react'
import { getTools, setToolEnabled, Tool } from '../api'
import { Wrench, Loader2, Globe, Code2, FileText, BarChart2, CheckCircle2, XCircle, Power } from 'lucide-react'

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  web: <Globe size={16} />,
  code: <Code2 size={16} />,
  audit: <Code2 size={16} />,
  file: <FileText size={16} />,
  log: <BarChart2 size={16} />,
  general: <Wrench size={16} />,
}

const CATEGORY_COLORS: Record<string, string> = {
  web: 'text-cyan-400 bg-cyan-400/10',
  code: 'text-purple-400 bg-purple-400/10',
  audit: 'text-purple-400 bg-purple-400/10',
  file: 'text-yellow-400 bg-yellow-400/10',
  log: 'text-green-400 bg-green-400/10',
  general: 'text-gray-400 bg-gray-400/10',
}

function parseJson(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function compactSchema(value: string): string {
  const parsed = parseJson(value)
  if (typeof parsed === 'string') return parsed
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

  const loadTools = () => getTools().then(r => setTools(r.data))

  useEffect(() => {
    loadTools().finally(() => setLoading(false))
  }, [])

  const toggleTool = async (tool: Tool) => {
    const next = !tool.enabled
    await setToolEnabled(tool.name, next)
    await loadTools()
  }

  const enabled = tools.filter(t => t.enabled)
  const disabled = tools.filter(t => !t.enabled)

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">工具中心</h1>
        <p className="text-gray-400 text-sm mt-1">已注册的安全分析工具插件 · {enabled.length} 已启用 / {disabled.length} 已禁用</p>
        <p className="text-xs text-cyan-300 mt-2">演示模式：默认工具均为只读低风险，禁用后 Planner 不会再选择该工具。</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-400">
          <Loader2 className="animate-spin" size={18} /> 加载中...
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tools.map(tool => {
            const permissions = parseList(tool.permissions)
            const tags = parseList(tool.tags)
            return (
              <div key={tool.name} className="bg-[#111827] border border-[#1f2937] rounded-xl p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`p-1.5 rounded ${CATEGORY_COLORS[tool.category] || CATEGORY_COLORS.general}`}>
                      {CATEGORY_ICONS[tool.category] || <Wrench size={16} />}
                    </span>
                    <div>
                      <div className="font-semibold text-white text-sm">{tool.name}</div>
                      <div className={`text-xs mt-0.5 ${CATEGORY_COLORS[tool.category] || CATEGORY_COLORS.general}`}>
                        {tool.category}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => toggleTool(tool)}
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded font-medium transition-colors ${
                      tool.enabled
                        ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                        : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                    }`}
                    title={tool.enabled ? '禁用工具' : '启用工具'}
                  >
                    {tool.enabled ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                    <Power size={11} />
                    {tool.enabled ? '已启用' : '已禁用'}
                  </button>
                </div>

                <p className="text-sm text-gray-400 leading-relaxed mb-3">{tool.description}</p>

                <div className="space-y-1.5">
                  <div className="flex gap-2 text-xs">
                    <span className="text-gray-600 w-16 shrink-0">输入</span>
                    <span className="text-gray-400 font-mono break-all">{compactSchema(tool.input_schema)}</span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="text-gray-600 w-16 shrink-0">输出</span>
                    <span className="text-gray-400 font-mono break-all">{compactSchema(tool.output_schema)}</span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="text-gray-600 w-16 shrink-0">权限</span>
                    <span className="text-cyan-400">{permissions.join(', ') || '[]'}</span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="text-gray-600 w-16 shrink-0">风险</span>
                    <span className={tool.risk_level === 'low' ? 'text-green-400' : 'text-yellow-400'}>{tool.risk_level}</span>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <span className="text-gray-600 w-16 shrink-0">超时</span>
                    <span className="text-gray-500">{tool.timeout_seconds}s</span>
                  </div>
                  {tags.includes('final_ops') && (
                    <div className="flex gap-2 text-xs">
                      <span className="text-gray-600 w-16 shrink-0">决赛</span>
                      <span className="text-cyan-400">适合 FinalOps</span>
                    </div>
                  )}
                  {tags.length > 0 && (
                    <div className="flex gap-2 text-xs">
                      <span className="text-gray-600 w-16 shrink-0">标签</span>
                      <span className="text-gray-500">{tags.join(', ')}</span>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
