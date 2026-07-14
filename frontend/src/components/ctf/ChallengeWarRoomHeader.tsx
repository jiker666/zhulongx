import { Cpu, Plus, Radio, ShieldCheck, Target, Trophy } from 'lucide-react'
import { GlassPanel, GlowButton, StatePill } from '../ui'
import { type LlmStatus } from '../../api'

interface ChallengeWarRoomHeaderProps {
  llm: LlmStatus | null
  totalDemos: number
  totalTasks: number
  running: number
  solved: number
  onNew: () => void
}

export default function ChallengeWarRoomHeader({ llm, totalDemos, totalTasks, running, solved, onNew }: ChallengeWarRoomHeaderProps) {
  const llmTone = llm?.mode === 'live' ? 'jade' : llm?.mode === 'mock' ? 'ember' : 'slate'
  return (
    <GlassPanel tone="cyan" className="overflow-hidden p-0">
      <div className="relative grid gap-5 p-5 md:grid-cols-[1fr_auto] md:p-6">
        <div className="absolute inset-0 bg-command-grid bg-[length:34px_34px] opacity-40" aria-hidden="true" />
        <div className="relative">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <StatePill tone="ember" icon={<Trophy size={13} />}>CTF 作战大厅</StatePill>
            <StatePill tone={llmTone} icon={<Cpu size={13} />}>
              LLM {llm?.mode ?? 'unknown'}{llm?.model ? ` · ${llm.model}` : ''}
            </StatePill>
            <StatePill tone="jade" icon={<ShieldCheck size={13} />}>授权边界优先</StatePill>
          </div>
          <h1 className="text-3xl font-black text-white md:text-5xl">题目进入战情室</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-300">
            粘贴题面、上传附件、指定 flag 格式和授权范围，玄枢会把题目推进到分类、计划、工具执行、证据沉淀与人工复核。
          </p>
        </div>
        <div className="relative grid grid-cols-2 gap-3 sm:grid-cols-4 md:min-w-[420px]">
          {[
            { label: '题集', value: totalDemos, icon: Target },
            { label: '作战', value: totalTasks, icon: Trophy },
            { label: '运行', value: running, icon: Radio },
            { label: '解决', value: solved, icon: ShieldCheck },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="rounded-lg border border-white/10 bg-obsidian-950/55 p-3">
              <Icon size={16} className="text-cyan-300" />
              <div className="mt-3 text-2xl font-bold tabular-nums text-white">{value}</div>
              <div className="text-[11px] text-slate-500">{label}</div>
            </div>
          ))}
          <GlowButton className="col-span-2 sm:col-span-4" onClick={onNew}>
            <Plus size={15} /> 导入新题
          </GlowButton>
        </div>
      </div>
    </GlassPanel>
  )
}
