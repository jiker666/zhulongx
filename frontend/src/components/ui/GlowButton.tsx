import { memo, type ButtonHTMLAttributes } from 'react'
import clsx from 'clsx'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'
type Size = 'sm' | 'md' | 'lg'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant; size?: Size; loading?: boolean; glowing?: boolean
}

const BASE = 'inline-flex items-center justify-center gap-2 font-medium transition-all duration-150 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-ember-400 focus-visible:outline-offset-2'

const V: Record<Variant, string> = {
  primary:   'bg-ember-500 text-obsidian-950 hover:bg-ember-400 shadow-sm',
  secondary: 'bg-obsidian-700/80 text-slate-300 border border-obsidian-500/60 hover:bg-obsidian-600/80 hover:text-white',
  danger:    'bg-crimson-600/80 text-white hover:bg-crimson-500 border border-crimson-500/40',
  ghost:     'text-slate-400 hover:text-white hover:bg-obsidian-700/40',
}

const S: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-xs rounded-lg',
  md: 'px-4 py-2 text-sm rounded-xl',
  lg: 'px-6 py-2.5 text-base rounded-xl',
}

const GLOW = 'shadow-[0_0_18px_rgba(251,191,36,0.2)]'

const GlowButton = memo(function GlowButton({ variant = 'primary', size = 'md', loading, glowing, className, children, disabled, type = 'button', ...rest }: Props) {
  return (
    <button type={type} className={clsx(BASE, V[variant], S[size], glowing && variant === 'primary' && GLOW, className)} disabled={disabled || loading} {...rest}>
      {loading && <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v2a6 6 0 00-6 6H4z"/></svg>}
      {children}
    </button>
  )
})

export default GlowButton
