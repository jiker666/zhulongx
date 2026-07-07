import { memo } from 'react'
import clsx from 'clsx'

interface Props { variant?: 'panel' | 'glass' | 'elevated' | 'danger' | 'success'; className?: string; children: React.ReactNode; glow?: 'ember' | 'cyan' | 'crimson' | 'jade' }

const VARIANT: Record<string, string> = {
  panel:    'bg-obsidian-800/80 border border-obsidian-500/40',
  glass:    'bg-obsidian-800/60 backdrop-blur-md border border-obsidian-500/30',
  elevated: 'bg-obsidian-700/60 border border-obsidian-500/50',
  danger:   'bg-crimson-500/5 border border-crimson-500/30',
  success:  'bg-jade-500/5 border border-jade-500/30',
}

const GLOW: Record<string, string> = {
  ember:   'shadow-[0_0_20px_rgba(251,191,36,0.1)]',
  cyan:    'shadow-[0_0_20px_rgba(6,182,212,0.1)]',
  crimson: 'shadow-[0_0_15px_rgba(239,68,68,0.12)]',
  jade:    'shadow-[0_0_15px_rgba(34,197,94,0.1)]',
}

const Surface = memo(function Surface({ variant = 'panel', className = '', children, glow }: Props) {
  return (
    <div className={clsx('rounded-2xl', VARIANT[variant], glow && GLOW[glow], className)}>
      {children}
    </div>
  )
})

export default Surface
