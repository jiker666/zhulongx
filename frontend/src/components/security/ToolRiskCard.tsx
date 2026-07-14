import { CheckCircle2, FileText, Power, Wrench, XCircle } from 'lucide-react'
import { type Tool } from '../../api'
import { categoryTone, toneForRisk } from '../../lib/status'
import { GlassPanel, GlowButton, StatePill } from '../ui'
import PermissionPillGroup from './PermissionPillGroup'

interface ToolRiskCardProps {
  tool: Tool
  permissions: string[]
  tags: string[]
  input: string
  output: string
  toggling?: boolean
  onToggle: () => void
}

export default function ToolRiskCard({ tool, permissions, tags, input, output, toggling, onToggle }: ToolRiskCardProps) {
  return (
    <GlassPanel tone={toneForRisk(tool.risk_level)} className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-cyan-300">
            <Wrench size={17} />
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-white">{tool.name}</h3>
            <div className="mt-1 flex flex-wrap gap-2">
              <StatePill tone={categoryTone(tool.category)} className="min-h-6 px-2 py-0.5">{tool.category || 'general'}</StatePill>
              <StatePill tone={toneForRisk(tool.risk_level)} className="min-h-6 px-2 py-0.5">{tool.risk_level || 'unknown'}</StatePill>
            </div>
          </div>
        </div>
        <GlowButton variant={tool.enabled ? 'primary' : 'secondary'} size="sm" onClick={onToggle} loading={toggling}>
          {tool.enabled ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
          <Power size={12} />
          {tool.enabled ? '已启用' : '已禁用'}
        </GlowButton>
      </div>

      <p className="mt-4 flex-1 text-sm leading-6 text-slate-400">{tool.description}</p>

      <div className="mt-4 space-y-3 text-xs">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-slate-500"><FileText size={12} /> 输入</div>
          <div className="break-all rounded-lg border border-slate-800 bg-obsidian-950/45 px-3 py-2 font-mono text-slate-300">{input}</div>
        </div>
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-slate-500"><FileText size={12} /> 输出</div>
          <div className="break-all rounded-lg border border-slate-800 bg-obsidian-950/45 px-3 py-2 font-mono text-slate-300">{output}</div>
        </div>
        <PermissionPillGroup permissions={permissions} />
        <div className="flex flex-wrap gap-2">
          <StatePill tone="slate">timeout {tool.timeout_seconds}s</StatePill>
          {tags.map((tag) => <StatePill key={tag} tone="slate">{tag}</StatePill>)}
        </div>
      </div>
    </GlassPanel>
  )
}
