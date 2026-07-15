import { ArrowRight, FileText, Flag, Radio, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { type CtfTask } from '../../api'
import { categoryTone, ctfStateLabel, toneForState } from '../../lib/status'
import { formatTime } from '../../lib/format'
import { GlassPanel, StatePill, StatusBadge } from '../ui'

interface CtfTaskCardProps {
  task: CtfTask
}

export default function CtfTaskCard({ task }: CtfTaskCardProps) {
  const lastEvidence = task.evidence[task.evidence.length - 1]
  const tone = toneForState(task.is_running ? 'RUNNING' : task.state)
  const category = task.plan?.category || task.category_hint || 'unknown'
  return (
    <Link to={`/ctf/${task.task_id}`} className="block h-full">
      <GlassPanel tone={tone} className="flex h-full flex-col transition hover:-translate-y-0.5 hover:border-ember-500/40">
        <div className="flex items-start justify-between gap-3">
          <StatePill tone={categoryTone(category)} className="min-h-6 px-2 py-0.5">{category}</StatePill>
          <StatusBadge state={task.is_running ? 'RUNNING' : task.state} label={ctfStateLabel[task.state] || task.state} pulse={task.is_running} />
        </div>
        <h3 className="mt-4 text-base font-semibold leading-6 text-white">{task.title}</h3>
        <p className="mt-2 line-clamp-3 flex-1 text-xs leading-5 text-slate-400">{task.plan?.initial_guess || task.description || '暂无题面摘要'}</p>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-slate-800 bg-obsidian-950/40 px-2 py-2">
            <Radio size={13} className="mx-auto text-cyan-300" />
            <div className="mt-1 text-sm font-bold tabular-nums text-white">{task.rounds_used}</div>
            <div className="text-[10px] text-slate-500">轮次</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-obsidian-950/40 px-2 py-2">
            <FileText size={13} className="mx-auto text-violet-300" />
            <div className="mt-1 text-sm font-bold tabular-nums text-white">{task.evidence.length}</div>
            <div className="text-[10px] text-slate-500">证据</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-obsidian-950/40 px-2 py-2">
            <Flag size={13} className="mx-auto text-jade-300" />
            <div className="mt-1 text-sm font-bold tabular-nums text-white">{task.candidate_flags.length + (task.best_flag ? 1 : 0)}</div>
            <div className="text-[10px] text-slate-500">候选</div>
          </div>
        </div>
        {task.best_flag && (
          <div className="mt-4 rounded-lg border border-jade-500/25 bg-jade-500/10 px-3 py-2 font-mono text-xs text-jade-300">
            {task.best_flag}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between gap-3 text-[11px] text-slate-500">
          <span className="line-clamp-1">{lastEvidence?.step || (task.authorized ? '授权题目' : '等待授权确认')}</span>
          <span>{formatTime(task.updated_at)}</span>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-slate-800/80 pt-3 text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck size={12} className={task.authorized ? 'text-jade-300' : 'text-ember-300'} />
            {task.authorized ? '授权' : '未授权禁网'}
          </span>
          <ArrowRight size={14} className="text-ember-300" />
        </div>
      </GlassPanel>
    </Link>
  )
}
