import { Download, Flag, ShieldCheck } from 'lucide-react'
import { type CtfTask } from '../../api'
import { GlassPanel, GlowButton, StatePill, CopyButton, DataEmpty } from '../ui'

interface FlagCandidateStackProps {
  task: CtfTask
  onWriteup: () => void
}

export default function FlagCandidateStack({ task, onWriteup }: FlagCandidateStackProps) {
  const candidates = task.best_flag
    ? [{ flag: task.best_flag, source: 'best', confidence: 1 }, ...task.candidate_flags.filter((item) => item.flag !== task.best_flag)]
    : task.candidate_flags

  return (
    <GlassPanel tone={task.best_flag ? 'jade' : 'ember'}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-jade-300">Flag Stack</div>
          <h2 className="mt-1 text-lg font-semibold text-white">候选 Flag 战果栈</h2>
        </div>
        <StatePill tone={task.best_flag ? 'jade' : 'slate'} icon={<Flag size={13} />}>
          {candidates.length} candidates
        </StatePill>
      </div>

      {candidates.length === 0 ? (
        <DataEmpty title="暂无候选 flag" description="玄枢会把待确认战果和证据来源放在这里，而不是只给一行文本。" />
      ) : (
        <div className="space-y-3">
          {candidates.slice(0, 6).map((candidate, index) => (
            <div key={`${candidate.flag}-${index}`} className={`rounded-lg border px-3 py-3 ${index === 0 && task.best_flag ? 'border-jade-500/35 bg-jade-500/10' : 'border-slate-800 bg-obsidian-950/45'}`}>
              <div className="flex items-center justify-between gap-2">
                <StatePill tone={index === 0 && task.best_flag ? 'jade' : 'ember'} className="min-h-6 px-2 py-0.5">
                  {index === 0 && task.best_flag ? '最佳候选' : candidate.source || 'candidate'}
                </StatePill>
                <span className="font-mono text-xs text-slate-400">{Math.round((candidate.confidence || 0) * 100)}%</span>
              </div>
              <div className="mt-2 break-all font-mono text-sm text-jade-100">{candidate.flag}</div>
              <CopyButton text={candidate.flag} className="mt-2" />
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-800/80 pt-4">
        <StatePill tone={task.authorized ? 'jade' : 'ember'} icon={<ShieldCheck size={13} />}>
          {task.authorized ? '授权可复核' : '需确认授权'}
        </StatePill>
        <GlowButton variant="secondary" size="sm" onClick={onWriteup} disabled={!task.has_writeup}>
          <Download size={13} /> 导出 WP
        </GlowButton>
      </div>
    </GlassPanel>
  )
}
