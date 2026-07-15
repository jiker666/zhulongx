import { type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { toneClass, type Tone } from '../../lib/status'

interface GlassPanelProps {
  children: ReactNode
  className?: string
  tone?: Tone
  compact?: boolean
  as?: 'div' | 'section' | 'article'
}

export default function GlassPanel({ children, className, tone = 'slate', compact, as: Tag = 'div' }: GlassPanelProps) {
  const toneStyles = toneClass[tone]
  return (
    <Tag
      className={cn(
        'relative overflow-hidden rounded-lg border bg-obsidian-900/72 backdrop-blur-xl shadow-glass',
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-white/10',
        toneStyles.border,
        compact ? 'p-3' : 'p-4 md:p-5',
        className,
      )}
    >
      <div className="relative z-10">{children}</div>
    </Tag>
  )
}
