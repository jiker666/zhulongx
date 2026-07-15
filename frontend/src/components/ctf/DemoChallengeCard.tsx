import { ArrowRight, Clock, Loader2, Play, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { type CtfDemo } from '../../api'
import { formatDuration } from '../../lib/format'
import { categoryTone, toneClass } from '../../lib/status'
import { GlassPanel, GlowButton, StatePill } from '../ui'

export interface DemoRunResult {
  demoId: string
  taskId: string
  match?: boolean | null
  flag?: string | null
  state?: string
  error?: string
}

interface DemoChallengeCardProps {
  demo: CtfDemo
  running: string | null
  result?: DemoRunResult
  onRun: (id: string) => void
}

export default function DemoChallengeCard({ demo, running, result, onRun }: DemoChallengeCardProps) {
  const tone = toneClass[categoryTone(demo.category)]
  const isRunning = running === demo.id
  const isSolved = result?.state === 'DONE'
  const isFailed = result?.state === 'FAILED' || result?.state === 'HUMAN_REQUIRED'

  return (
    <GlassPanel tone={categoryTone(demo.category)} className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3">
        <StatePill tone={categoryTone(demo.category)} className="min-h-6 px-2 py-0.5">
          {demo.category}
        </StatePill>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
          <Clock size={12} /> {formatDuration(demo.est_time_sec ?? 0, 's')}
        </div>
      </div>
      <h3 className="mt-4 text-base font-semibold leading-6 text-white">{demo.title}</h3>
      <p className="mt-2 line-clamp-3 flex-1 text-xs leading-5 text-slate-400">{demo.description}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-400">{demo.difficulty || 'unknown'}</span>
        {demo.has_attachment && <span className="rounded-md border border-cyan-500/25 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-300">附件</span>}
        {demo.needs_llm && <span className="rounded-md border border-violet-500/25 bg-violet-500/10 px-2 py-1 text-[11px] text-violet-300">LLM</span>}
      </div>
      {result && (
        <div className={`mt-4 rounded-lg border px-3 py-2 text-xs ${isSolved ? 'border-jade-500/30 bg-jade-500/10 text-jade-300' : isFailed ? 'border-crimson-500/30 bg-crimson-500/10 text-crimson-300' : `${tone.border} ${tone.bg} ${tone.text}`}`}>
          {isSolved ? <span className="font-mono">{result.flag || 'DONE'}</span> : isFailed ? (result.error || result.state) : `${result.state || 'RUNNING'}...`}
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <GlowButton className="flex-1" size="sm" onClick={() => onRun(demo.id)} loading={isRunning}>
          {isRunning ? <Loader2 size={13} /> : <Play size={13} />} 运行
        </GlowButton>
        {result?.taskId && (
          <Link to={`/ctf/${result.taskId}`}>
            <GlowButton size="sm" variant="secondary">
              <ArrowRight size={13} />
            </GlowButton>
          </Link>
        )}
      </div>
      {demo.flag_format && (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
          <ShieldCheck size={12} /> {demo.flag_format}
        </div>
      )}
    </GlassPanel>
  )
}
