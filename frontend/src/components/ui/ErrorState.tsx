import { memo } from 'react'
import { AlertTriangle } from 'lucide-react'
import GlowButton from './GlowButton'

interface Props { title?: string; detail?: string; onRetry?: () => void }

const ErrorState = memo(function ErrorState({ title = '作战中枢暂时离线', detail, onRetry }: Props) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <AlertTriangle className="text-crimson-400 mb-3" size={36} aria-hidden="true" />
      <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
      {detail && <p className="text-sm text-slate-400 max-w-sm mb-6">{detail}</p>}
      {onRetry && <GlowButton variant="danger" size="sm" onClick={onRetry} aria-label="重新连接">重新连接</GlowButton>}
    </div>
  )
})

export default ErrorState
