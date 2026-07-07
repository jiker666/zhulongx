import { memo } from 'react'
import clsx from 'clsx'
import { statusStyle } from '../../styles/tokens'

interface Props { state: string; label?: string; pulse?: boolean; className?: string }

const StatusBadge = memo(function StatusBadge({ state, label, pulse, className }: Props) {
  const s = statusStyle(state)
  return (
    <span role="status" aria-live="polite" className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border', s.bg, s.text, s.border, className)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', s.dot, pulse && 'animate-pulse')} aria-hidden="true" />
      {label ?? state}
    </span>
  )
})

export default StatusBadge
