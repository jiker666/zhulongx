import { type ReactNode } from 'react'
import { cn } from '../../lib/cn'

interface SectionShellProps {
  title: string
  eyebrow?: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}

export default function SectionShell({ title, eyebrow, description, action, children, className }: SectionShellProps) {
  return (
    <section className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {eyebrow && <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-ember-300">{eyebrow}</div>}
          <h2 className="mt-1 text-lg font-semibold text-white">{title}</h2>
          {description && <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
