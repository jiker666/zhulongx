import { type ReactNode } from 'react'
import { type Challenge } from '../../api'
import { finalStatusLabel } from '../../lib/status'
import { GlassPanel } from '../ui'

const LANES = [
  { key: 'new', label: '待处理' },
  { key: 'running', label: '处理中' },
  { key: 'need_human', label: '待复核' },
  { key: 'submitted', label: '已提交' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'rejected', label: 'Rejected' },
]

function laneFor(challenge: Challenge) {
  if (challenge.submit_status === 'accepted') return 'accepted'
  if (challenge.submit_status === 'rejected') return 'rejected'
  if (['submitted', 'accepted', 'rejected'].includes(challenge.submit_status)) return 'submitted'
  if (['triaging', 'running'].includes(challenge.status)) return 'running'
  if (['need_human', 'candidate_found'].includes(challenge.status)) return 'need_human'
  if (challenge.status === 'solved') return 'accepted'
  return 'new'
}

interface FinalOpsBoardProps {
  challenges: Challenge[]
  renderCard: (challenge: Challenge) => ReactNode
}

export default function FinalOpsBoard({ challenges, renderCard }: FinalOpsBoardProps) {
  return (
    <div className="grid gap-4 xl:grid-cols-3 2xl:grid-cols-6">
      {LANES.map((lane) => {
        const items = challenges.filter((challenge) => laneFor(challenge) === lane.key)
        return (
          <GlassPanel key={lane.key} tone={lane.key === 'accepted' ? 'jade' : lane.key === 'rejected' ? 'crimson' : lane.key === 'running' ? 'cyan' : 'slate'} compact className="min-h-[260px]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-white">{lane.label}</h2>
              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">{items.length}</span>
            </div>
            <div className="space-y-3">
              {items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-800 px-3 py-6 text-center text-xs text-slate-600">
                  暂无{finalStatusLabel[lane.key] || lane.label}
                </div>
              ) : items.map(renderCard)}
            </div>
          </GlassPanel>
        )
      })}
    </div>
  )
}
