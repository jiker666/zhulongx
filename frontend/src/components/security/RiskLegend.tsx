import { AlertTriangle, ShieldCheck } from 'lucide-react'
import { GlassPanel, StatePill } from '../ui'

export default function RiskLegend() {
  return (
    <GlassPanel tone="crimson">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle size={16} className="text-ember-300" />
        <h2 className="text-sm font-semibold text-white">风险图例</h2>
      </div>
      <div className="space-y-2 text-xs leading-5 text-slate-400">
        <div><StatePill tone="jade" icon={<ShieldCheck size={13} />}>low</StatePill><span className="ml-2">只读、离线、可重复执行</span></div>
        <div><StatePill tone="ember">medium</StatePill><span className="ml-2">需要注意目标、超时或输出范围</span></div>
        <div><StatePill tone="crimson">high</StatePill><span className="ml-2">可能联网、写文件或影响靶场状态，需边界确认</span></div>
      </div>
    </GlassPanel>
  )
}
