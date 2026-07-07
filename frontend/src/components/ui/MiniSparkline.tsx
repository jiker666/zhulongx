import { memo } from 'react'
import clsx from 'clsx'

interface Props { data: number[]; width?: number; height?: number; color?: string; className?: string }

const MiniSparkline = memo(function MiniSparkline({ data, width = 80, height = 24, color = '#fbbf24', className }: Props) {
  if (!data.length) return null
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * (height - 2) - 1}`)
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={clsx('overflow-visible', className)}>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
    </svg>
  )
})

export default MiniSparkline
