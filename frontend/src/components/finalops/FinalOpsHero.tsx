import { Clipboard, Download, RefreshCw, ShieldCheck, Upload, Zap } from 'lucide-react'
import { type HealthStatus } from '../../api'
import { GlassPanel, GlowButton, StatePill } from '../ui'

interface FinalOpsHeroProps {
  health: HealthStatus | null
  running: number
  submitted: number
  candidates: number
  solved: number
  onRefresh: () => void
  onDebrief: () => void
  onExport: () => void
  onImport: () => void
}

export default function FinalOpsHero({ health, running, submitted, candidates, solved, onRefresh, onDebrief, onExport, onImport }: FinalOpsHeroProps) {
  const stats = [
    { label: 'Running', value: running, className: 'text-cyan-300' },
    { label: 'Submitted', value: submitted, className: 'text-violet-300' },
    { label: 'Candidates', value: candidates, className: 'text-ember-300' },
    { label: 'Solved', value: solved, className: 'text-jade-300' },
  ]
  return (
    <GlassPanel tone="ember" className="p-0">
      <div className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:p-6">
        <div>
          <div className="mb-4 flex flex-wrap gap-2">
            <StatePill tone={health?.scope_config_summary?.competition_mode ? 'jade' : 'slate'} icon={<Zap size={13} />}>
              Competition {health?.scope_config_summary?.competition_mode ? 'ON' : 'OFF'}
            </StatePill>
            <StatePill tone={health?.scope_config_summary?.configured ? 'cyan' : 'ember'} icon={<ShieldCheck size={13} />}>
              Scope {health?.scope_config_summary?.configured ? 'configured' : 'empty'}
            </StatePill>
            <StatePill tone={health?.llm?.enabled ? 'violet' : 'cyan'}>
              LLM {health?.llm?.enabled ? health.llm.model : 'rule'}
            </StatePill>
          </div>
          <h1 className="text-3xl font-black text-white md:text-5xl">FinalOps 决赛团队作战台</h1>
          <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-300">
            面向决赛现场的题目流转、候选答案、Brief/Debrief、提交状态、备份导入导出与安全边界复核。
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:min-w-[520px]">
          {stats.map(({ label, value, className }) => (
            <div key={label} className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3">
              <div className="text-[11px] text-slate-500">{label}</div>
              <div className={`mt-1 text-2xl font-bold tabular-nums ${className}`}>{value}</div>
            </div>
          ))}
          <div className="col-span-2 flex flex-wrap gap-2 sm:col-span-4">
            <GlowButton variant="secondary" size="sm" onClick={onRefresh}><RefreshCw size={13} /> 刷新</GlowButton>
            <GlowButton variant="secondary" size="sm" onClick={onDebrief}><Clipboard size={13} /> Debrief</GlowButton>
            <GlowButton variant="secondary" size="sm" onClick={onExport}><Download size={13} /> 导出备份</GlowButton>
            <GlowButton variant="secondary" size="sm" onClick={onImport}><Upload size={13} /> 导入备份</GlowButton>
          </div>
        </div>
      </div>
    </GlassPanel>
  )
}
