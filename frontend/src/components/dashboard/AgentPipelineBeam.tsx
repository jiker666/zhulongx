import { CheckCircle2, FileSearch, Flag, PenTool, Play, Route, ScanSearch, Shield } from 'lucide-react'
import { pipelineStages } from '../../styles/design-system'
import { cn } from '../../lib/cn'
import { toneClass, type Tone } from '../../lib/status'

const ICONS = [FileSearch, ScanSearch, Route, FileSearch, Play, Shield, Flag, PenTool]

interface AgentPipelineBeamProps {
  activeIndex?: number
}

export default function AgentPipelineBeam({ activeIndex = 0 }: AgentPipelineBeamProps) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-cyan-500/20 bg-obsidian-900/70 p-4">
      <div className="absolute left-0 top-1/2 hidden h-px w-full -translate-y-1/2 bg-gradient-to-r from-ember-500/0 via-cyan-300/30 to-jade-400/0 md:block" aria-hidden="true" />
      <div className="absolute top-1/2 hidden h-px w-1/3 -translate-y-1/2 bg-gradient-to-r from-transparent via-ember-300/70 to-transparent md:block motion-safe:animate-scan" aria-hidden="true" />
      <div className="relative grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        {pipelineStages.map((stage, index) => {
          const Icon = ICONS[index] ?? CheckCircle2
          const tone = toneClass[stage.tone as Tone]
          const active = index <= activeIndex
          return (
            <div
              key={stage.key}
              className={cn(
                'rounded-lg border px-3 py-3 text-center',
                active ? `${tone.bg} ${tone.border}` : 'border-slate-700/50 bg-obsidian-950/55',
              )}
            >
              <div className={cn('mx-auto flex h-9 w-9 items-center justify-center rounded-lg border', active ? `${tone.border} ${tone.text}` : 'border-slate-700 text-slate-500')}>
                <Icon size={16} />
              </div>
              <div className="mt-2 text-xs font-medium text-white">{stage.label}</div>
              <div className={cn('mt-1 text-[10px] uppercase tracking-[0.16em]', active ? tone.text : 'text-slate-600')}>
                {active ? 'linked' : 'standby'}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
