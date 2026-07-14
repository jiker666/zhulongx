import { Link } from 'react-router-dom'
import { CheckCircle2, XCircle } from 'lucide-react'
import { type CtfTask } from '../../api'
import { formatTime } from '../../lib/format'
import { toneClass } from '../../lib/status'
import DataEmpty from '../ui/DataEmpty'

interface EvidenceConstellationProps {
  tasks: CtfTask[]
}

export default function EvidenceConstellation({ tasks }: EvidenceConstellationProps) {
  const events = tasks
    .flatMap((task) => task.evidence.map((event) => ({ ...event, taskId: task.task_id, taskTitle: task.title })))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 9)

  if (events.length === 0) {
    return <DataEmpty title="证据链等待点亮" description="Agent 的每一步输入、输出、工具结果与失败原因都会沉淀为可复核证据。" />
  }

  return (
    <div className="relative grid gap-3 md:grid-cols-3">
      <svg className="pointer-events-none absolute inset-0 hidden h-full w-full md:block" aria-hidden="true">
        <path d="M40 46 C 210 20, 280 180, 440 72 S 720 120, 820 38" fill="none" stroke="rgba(34,211,238,.22)" strokeWidth="1" strokeDasharray="7 7" className="motion-safe:animate-evidence-flow" />
      </svg>
      {events.map((event, index) => {
        const tone = event.success ? toneClass.jade : toneClass.crimson
        const Icon = event.success ? CheckCircle2 : XCircle
        return (
          <Link
            to={`/ctf/${event.taskId}`}
            key={`${event.taskId}-${event.timestamp}-${index}`}
            className={`relative rounded-lg border bg-obsidian-900/75 p-3 transition hover:-translate-y-0.5 hover:bg-obsidian-800/80 ${tone.border}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className={`flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] ${tone.text}`}>
                <Icon size={13} /> {event.step || 'evidence'}
              </div>
              <div className="text-[11px] text-slate-500">{formatTime(event.timestamp)}</div>
            </div>
            <div className="mt-2 line-clamp-1 text-xs font-medium text-white">{event.taskTitle}</div>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-400">{event.output_summary || event.input_summary || '无摘要'}</p>
          </Link>
        )
      })}
    </div>
  )
}
