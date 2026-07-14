import { FileText, Plus, ShieldCheck, Upload } from 'lucide-react'
import { type HealthStatus } from '../../api'
import { GlassPanel, GlowButton } from '../ui'

export interface FinalOpsCreateForm {
  name: string
  challenge_type: string
  target: string
  assignee: string
  priority: string
  description: string
}

interface FinalOpsSidebarProps {
  types: string[]
  form: FinalOpsCreateForm
  importText: string
  casePath: string
  health: HealthStatus | null
  onFormChange: (form: FinalOpsCreateForm) => void
  onImportTextChange: (value: string) => void
  onCasePathChange: (value: string) => void
  onCreate: () => void
  onImport: () => void
  onCopyCommand: (mode: 'solve' | 'eval' | 'both') => void
}

export default function FinalOpsSidebar({
  types,
  form,
  importText,
  casePath,
  health,
  onFormChange,
  onImportTextChange,
  onCasePathChange,
  onCreate,
  onImport,
  onCopyCommand,
}: FinalOpsSidebarProps) {
  return (
    <aside className="space-y-4">
      <GlassPanel tone="ember" className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white"><Plus size={15} className="text-ember-300" /> 新建 Challenge</div>
        <input className="input" placeholder="题目名称" value={form.name} onChange={(event) => onFormChange({ ...form, name: event.target.value })} />
        <div className="grid grid-cols-2 gap-2">
          <select className="input" value={form.challenge_type} onChange={(event) => onFormChange({ ...form, challenge_type: event.target.value })}>
            {types.map((type) => <option key={type}>{type}</option>)}
          </select>
          <select className="input" value={form.priority} onChange={(event) => onFormChange({ ...form, priority: event.target.value })}>
            <option>high</option><option>medium</option><option>low</option>
          </select>
        </div>
        <input className="input" placeholder="目标 URL/IP" value={form.target} onChange={(event) => onFormChange({ ...form, target: event.target.value })} />
        <input className="input" placeholder="负责人" value={form.assignee} onChange={(event) => onFormChange({ ...form, assignee: event.target.value })} />
        <textarea className="input min-h-[86px]" placeholder="题目描述" value={form.description} onChange={(event) => onFormChange({ ...form, description: event.target.value })} />
        <GlowButton className="w-full" onClick={onCreate}><Plus size={14} /> 创建</GlowButton>
      </GlassPanel>

      <GlassPanel tone="cyan" className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white"><Upload size={15} className="text-cyan-300" /> 批量导入</div>
        <textarea className="input min-h-[128px] font-mono text-xs" placeholder="JSON / CSV / Markdown 题单" value={importText} onChange={(event) => onImportTextChange(event.target.value)} />
        <GlowButton variant="secondary" className="w-full" onClick={onImport}><Upload size={14} /> 导入题单</GlowButton>
      </GlassPanel>

      <GlassPanel tone="violet" className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white"><FileText size={15} className="text-violet-300" /> Team Drill</div>
        <input className="input font-mono text-xs" value={casePath} onChange={(event) => onCasePathChange(event.target.value)} placeholder="ctf_cases/case01" />
        <div className="grid grid-cols-2 gap-2 text-xs">
          {['Blind Solve', 'RAG Disabled', 'History Disabled', 'Search Disabled'].map((label) => (
            <div key={label} className="rounded-lg border border-slate-800 bg-obsidian-950/45 px-3 py-2">
              <div className="text-slate-500">{label}</div>
              <div className="font-mono text-jade-300">ON</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <GlowButton variant="secondary" size="sm" onClick={() => onCopyCommand('solve')}>Solve</GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={() => onCopyCommand('eval')}>Eval</GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={() => onCopyCommand('both')}>Both</GlowButton>
        </div>
      </GlassPanel>

      <GlassPanel tone="jade" className="space-y-2 text-xs leading-5 text-slate-400">
        <div className="flex items-center gap-2 text-sm font-semibold text-white"><ShieldCheck size={15} className="text-jade-300" /> Scope</div>
        <div>Mode: <span className="text-slate-200">{health?.scope_config_summary?.competition_mode ? 'competition' : 'safe'}</span></div>
        <div>CIDR: <span className="text-slate-200">{health?.scope_config_summary?.cidrs?.join(', ') || '(empty)'}</span></div>
        <div>Domain: <span className="text-slate-200">{health?.scope_config_summary?.domains?.join(', ') || '(empty)'}</span></div>
        <div>Ports: <span className="text-slate-200">{health?.scope_config_summary?.ports?.join(', ') || 'any'}</span></div>
      </GlassPanel>
    </aside>
  )
}
