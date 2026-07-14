import { Binary, Bug, FileArchive, Globe2, KeyRound, Puzzle } from 'lucide-react'
import type { ElementType } from 'react'
import { capabilitySet } from '../../styles/design-system'
import { categoryTone, toneClass } from '../../lib/status'
import { cn } from '../../lib/cn'

const ICONS: Record<string, ElementType> = {
  web: Globe2,
  crypto: KeyRound,
  reverse: Binary,
  pwn: Bug,
  misc: Puzzle,
  forensics: FileArchive,
}

interface CapabilityMatrixProps {
  breakdown?: Record<string, { total: number; solved: number }>
  successRate?: Record<string, number>
}

export default function CapabilityMatrix({ breakdown = {}, successRate = {} }: CapabilityMatrixProps) {
  const categories = capabilitySet.map((cap) => {
    const stats = breakdown[cap.key] || { total: 0, solved: 0 }
    const rate = successRate[cap.key] ?? (stats.total ? (stats.solved / stats.total) * 100 : 0)
    return { ...cap, stats, rate }
  })

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {categories.map((item) => {
        const tone = toneClass[categoryTone(item.key)]
        const Icon = ICONS[item.key] ?? Puzzle
        return (
          <div key={item.key} className={cn('rounded-lg border bg-obsidian-900/65 p-4', tone.border)}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg border', tone.bg, tone.border, tone.text)}>
                  <Icon size={18} />
                </div>
                <div>
                  <div className="text-sm font-semibold text-white">{item.label}</div>
                  <div className="text-xs text-slate-500">{item.stats.solved}/{item.stats.total} 已解决</div>
                </div>
              </div>
              <div className="text-xl font-bold tabular-nums text-white">{Math.round(item.rate)}%</div>
            </div>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
              <div className={cn('h-full rounded-full', tone.dot)} style={{ width: `${Math.max(4, Math.min(100, item.rate))}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
