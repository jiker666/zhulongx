import { memo, type ReactNode } from 'react'
import clsx from 'clsx'
import Surface from './Surface'

interface Props {
  label: string; value: string | number; unit?: string; icon?: ReactNode
  trend?: 'up' | 'down' | 'flat'; hint?: string; className?: string
}

const TREND: Record<string, string> = { up: 'text-jade-400', down: 'text-crimson-400', flat: 'text-slate-400' }
const TREND_ICON: Record<string, string> = { up: '↑', down: '↓', flat: '→' }

const MetricCard = memo(function MetricCard({ label, value, unit, icon, trend, hint, className }: Props) {
  return (
    <Surface variant="panel" className={clsx('p-5 flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400 uppercase tracking-wider">{label}</span>
        {icon && <span className="text-ember-400 opacity-60">{icon}</span>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-white tabular-nums">{value}</span>
        {unit && <span className="text-sm text-slate-400">{unit}</span>}
      </div>
      {(trend || hint) && (
        <div className="flex items-center gap-2 text-xs">
          {trend && <span className={TREND[trend]}>{TREND_ICON[trend]}</span>}
          {hint && <span className="text-slate-500">{hint}</span>}
        </div>
      )}
    </Surface>
  )
})

export default MetricCard
