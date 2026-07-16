import { CheckCircle2, CircleDashed, Sparkles, XCircle } from 'lucide-react'
import { type RefObject } from 'react'
import { type CtfTask } from '../../api'
import { formatTime } from '../../lib/format'
import { toneForState } from '../../lib/status'
import { DataEmpty, GlassPanel, StatePill, Timeline, type TimelineItem } from '../ui'

export interface AgentLiveEvent {
  type: 'agent_live'
  task_id: string
  event_type: 'decision' | 'action' | 'result' | 'flag' | 'error' | 'info'
  phase: string
  title: string
  detail: string
  code: string
  output: string
  success: boolean | null
  extra: Record<string, any>
  ts: number
}

const EVENT_TONE: Record<string, 'ember' | 'cyan' | 'violet' | 'jade' | 'crimson' | 'slate'> = {
  decision: 'violet',
  action: 'cyan',
  result: 'jade',
  flag: 'ember',
  error: 'crimson',
  info: 'slate',
}

interface ReasoningTimelineProps {
  task: CtfTask
  liveEvents: AgentLiveEvent[]
  streamConnected: boolean
  liveLogRef: RefObject<HTMLDivElement>
}

export default function ReasoningTimeline({ task, liveEvents, streamConnected, liveLogRef }: ReasoningTimelineProps) {
  const evidenceItems: TimelineItem[] = task.evidence.map((event, index) => ({
    id: event.event_id || `${event.step}-${event.timestamp}-${index}`,
    title: event.step || `Step ${index + 1}`,
    eyebrow: formatTime(event.timestamp),
    meta: event.success ? <CheckCircle2 size={14} className="text-jade-300" /> : <XCircle size={14} className="text-crimson-300" />,
    tone: event.success ? 'jade' : 'crimson',
    body: (
      <div className="space-y-1">
        <div>{event.input_summary || '无输入摘要'}</div>
        {event.output_summary && <div className="text-slate-400">{event.output_summary}</div>}
      </div>
    ),
  }))

  return (
    <div className="space-y-4">
      <GlassPanel tone={task.is_running ? 'cyan' : 'slate'}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase text-cyan-300">Live Decisions</div>
            <h2 className="mt-1 text-lg font-semibold text-white">Agent 实时决策</h2>
          </div>
          <StatePill tone={streamConnected ? 'jade' : 'slate'} icon={streamConnected ? <Sparkles size={13} /> : <CircleDashed size={13} />}>
            {streamConnected ? '事件流已同步' : '等待同步'}
          </StatePill>
        </div>
        <div ref={liveLogRef} className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
          {liveEvents.length === 0 ? (
            <DataEmpty title={task.is_running ? 'Agent 正在启动' : '等待启动解题'} description="决策摘要、工具调用、输出与错误会实时进入这里。" />
          ) : (
            liveEvents.map((event, index) => {
              const tone = EVENT_TONE[event.event_type] || 'slate'
              return (
                <div key={`${event.ts}-${index}`} className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatePill tone={tone} className="min-h-6 px-2 py-0.5">{event.event_type}</StatePill>
                    <span className="text-[11px] text-slate-500">{formatTime(event.ts)}</span>
                    <span className="text-sm font-semibold text-white">{event.title}</span>
                    {event.success !== null && (event.success ? <CheckCircle2 size={13} className="text-jade-300" /> : <XCircle size={13} className="text-crimson-300" />)}
                  </div>
                  {event.detail && <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-300">{event.detail.slice(0, 900)}{event.detail.length > 900 ? '...' : ''}</p>}
                  {event.code && <pre className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-slate-800 bg-black/35 p-2 text-[11px] leading-5 text-cyan-100">{event.code.slice(0, 1000)}{event.code.length > 1000 ? '\n...' : ''}</pre>}
                  {event.output && <pre className="mt-2 max-h-36 overflow-y-auto rounded-lg border border-slate-800 bg-black/25 p-2 text-[11px] leading-5 text-slate-300">{event.output.slice(0, 900)}{event.output.length > 900 ? '\n...' : ''}</pre>}
                </div>
              )
            })
          )}
        </div>
      </GlassPanel>

      <GlassPanel tone={toneForState(task.state)}>
        <div className="mb-4">
          <div className="text-[11px] font-semibold uppercase text-ember-300">Evidence Timeline</div>
          <h2 className="mt-1 text-lg font-semibold text-white">阶段时间线</h2>
        </div>
        <Timeline
          items={evidenceItems}
          empty={<DataEmpty title="等待证据链" description="启动解题后，每一步输入、输出和执行结果会进入时间线。" />}
        />
      </GlassPanel>
    </div>
  )
}
