import { memo } from 'react'
import clsx from 'clsx'

interface Props { value: number; max?: number; size?: number; stroke?: number; color?: string; className?: string; label?: string }

const ProgressRing = memo(function ProgressRing({ value, max = 100, size = 64, stroke = 5, color = '#fbbf24', className, label }: Props) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const pct = Math.min(value / max, 1)
  const offset = circ * (1 - pct)
  return (
    <div role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={max} aria-label={label ? `${label}: ${Math.round(value)}%` : `${Math.round(value)}%`} className={clsx('relative inline-flex items-center justify-center', className)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" className="transition-all duration-500" />
      </svg>
      {label && <span className="absolute text-xs font-bold text-white">{label}</span>}
    </div>
  )
})

export default ProgressRing
