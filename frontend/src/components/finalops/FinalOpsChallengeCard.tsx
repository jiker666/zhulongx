import { Check, Copy, FileText, Loader2, Play, UserRound } from 'lucide-react'
import { Link } from 'react-router-dom'
import { type Challenge } from '../../api'
import { finalStatusLabel, toneForState } from '../../lib/status'
import { formatTime } from '../../lib/format'
import { GlassPanel, GlowButton, StatePill, StatusBadge } from '../ui'

interface FinalOpsChallengeCardProps {
  challenge: Challenge
  candidate?: string
  candidateConfidence?: number
  running: boolean
  manual: string
  onManualChange: (value: string) => void
  onRunTriage: () => void
  onMark: (status: string) => void
  onSubmit: (status: 'submitted' | 'accepted' | 'rejected') => void
  onAddManual: () => void
  onAddNote: () => void
  onAddCandidate: () => void
  onCopyBrief: () => void
  onCopyCandidate: () => void
  onCopyEvidence: () => void
}

export default function FinalOpsChallengeCard({
  challenge,
  candidate,
  candidateConfidence,
  running,
  manual,
  onManualChange,
  onRunTriage,
  onMark,
  onSubmit,
  onAddManual,
  onAddNote,
  onAddCandidate,
  onCopyBrief,
  onCopyCandidate,
  onCopyEvidence,
}: FinalOpsChallengeCardProps) {
  const triageLocked = running || ['triaging', 'running'].includes(challenge.status)
  return (
    <GlassPanel tone={toneForState(challenge.submit_status || challenge.status)} compact className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <StatePill tone="cyan" className="min-h-6 px-2 py-0.5">{challenge.challenge_type}</StatePill>
            <StatusBadge state={challenge.status} label={finalStatusLabel[challenge.status] || challenge.status} pulse={triageLocked} />
            {challenge.priority === 'high' && <StatePill tone="crimson" className="min-h-6 px-2 py-0.5">P0</StatePill>}
          </div>
          <h3 className="truncate text-sm font-semibold text-white">{challenge.name}</h3>
          <p className="mt-1 truncate text-[11px] text-slate-500">{challenge.target || challenge.uploaded_file || '题面/附件'}</p>
        </div>
        <div className="shrink-0 text-right text-[11px] text-slate-500">
          <div className="flex items-center justify-end gap-1 text-slate-300"><UserRound size={12} /> {challenge.assignee || '未分配'}</div>
          <div className="mt-1">{formatTime(challenge.updated_at)}</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-2"><div className="font-mono text-white">{challenge.task_ids.length}</div><div className="text-[10px] text-slate-500">Tasks</div></div>
        <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-2"><div className="font-mono text-white">{challenge.evidence.length}</div><div className="text-[10px] text-slate-500">Evidence</div></div>
        <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-2"><div className="font-mono text-white">{challenge.answer_candidates.length}</div><div className="text-[10px] text-slate-500">Flags</div></div>
      </div>

      {candidate ? (
        <div className="rounded-lg border border-jade-500/25 bg-jade-500/10 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-jade-300">最佳候选 · {Math.round((candidateConfidence || 0) * 100)}%</span>
            <button type="button" onClick={onCopyCandidate} className="text-slate-500 hover:text-jade-200" aria-label="复制候选答案"><Copy size={13} /></button>
          </div>
          <div className="mt-1 break-all font-mono text-xs text-jade-100">{candidate}</div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-800 px-3 py-3 text-xs text-slate-600">暂无答案候选</div>
      )}

      <p className="line-clamp-2 text-xs leading-5 text-slate-400">{challenge.latest_summary || challenge.description || '等待分诊'}</p>
      <p className="line-clamp-2 text-[11px] leading-5 text-slate-500">{challenge.next_suggestion || '等待下一步建议'}</p>

      <div className="flex flex-wrap gap-2">
        <GlowButton size="sm" onClick={onRunTriage} disabled={triageLocked}>{running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Triage</GlowButton>
        <GlowButton variant="secondary" size="sm" onClick={onAddNote}>Note</GlowButton>
        <GlowButton variant="secondary" size="sm" onClick={onAddCandidate}>Candidate</GlowButton>
        <GlowButton variant="secondary" size="sm" onClick={() => onSubmit('submitted')}>Submit</GlowButton>
        <GlowButton variant="secondary" size="sm" onClick={() => onSubmit('accepted')} className="text-jade-300">Accepted</GlowButton>
        <GlowButton variant="secondary" size="sm" onClick={() => onSubmit('rejected')} className="text-crimson-300">Rejected</GlowButton>
        <GlowButton variant="secondary" size="sm" onClick={() => onMark('need_human')}>Review</GlowButton>
        <GlowButton variant="secondary" size="sm" onClick={() => onMark('blocked')}>Blocked</GlowButton>
        <GlowButton variant="secondary" size="sm" onClick={onCopyBrief}><FileText size={13} /> Brief</GlowButton>
        {challenge.task_ids[0] && <Link to={`/tasks/${challenge.task_ids[0]}/report`}><GlowButton variant="secondary" size="sm">Report</GlowButton></Link>}
      </div>

      <div className="flex flex-wrap gap-3 text-xs">
        <button type="button" onClick={onCopyEvidence} className="text-slate-500 hover:text-ember-300">复制证据</button>
        <button type="button" onClick={() => onMark('paused')} className="text-slate-500 hover:text-ember-300">暂停</button>
        <button type="button" onClick={() => onMark('solved')} className="text-slate-500 hover:text-jade-300">Solved</button>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2 border-t border-slate-800 pt-3">
        <input className="input" placeholder="人工回填：页面返回、截图说明" value={manual} onChange={(event) => onManualChange(event.target.value)} />
        <GlowButton variant="secondary" size="sm" onClick={onAddManual} title="回填人工结果"><Check size={15} /></GlowButton>
      </div>
    </GlassPanel>
  )
}
