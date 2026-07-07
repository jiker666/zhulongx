import { memo } from 'react'

interface Props { size?: number; className?: string; glowing?: boolean }

const ZhulongLogo = memo(function ZhulongLogo({ size = 40, className = '', glowing = false }: Props) {
  const id = 'zl'
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} role="img" aria-label="烛龙 X Logo">
      <defs>
        <radialGradient id={`${id}-bg`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#0a0e1a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-flame`} x1="60" y1="8" x2="60" y2="112" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#b45309" />
        </linearGradient>
        <linearGradient id={`${id}-pupil`} x1="48" y1="46" x2="72" y2="74" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#06b6d4" />
          <stop offset="100%" stopColor="#0e7490" />
        </linearGradient>
        <filter id={`${id}-glow`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {glowing && <circle cx="60" cy="60" r="58" fill={`url(#${id}-bg)`} />}
      <g filter={glowing ? `url(#${id}-glow)` : undefined}>
        <path d="M60 10 C38 10 16 34 16 60 C16 86 38 110 60 110 C82 110 104 86 104 60 C104 34 82 10 60 10Z"
              stroke={`url(#${id}-flame)`} strokeWidth="3" fill="none" opacity="0.3" />
        <path d="M60 18 C28 18 10 46 22 72 C28 86 44 100 60 100 C76 100 92 86 98 72 C110 46 92 18 60 18Z"
              fill={`url(#${id}-flame)`} opacity="0.08" />
        <path d="M42 58 Q60 22 78 58 Q60 94 42 58Z" fill={`url(#${id}-flame)`} opacity="0.7" />
        <path d="M48 60 Q60 34 72 60 Q60 86 48 60Z" fill="#0a0e1a" opacity="0.6" />
        <ellipse cx="60" cy="60" rx="10" ry="18" fill={`url(#${id}-pupil)`} opacity="0.9" />
        <ellipse cx="60" cy="60" rx="4" ry="10" fill="#0a0e1a" />
        <circle cx="57" cy="52" r="2.5" fill="#fbbf24" opacity="0.8" />
        <path d="M16 60 L4 60 M104 60 L116 60 M60 10 L60 -2 M60 110 L60 122"
              stroke="#fbbf24" strokeWidth="2" opacity="0.25" strokeLinecap="round" />
        <circle cx="4" cy="60" r="2" fill="#fbbf24" opacity="0.3" />
        <circle cx="116" cy="60" r="2" fill="#fbbf24" opacity="0.3" />
        <circle cx="60" cy="-2" r="2" fill="#fbbf24" opacity="0.3" />
        <circle cx="60" cy="122" r="2" fill="#fbbf24" opacity="0.3" />
      </g>
    </svg>
  )
})

export default ZhulongLogo
