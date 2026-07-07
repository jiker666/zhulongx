import { memo, useState } from 'react'
import clsx from 'clsx'
import { Copy, Check } from 'lucide-react'

interface Props { text: string; className?: string; label?: string }

const CopyButton = memo(function CopyButton({ text, className, label }: Props) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })
  }
  return (
    <button onClick={handleCopy} className={clsx('inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors', copied ? 'text-jade-400 bg-jade-500/10' : 'text-slate-400 hover:text-white hover:bg-obsidian-700/40', className)} title={label ?? '复制'}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {label && <span>{label}</span>}
    </button>
  )
})

export default CopyButton
