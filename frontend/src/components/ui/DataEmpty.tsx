import { type ReactNode } from 'react'
import { FileSearch } from 'lucide-react'
import GlowButton from './GlowButton'

interface DataEmptyProps {
  title: string
  description?: string
  icon?: ReactNode
  actionLabel?: string
  onAction?: () => void
}

export default function DataEmpty({ title, description, icon, actionLabel, onAction }: DataEmptyProps) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-slate-700/70 bg-obsidian-900/45 px-4 py-8 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-ember-500/20 bg-ember-500/10 text-ember-300">
        {icon ?? <FileSearch size={18} />}
      </div>
      <div className="text-sm font-semibold text-white">{title}</div>
      {description && <p className="mt-1 max-w-md text-xs leading-5 text-slate-400">{description}</p>}
      {actionLabel && onAction && (
        <GlowButton className="mt-4" size="sm" onClick={onAction}>
          {actionLabel}
        </GlowButton>
      )}
    </div>
  )
}
