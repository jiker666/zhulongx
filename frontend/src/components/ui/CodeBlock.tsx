import { memo } from 'react'
import clsx from 'clsx'
import CopyButton from './CopyButton'

interface Props { code: string; language?: string; title?: string; className?: string }

const CodeBlock = memo(function CodeBlock({ code, language, title, className }: Props) {
  return (
    <div className={clsx('relative rounded-xl bg-obsidian-950 border border-obsidian-500/40 overflow-hidden', className)}>
      {title && (
        <div className="flex items-center justify-between px-4 py-2 border-b border-obsidian-500/30 bg-obsidian-900/50">
          <span className="text-xs text-slate-400 font-mono">{title}</span>
          <CopyButton text={code} />
        </div>
      )}
      <pre className="p-4 text-sm font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
        <code>{code}</code>
      </pre>
      {!title && <CopyButton text={code} className="absolute top-2 right-2" />}
    </div>
  )
})

export default CodeBlock
