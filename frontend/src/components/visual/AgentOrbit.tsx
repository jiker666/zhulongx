import { memo } from 'react'

interface Props { size?: number; className?: string; activeTool?: string }

const TOOL_NAMES = ['read_file', 'run_shell', 'run_python', 'grep', 'submit_flag', 'list_dir', 'write_file', 'extract_archive']

const AgentOrbit = memo(function AgentOrbit({ size = 200, className = '', activeTool }: Props) {
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.35
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className} aria-hidden="true">
      <defs>
        <radialGradient id="orbit-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.12" />
          <stop offset="100%" stopColor="transparent" />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={size * 0.45} fill="url(#orbit-glow)" />
      <g className="orbit-ring-1">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(251,191,36,0.08)" strokeWidth="1" strokeDasharray="4 6">
          <animateTransform attributeName="transform" type="rotate" from={`0 ${cx} ${cy}`} to={`360 ${cx} ${cy}`} dur="60s" repeatCount="indefinite" />
        </circle>
      </g>
      <g className="orbit-ring-2">
        <circle cx={cx} cy={cy} r={r * 0.6} fill="none" stroke="rgba(6,182,212,0.06)" strokeWidth="1" strokeDasharray="3 8">
          <animateTransform attributeName="transform" type="rotate" from={`360 ${cx} ${cy}`} to={`0 ${cx} ${cy}`} dur="90s" repeatCount="indefinite" />
        </circle>
      </g>
      {TOOL_NAMES.map((name, i) => {
        const angle = (i / TOOL_NAMES.length) * Math.PI * 2 - Math.PI / 2
        const x = cx + r * Math.cos(angle)
        const y = cy + r * Math.sin(angle)
        const isActive = name === activeTool
        return (
          <g key={name}>
            <title>{name}</title>
            <circle cx={x} cy={y} r={isActive ? 6 : 3.5} fill={isActive ? '#fbbf24' : 'rgba(255,255,255,0.15)'} opacity={isActive ? 1 : 0.5} />
            {isActive && (
              <g className="orbit-pulse">
                <circle cx={x} cy={y} r={10} fill="none" stroke="#fbbf24" strokeWidth="1" opacity="0.4">
                  <animate attributeName="r" from="6" to="14" dur="1.5s" repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.5" to="0" dur="1.5s" repeatCount="indefinite" />
                </circle>
              </g>
            )}
            <text x={x} y={y + 16} textAnchor="middle" fill={isActive ? '#fbbf24' : 'rgba(148,163,184,0.5)'} fontSize="7" fontFamily="monospace">{name.slice(0, 8)}</text>
          </g>
        )
      })}
      <circle cx={cx} cy={cy} r={10} fill="#0a0e1a" stroke="#fbbf24" strokeWidth="1.5" />
      <g className="orbit-center-pulse">
        <circle cx={cx} cy={cy} r={4} fill="#fbbf24" opacity="0.7">
          <animate attributeName="opacity" values="0.5;1;0.5" dur="3s" repeatCount="indefinite" />
        </circle>
      </g>
    </svg>
  )
})

export default AgentOrbit
