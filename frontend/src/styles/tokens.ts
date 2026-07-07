export const z = {
  color: {
    obsidian: { 950: '#06080f', 900: '#0a0e1a', 800: '#0d1426', 700: '#111827', 600: '#1f2937', 500: '#374151' },
    ember:    { 50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706', 700: '#b45309' },
    cyan:     { 400: '#22d3ee', 500: '#06b6d4', 600: '#0891b2' },
    crimson:  { 400: '#f87171', 500: '#ef4444', 600: '#dc2626' },
    violet:   { 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed' },
    jade:     { 400: '#4ade80', 500: '#22c55e', 600: '#16a34a' },
    slate:    { 300: '#cbd5e1', 400: '#94a3b8', 500: '#64748b' },
  },
  radius: { lg: '0.75rem', xl: '1rem', '2xl': '1.25rem', full: '9999px' },
  shadow: {
    glow: '0 0 20px rgba(251,191,36,0.15)',
    glowCyan: '0 0 20px rgba(6,182,212,0.15)',
    glowCrimson: '0 0 15px rgba(239,68,68,0.2)',
    glowJade: '0 0 15px rgba(34,197,94,0.15)',
    glass: '0 4px 24px rgba(0,0,0,0.4)',
  },
  font: {
    hero: 'text-4xl md:text-5xl font-bold tracking-tight',
    pageTitle: 'text-2xl md:text-3xl font-bold tracking-tight',
    section: 'text-sm font-semibold uppercase tracking-wider',
    card: 'text-base font-semibold',
    body: 'text-sm',
    caption: 'text-xs text-slate-400',
    mono: 'font-mono text-sm',
  },
  space: { page: 'p-6 md:p-8', card: 'p-5 md:p-6', section: 'mb-8', gap: 'gap-4 md:gap-6' },
} as const

export const STATUS_COLORS: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  DONE:           { bg: 'bg-jade-500/10',  text: 'text-jade-400',  border: 'border-jade-500/30',  dot: 'bg-jade-400' },
  COMPLETED:      { bg: 'bg-jade-500/10',  text: 'text-jade-400',  border: 'border-jade-500/30',  dot: 'bg-jade-400' },
  VERIFY_FLAG:    { bg: 'bg-ember-500/10',  text: 'text-ember-400', border: 'border-ember-500/30',  dot: 'bg-ember-400' },
  RUNNING:        { bg: 'bg-cyan-500/10',   text: 'text-cyan-400',  border: 'border-cyan-500/30',   dot: 'bg-cyan-400' },
  AGENT_THINK:    { bg: 'bg-cyan-500/10',   text: 'text-cyan-400',  border: 'border-cyan-500/30',   dot: 'bg-cyan-400' },
  ANALYZING:      { bg: 'bg-cyan-500/10',   text: 'text-cyan-400',  border: 'border-cyan-500/30',   dot: 'bg-cyan-400' },
  INIT:           { bg: 'bg-slate-500/10',  text: 'text-slate-400', border: 'border-slate-500/20',  dot: 'bg-slate-400' },
  PENDING:        { bg: 'bg-slate-500/10',  text: 'text-slate-400', border: 'border-slate-500/20',  dot: 'bg-slate-400' },
  HUMAN_REQUIRED: { bg: 'bg-crimson-500/10', text: 'text-crimson-400', border: 'border-crimson-500/30', dot: 'bg-crimson-400' },
  FAILED:         { bg: 'bg-crimson-500/10', text: 'text-crimson-400', border: 'border-crimson-500/30', dot: 'bg-crimson-400' },
  ERROR:          { bg: 'bg-crimson-500/10', text: 'text-crimson-400', border: 'border-crimson-500/30', dot: 'bg-crimson-400' },
  PAUSED:         { bg: 'bg-violet-500/10',  text: 'text-violet-400',  border: 'border-violet-500/30',  dot: 'bg-violet-400' },
  WAITING:        { bg: 'bg-ember-500/10',  text: 'text-ember-400', border: 'border-ember-500/30',  dot: 'bg-ember-400' },
}

export const CATEGORY_STYLE: Record<string, { bg: string; text: string; border: string; icon: string }> = {
  crypto:    { bg: 'bg-violet-500/10',  text: 'text-violet-400',  border: 'border-violet-500/30',  icon: '🔑' },
  web:       { bg: 'bg-cyan-500/10',   text: 'text-cyan-400',    border: 'border-cyan-500/30',    icon: '🌐' },
  reverse:   { bg: 'bg-ember-500/10',  text: 'text-ember-400',   border: 'border-ember-500/30',   icon: '🔄' },
  pwn:       { bg: 'bg-crimson-500/10',text: 'text-crimson-400', border: 'border-crimson-500/30',  icon: '💥' },
  misc:      { bg: 'bg-jade-500/10',   text: 'text-jade-400',   border: 'border-jade-500/30',    icon: '🧩' },
  forensics: { bg: 'bg-cyan-500/10',   text: 'text-cyan-400',   border: 'border-cyan-500/30',    icon: '🔍' },
}

export function statusStyle(state: string) {
  return STATUS_COLORS[state] ?? STATUS_COLORS.INIT
}

export function categoryStyle(cat: string) {
  return CATEGORY_STYLE[cat] ?? { bg: 'bg-slate-500/10', text: 'text-slate-400', border: 'border-slate-500/20', icon: '⚡' }
}
