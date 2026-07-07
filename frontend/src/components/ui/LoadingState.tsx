import { memo } from 'react'
import ZhulongLogo from '../brand/ZhulongLogo'

const LoadingState = memo(function LoadingState({ message = '正在同步作战数据' }: { message?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col items-center justify-center py-16 gap-4">
      <div className="animate-pulse-glow">
        <ZhulongLogo size={36} glowing />
      </div>
      <span className="text-sm text-slate-400">{message}</span>
    </div>
  )
})

export default LoadingState
