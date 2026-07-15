import { AlertTriangle } from 'lucide-react'
import GlowButton from './GlowButton'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  loading?: boolean
  onConfirm: () => void
  onClose: () => void
}

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  loading,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div className="w-full max-w-md rounded-lg border border-crimson-500/30 bg-obsidian-900 p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-crimson-500/10 text-crimson-300">
            <AlertTriangle size={20} />
          </div>
          <div>
            <h2 id="confirm-title" className="text-base font-semibold text-white">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">{description}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <GlowButton variant="secondary" onClick={onClose} disabled={loading}>{cancelLabel}</GlowButton>
          <GlowButton variant="danger" onClick={onConfirm} loading={loading}>{confirmLabel}</GlowButton>
        </div>
      </div>
    </div>
  )
}
