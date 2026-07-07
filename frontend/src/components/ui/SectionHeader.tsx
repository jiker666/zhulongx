import { memo, type ReactNode } from 'react'
import clsx from 'clsx'

interface Props { title?: string; icon?: ReactNode; badge?: string; action?: { label: string; onClick: () => void }; children?: ReactNode; className?: string }

const SectionHeader = memo(function SectionHeader({ title, icon, badge, action, children, className }: Props) {
  return (
    <div className={clsx('flex items-center gap-3 mb-4', className)}>
      {icon && <span className="text-ember-400">{icon}</span>}
      {title && <h2 className="text-sm font-semibold uppercase tracking-wider text-ember-300">{title}</h2>}
      {badge && <span className="text-[10px] text-slate-500 font-mono">{badge}</span>}
      {action && <button onClick={action.onClick} className="text-xs text-ember-400 hover:text-ember-300 ml-auto">{action.label}</button>}
      {children}
    </div>
  )
})

export default SectionHeader
