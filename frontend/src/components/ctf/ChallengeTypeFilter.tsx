import { Check, Filter, Flag } from 'lucide-react'
import { cn } from '../../lib/cn'
import { categoryTone, toneClass } from '../../lib/status'

const TYPES = ['all', 'web', 'crypto', 'reverse', 'pwn', 'misc', 'forensics']
const STATUSES = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待分析' },
  { key: 'running', label: '运行中' },
  { key: 'candidate', label: '有候选' },
  { key: 'solved', label: '已解决' },
  { key: 'failed', label: '失败' },
]

interface ChallengeTypeFilterProps {
  type: string
  status: string
  candidateOnly: boolean
  onType: (value: string) => void
  onStatus: (value: string) => void
  onCandidateOnly: (value: boolean) => void
}

export default function ChallengeTypeFilter({ type, status, candidateOnly, onType, onStatus, onCandidateOnly }: ChallengeTypeFilterProps) {
  return (
    <div className="space-y-3 rounded-lg border border-slate-800/80 bg-obsidian-900/60 p-3">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
        <Filter size={13} /> 筛选器
      </div>
      <div className="flex flex-wrap gap-2">
        {TYPES.map((item) => {
          const selected = type === item
          const tone = toneClass[item === 'all' ? 'slate' : categoryTone(item)]
          return (
            <button
              key={item}
              type="button"
              aria-pressed={selected}
              onClick={() => onType(item)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs transition',
                selected ? `${tone.bg} ${tone.text} ${tone.border}` : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white',
              )}
            >
              {item === 'all' ? '全部题型' : item}
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {STATUSES.map((item) => {
          const selected = status === item.key
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={selected}
              onClick={() => onStatus(item.key)}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs transition',
                selected ? 'border-ember-500/40 bg-ember-500/10 text-ember-300' : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white',
              )}
            >
              {item.label}
            </button>
          )
        })}
        <button
          type="button"
          aria-pressed={candidateOnly}
          onClick={() => onCandidateOnly(!candidateOnly)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition',
            candidateOnly ? 'border-jade-500/40 bg-jade-500/10 text-jade-300' : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-white',
          )}
        >
          {candidateOnly ? <Check size={12} /> : <Flag size={12} />} 仅看候选
        </button>
      </div>
    </div>
  )
}
