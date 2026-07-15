import { BrainCircuit, FileCheck2, RotateCcw, ShieldCheck } from 'lucide-react'
import { designCopy } from '../../styles/design-system'

const items = [
  { icon: BrainCircuit, title: '自主决策', text: 'Agent 将题面理解、分类与计划串联，不只是按钮式工具调用。' },
  { icon: RotateCcw, title: '失败反思', text: 'stderr、重试和 fallback 计划保留在链路中，失败也能解释。' },
  { icon: FileCheck2, title: '证据链', text: '每次工具输入输出、候选 flag 与 WP 来源都能回看。' },
  { icon: ShieldCheck, title: 'ScopeGuard', text: designCopy.safety },
]

export default function JudgePitchStrip() {
  return (
    <div className="grid gap-3 md:grid-cols-4">
      {items.map(({ icon: Icon, title, text }) => (
        <div key={title} className="rounded-lg border border-ember-500/20 bg-ember-500/[0.06] p-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-ember-500/10 text-ember-300">
            <Icon size={17} />
          </div>
          <div className="mt-3 text-sm font-semibold text-white">{title}</div>
          <p className="mt-2 text-xs leading-5 text-slate-400">{text}</p>
        </div>
      ))}
    </div>
  )
}
