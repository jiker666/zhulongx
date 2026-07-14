import { type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { toneClass, type Tone } from '../../lib/status'

export interface TimelineItem {
  id: string | number
  title: ReactNode
  eyebrow?: ReactNode
  body?: ReactNode
  meta?: ReactNode
  tone?: Tone
  active?: boolean
}

interface TimelineProps {
  items: TimelineItem[]
  empty?: ReactNode
  className?: string
}

export default function Timeline({ items, empty, className }: TimelineProps) {
  if (items.length === 0) return <>{empty ?? null}</>
  return (
    <ol className={cn('space-y-3', className)}>
      {items.map((item) => {
        const tone = toneClass[item.tone ?? 'slate']
        return (
          <li key={item.id} className="relative grid grid-cols-[18px_1fr] gap-3">
            <div className="flex flex-col items-center">
              <span className={cn('mt-1 h-2.5 w-2.5 rounded-full ring-4', tone.dot, tone.ring, item.active && 'animate-pulse')} />
              <span className="mt-2 h-full w-px bg-slate-700/60" aria-hidden="true" />
            </div>
            <div className={cn('rounded-lg border px-3 py-2.5', tone.bg, tone.border)}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  {item.eyebrow && <div className={cn('mb-1 text-[10px] font-semibold uppercase tracking-wider', tone.text)}>{item.eyebrow}</div>}
                  <div className="text-sm font-medium text-white">{item.title}</div>
                </div>
                {item.meta && <div className="text-xs text-slate-400">{item.meta}</div>}
              </div>
              {item.body && <div className="mt-2 text-xs leading-5 text-slate-300">{item.body}</div>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
