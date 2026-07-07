import { memo, type ReactNode } from 'react'
import ZhulongLogo from '../brand/ZhulongLogo'
import GlowButton from './GlowButton'

interface Props { title: string; description?: string; action?: string; onAction?: () => void; icon?: ReactNode }

const EmptyState = memo(function EmptyState({ title, description, action, onAction, icon }: Props) {
  return (
    <div role="status" className="flex flex-col items-center justify-center py-16 px-6 text-center">
      <div className="opacity-20 mb-4" aria-hidden="true">{icon ?? <ZhulongLogo size={48} />}</div>
      <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
      {description && <p className="text-sm text-slate-400 max-w-sm mb-6">{description}</p>}
      {action && onAction && <GlowButton variant="secondary" size="sm" onClick={onAction}>{action}</GlowButton>}
    </div>
  )
})

export default EmptyState
