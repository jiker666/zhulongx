import { memo, type ReactNode } from 'react'
import clsx from 'clsx'

interface Props { title: string; subtitle?: string; icon?: ReactNode; action?: ReactNode; className?: string }

const PageHeader = memo(function PageHeader({ title, subtitle, icon, action, className }: Props) {
  return (
    <div className={clsx('flex items-start justify-between mb-8', className)}>
      <div>
        <div className="flex items-center gap-3 mb-1">
          {icon && <span className="text-ember-400">{icon}</span>}
          <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">{title}</h1>
        </div>
        {subtitle && <p className="text-sm text-slate-400 mt-1">{subtitle}</p>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  )
})

export default PageHeader
