import { cn } from '../../lib/cn'
import { toneClass, type Tone } from '../../lib/status'

interface RingGaugeProps {
  value: number
  label: string
  detail?: string
  tone?: Tone
  size?: number
  className?: string
}

export default function RingGauge({ value, label, detail, tone = 'ember', size = 112, className }: RingGaugeProps) {
  const safe = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))
  const r = 42
  const c = 2 * Math.PI * r
  const dash = (safe / 100) * c
  const styles = toneClass[tone]
  return (
    <div className={cn('inline-flex items-center gap-4', className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="-rotate-90">
          <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="9" />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`}
            className={styles.text}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-xl font-bold tabular-nums text-white">{Math.round(safe)}%</div>
      </div>
      <div>
        <div className="text-sm font-semibold text-white">{label}</div>
        {detail && <div className="mt-1 text-xs leading-5 text-slate-400">{detail}</div>}
      </div>
    </div>
  )
}
