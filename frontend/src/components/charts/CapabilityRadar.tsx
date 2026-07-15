import { toneClass } from '../../lib/status'

export interface RadarMetric {
  label: string
  value: number
}

interface CapabilityRadarProps {
  metrics: RadarMetric[]
  size?: number
}

function point(index: number, total: number, radius: number, center: number) {
  const angle = -Math.PI / 2 + (index / total) * Math.PI * 2
  return [center + Math.cos(angle) * radius, center + Math.sin(angle) * radius]
}

export default function CapabilityRadar({ metrics, size = 220 }: CapabilityRadarProps) {
  const center = 120
  const maxR = 78
  const safeMetrics = metrics.length > 2 ? metrics : [
    { label: 'Web', value: 0 },
    { label: 'Crypto', value: 0 },
    { label: 'Reverse', value: 0 },
  ]
  const polygon = safeMetrics.map((m, i) => {
    const [x, y] = point(i, safeMetrics.length, maxR * Math.max(0.06, Math.min(1, m.value / 100)), center)
    return `${x},${y}`
  }).join(' ')

  return (
    <div className="w-full overflow-hidden rounded-lg border border-cyan-500/20 bg-obsidian-950/40 p-3">
      <svg viewBox="0 0 240 240" width={size} height={size} className="mx-auto max-w-full">
        {[0.25, 0.5, 0.75, 1].map((scale) => (
          <polygon
            key={scale}
            points={safeMetrics.map((_, i) => point(i, safeMetrics.length, maxR * scale, center).join(',')).join(' ')}
            fill="none"
            stroke="rgba(148,163,184,0.16)"
            strokeWidth="1"
          />
        ))}
        {safeMetrics.map((m, i) => {
          const [x, y] = point(i, safeMetrics.length, maxR, center)
          const [lx, ly] = point(i, safeMetrics.length, maxR + 24, center)
          return (
            <g key={m.label}>
              <line x1={center} y1={center} x2={x} y2={y} stroke="rgba(148,163,184,0.14)" />
              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" className="fill-slate-300 text-[10px] font-medium">
                {m.label}
              </text>
            </g>
          )
        })}
        <polygon points={polygon} fill="rgba(34,211,238,0.18)" stroke="rgb(34,211,238)" strokeWidth="2" />
        <circle cx={center} cy={center} r="3" className={toneClass.ember.text} fill="currentColor" />
      </svg>
    </div>
  )
}
