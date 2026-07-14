import { AlertTriangle, RotateCcw } from 'lucide-react'
import { type CtfTask } from '../../api'
import { GlassPanel, StatePill } from '../ui'

interface RetryReflectionCardProps {
  task: CtfTask
}

export default function RetryReflectionCard({ task }: RetryReflectionCardProps) {
  const failedRuns = task.script_runs.filter((run) => !run.success)
  if (!task.error && failedRuns.length === 0 && task.state !== 'HUMAN_REQUIRED') return null

  return (
    <GlassPanel tone="crimson">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-crimson-500/25 bg-crimson-500/10 text-crimson-300">
          <RotateCcw size={18} />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-white">失败反思与接管点</h2>
            <StatePill tone="crimson" icon={<AlertTriangle size={13} />}>{failedRuns.length} failed runs</StatePill>
          </div>
          <p className="mt-2 text-sm leading-6 text-crimson-100">{task.error || '最近脚本执行失败，建议查看 stderr、补充提示或人工接管验证。'}</p>
          {failedRuns[failedRuns.length - 1]?.stderr && (
            <pre className="mt-3 max-h-28 overflow-y-auto rounded-lg bg-black/25 p-3 text-xs leading-5 text-crimson-100">
              {failedRuns[failedRuns.length - 1].stderr.slice(0, 900)}
            </pre>
          )}
        </div>
      </div>
    </GlassPanel>
  )
}
