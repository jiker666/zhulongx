import { memo } from 'react'

interface Props { className?: string; compact?: boolean }

const BrandWordmark = memo(function BrandWordmark({ className = '', compact = false }: Props) {
  return (
    <div className={`flex flex-col leading-none ${className}`}>
      <span className="text-lg font-bold tracking-wider text-white">
        烛龙<span className="text-ember-400">X</span>
      </span>
      {!compact && (
        <span className="text-[10px] font-medium tracking-[0.2em] text-slate-400 mt-0.5">
          ZHULONG-X
        </span>
      )}
    </div>
  )
})

export default BrandWordmark
