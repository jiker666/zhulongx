import { Paperclip, ShieldCheck, ShieldX, Upload } from 'lucide-react'
import { type ChangeEvent, type RefObject } from 'react'
import { type CtfTask } from '../../api'
import { formatTime } from '../../lib/format'
import { categoryTone } from '../../lib/status'
import { GlassPanel, GlowButton, StatePill } from '../ui'

interface TaskContextPanelProps {
  task: CtfTask
  canUpload: boolean
  uploading: boolean
  fileInputRef: RefObject<HTMLInputElement>
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void
}

export default function TaskContextPanel({ task, canUpload, uploading, fileInputRef, onUpload }: TaskContextPanelProps) {
  const category = task.plan?.category || task.category_hint || 'unknown'
  return (
    <div className="space-y-4">
      <GlassPanel tone={categoryTone(category)}>
        <div className="flex flex-wrap items-center gap-2">
          <StatePill tone={categoryTone(category)}>{category}</StatePill>
          <StatePill tone={task.authorized ? 'jade' : 'ember'} icon={task.authorized ? <ShieldCheck size={13} /> : <ShieldX size={13} />}>
            {task.authorized ? '已授权' : '未授权'}
          </StatePill>
          <StatePill tone={task.allow_network ? 'cyan' : 'slate'}>
            {task.allow_network ? '允许联网' : '默认禁网'}
          </StatePill>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg border border-slate-800 bg-obsidian-950/40 p-3">
            <div className="text-slate-500">置信度</div>
            <div className="mt-1 font-mono text-lg font-bold text-white">{Math.round((task.plan?.confidence || 0) * 100)}%</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-obsidian-950/40 p-3">
            <div className="text-slate-500">轮次</div>
            <div className="mt-1 font-mono text-lg font-bold text-white">{task.max_rounds > 0 ? `${task.rounds_used}/${task.max_rounds}` : `${task.rounds_used}`}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-obsidian-950/40 p-3">
            <div className="text-slate-500">附件</div>
            <div className="mt-1 font-mono text-lg font-bold text-white">{task.attachments.length}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-obsidian-950/40 p-3">
            <div className="text-slate-500">创建</div>
            <div className="mt-1 font-mono text-xs text-white">{formatTime(task.created_at)}</div>
          </div>
        </div>
      </GlassPanel>

      <GlassPanel tone="ember">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ember-300">Challenge Context</div>
        <h2 className="mt-1 text-base font-semibold text-white">题目上下文</h2>
        <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-slate-800 bg-obsidian-950/50 p-3 text-sm leading-6 text-slate-300">
          {task.description || '暂无题面描述'}
        </div>
        {task.flag_format && (
          <div className="mt-3 rounded-lg border border-jade-500/20 bg-jade-500/10 px-3 py-2 font-mono text-xs text-jade-300">
            {task.flag_format}
          </div>
        )}
      </GlassPanel>

      {task.plan && (
        <GlassPanel tone="violet">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-300">Initial Plan</div>
          <p className="mt-3 text-sm leading-6 text-slate-300">{task.plan.initial_guess || '等待计划生成'}</p>
          {task.plan.script_plan.length > 0 && (
            <ol className="mt-3 space-y-2 text-xs text-slate-300">
              {task.plan.script_plan.map((step, index) => (
                <li key={`${step}-${index}`} className="rounded-lg border border-violet-500/20 bg-violet-500/10 px-3 py-2">
                  <span className="mr-2 font-mono text-violet-300">{index + 1}</span>{step}
                </li>
              ))}
            </ol>
          )}
          {task.plan.risks.length > 0 && (
            <div className="mt-3 rounded-lg border border-ember-500/20 bg-ember-500/10 px-3 py-2 text-xs leading-5 text-ember-100">
              {task.plan.risks.join(' · ')}
            </div>
          )}
        </GlassPanel>
      )}

      <GlassPanel tone="cyan">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">Attachments</div>
            <h2 className="mt-1 text-base font-semibold text-white">附件与补充材料</h2>
          </div>
          {canUpload && (
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-ember-500/30 bg-ember-500/10 px-3 py-1.5 text-xs text-ember-200 hover:bg-ember-500/20">
              <Upload size={13} /> {uploading ? '上传中' : '上传'}
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onUpload} />
            </label>
          )}
        </div>
        {task.attachments.length > 0 ? (
          <ul className="space-y-2">
            {task.attachments.map((attachment, index) => (
              <li key={`${attachment}-${index}`} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-obsidian-950/40 px-3 py-2 text-xs text-slate-300">
                <Paperclip size={12} className="text-cyan-300" />
                <span className="truncate font-mono" title={attachment}>{attachment.split('/').pop()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-800 py-6 text-center text-xs text-slate-500">暂无附件</div>
        )}
      </GlassPanel>
    </div>
  )
}
