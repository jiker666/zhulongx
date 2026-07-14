import { Brain, CheckCircle2, GitBranch, Zap, XCircle } from 'lucide-react'
import { type LLMStatus, type LLMTestResult, type RouterStatus } from '../../api'
import { GlassPanel, GlowButton, StatePill } from '../ui'

interface ModelRouterStatusProps {
  llmStatus: LLMStatus | null
  routerStatus: RouterStatus | null
  testResult: LLMTestResult | null
  testing: boolean
  onTest: () => void
}

export default function ModelRouterStatus({ llmStatus, routerStatus, testResult, testing, onTest }: ModelRouterStatusProps) {
  const enabled = Boolean(llmStatus?.enabled)
  return (
    <GlassPanel tone={enabled ? 'violet' : 'cyan'}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-300">Model Router</div>
          <h2 className="mt-1 text-lg font-semibold text-white">LLM 状态与路由</h2>
        </div>
        <StatePill tone={enabled ? 'violet' : 'cyan'} icon={enabled ? <Brain size={13} /> : <Zap size={13} />}>
          {enabled ? 'LLM 模式' : '规则兜底'}
        </StatePill>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {[
          ['Current', llmStatus?.model || '-', llmStatus?.base_url_host || '-'],
          ['Cheap', routerStatus?.cheap?.model || '-', routerStatus?.cheap?.base_url_host || '-'],
          ['Expert', routerStatus?.expert?.model || '-', routerStatus?.expert?.base_url_host || '-'],
        ].map(([label, model, host]) => (
          <div key={label} className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500"><GitBranch size={12} /> {label}</div>
            <div className="mt-2 truncate font-mono text-sm text-white">{model}</div>
            <div className="mt-1 truncate text-[11px] text-slate-500">{host}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-4">
        <div className="text-xs leading-5 text-slate-400">
          Router {routerStatus?.router_enabled ? 'enabled' : 'disabled'} · daily ${routerStatus?.daily_total_cost_usd?.toFixed?.(4) ?? '0.0000'} · budget/task ${routerStatus?.budget_per_task_usd ?? '-'}
        </div>
        <GlowButton variant="secondary" size="sm" onClick={onTest} loading={testing}><Zap size={13} /> 测试连接</GlowButton>
      </div>

      {testResult && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${testResult.success ? 'border-jade-500/25 bg-jade-500/10 text-jade-300' : 'border-crimson-500/25 bg-crimson-500/10 text-crimson-300'}`}>
          <div className="flex items-center gap-2 font-medium">
            {testResult.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {testResult.success ? '连接成功' : '连接失败'}
          </div>
          <div className="mt-1 text-slate-300">{testResult.message}</div>
        </div>
      )}
    </GlassPanel>
  )
}
