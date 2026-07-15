import { type ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { toneClass, type Tone } from '../../lib/status'

interface StatePillProps {
  children: ReactNode
  tone?: Tone
  icon?: ReactNode
  pulse?: boolean
  className?: string
}

export default function StatePill({ children, tone = 'slate', icon, pulse, className }: StatePillProps) {
  const styles = toneClass[tone]
  return (
    <span
      className={cn(
        'inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        styles.bg,
        styles.text,
        styles.border,
        className,
      )}
    >
      {icon ?? <span className={cn('h-1.5 w-1.5 rounded-full', styles.dot, pulse && 'animate-pulse')} aria-hidden="true" />}
      {children}
    </span>
  )
}
