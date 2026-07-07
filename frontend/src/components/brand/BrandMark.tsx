import { memo } from 'react'

interface Props { size?: number; className?: string }

const BrandMark = memo(function BrandMark({ size = 32, className = '' }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <defs>
        <linearGradient id="bm-flame" x1="16" y1="2" x2="16" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#b45309" />
        </linearGradient>
      </defs>
      <path d="M16 2 C6 2 2 10 4 18 C5 22 10 28 16 30 C22 28 27 22 28 18 C30 10 26 2 16 2Z"
            fill="url(#bm-flame)" opacity="0.15" />
      <path d="M10 16 Q16 6 22 16 Q16 26 10 16Z" fill="url(#bm-flame)" opacity="0.8" />
      <ellipse cx="16" cy="16" rx="3" ry="6" fill="#06b6d4" opacity="0.9" />
      <ellipse cx="16" cy="16" rx="1.2" ry="3.5" fill="#0a0e1a" />
      <circle cx="14.5" cy="13.5" r="1" fill="#fbbf24" opacity="0.7" />
    </svg>
  )
})

export default BrandMark
