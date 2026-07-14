import { CheckCircle2, Search, Shield, XCircle } from 'lucide-react'
import { type HealthStatus, type ScopeCheckResult } from '../../api'
import { GlassPanel, GlowButton, StatePill } from '../ui'

interface ScopeGuardConsoleProps {
  health: HealthStatus | null
  url: string
  checking: boolean
  result: ScopeCheckResult | null
  error: string
  onUrlChange: (value: string) => void
  onCheck: () => void
}

export default function ScopeGuardConsole({ health, url, checking, result, error, onUrlChange, onCheck }: ScopeGuardConsoleProps) {
  const scope = health?.scope_config_summary
  return (
    <GlassPanel tone={result ? (result.allowed ? 'jade' : 'crimson') : 'cyan'}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300">ScopeGuard</div>
          <h2 className="mt-1 text-lg font-semibold text-white">授权范围检查器</h2>
          <p className="mt-1 text-xs leading-5 text-slate-400">默认拒绝非授权目标，所有联网动作都应先通过这里。</p>
        </div>
        <StatePill tone={scope?.configured ? 'jade' : 'ember'} icon={<Shield size={13} />}>
          {scope?.configured ? '已配置' : '待配置'}
        </StatePill>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3 text-xs">
          <div className="text-slate-500">Competition Mode</div>
          <div className={scope?.competition_mode ? 'mt-1 font-mono text-jade-300' : 'mt-1 font-mono text-slate-300'}>{scope?.competition_mode ? 'ON' : 'OFF'}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3 text-xs">
          <div className="text-slate-500">Request Budget</div>
          <div className="mt-1 font-mono text-slate-300">{scope ? `${scope.max_requests_per_task}/task · ${scope.max_requests_per_target}/target` : '-'}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3 text-xs">
          <div className="text-slate-500">CIDR</div>
          <div className="mt-1 break-words font-mono text-slate-300">{scope?.cidrs?.join(', ') || '(empty)'}</div>
        </div>
        <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3 text-xs">
          <div className="text-slate-500">Domains</div>
          <div className="mt-1 break-words font-mono text-slate-300">{scope?.domains?.join(', ') || '(empty)'}</div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
        <input
          className="input"
          placeholder="http://target.example:8080/path"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') onCheck() }}
        />
        <GlowButton variant="secondary" onClick={onCheck} loading={checking} disabled={!url.trim()}>
          <Search size={13} /> 检查
        </GlowButton>
      </div>

      {error && <div className="mt-3 rounded-lg border border-crimson-500/25 bg-crimson-500/10 px-3 py-2 text-xs text-crimson-300">{error}</div>}
      {result && (
        <div className={`mt-3 rounded-lg border px-3 py-3 text-xs ${result.allowed ? 'border-jade-500/25 bg-jade-500/10 text-jade-200' : 'border-crimson-500/25 bg-crimson-500/10 text-crimson-200'}`}>
          <div className="mb-2 flex items-center gap-2 font-semibold">
            {result.allowed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {result.allowed ? '允许' : '拦截'} · {result.reason}
          </div>
          <div className="grid gap-2 text-slate-300 sm:grid-cols-2">
            <div>Host: <span className="font-mono text-white">{result.host || '-'}</span></div>
            <div>Port: <span className="font-mono text-white">{result.port || '-'}</span></div>
            <div>Rule: <span className="font-mono text-white">{result.matched_rule || '-'}</span></div>
            <div>Mode: <span className="font-mono text-white">{result.competition_mode ? 'competition' : 'safe'}</span></div>
            <div className="sm:col-span-2">Resolved: <span className="font-mono text-white">{result.resolved_ip_summary.join(', ') || '-'}</span></div>
          </div>
        </div>
      )}
    </GlassPanel>
  )
}
