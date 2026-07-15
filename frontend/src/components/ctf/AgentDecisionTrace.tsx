import { Brain, DollarSign, Eye, Plus } from 'lucide-react'
import { type BlackboardSnapshot, type TaskCostSummary } from '../../api'
import { formatTime } from '../../lib/format'
import { DataEmpty, GlassPanel, GlowButton, StatePill } from '../ui'

interface AgentDecisionTraceProps {
  blackboard: BlackboardSnapshot | null
  costSummary: TaskCostSummary | null
  hintInput: string
  hintSubmitting: boolean
  error: string | null
  onHintChange: (value: string) => void
  onAddHint: () => void
}

function KindTag({ kind }: { kind: string }) {
  const tone = kind === 'candidate' ? 'jade' : kind === 'error' ? 'crimson' : kind === 'tool_result' ? 'violet' : kind === 'constraint' ? 'ember' : 'cyan'
  return <StatePill tone={tone} className="min-h-6 px-2 py-0.5">{kind}</StatePill>
}

export default function AgentDecisionTrace({
  blackboard,
  costSummary,
  hintInput,
  hintSubmitting,
  error,
  onHintChange,
  onAddHint,
}: AgentDecisionTraceProps) {
  const observerHints = blackboard?.hints.filter((hint) => hint.source === 'observer') ?? []
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <GlassPanel tone="violet">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-300">Decision Trace</div>
            <h2 className="mt-1 text-lg font-semibold text-white">事实黑板与意图队列</h2>
          </div>
          <StatePill tone="violet" icon={<Brain size={13} />}>{blackboard?.fact_count ?? 0} facts</StatePill>
        </div>
        {!blackboard ? (
          <DataEmpty title="黑板数据不可用" description="后端未启用黑板接口时，页面会继续展示基础证据链。" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              {blackboard.facts.slice(0, 12).map((fact) => (
                <div key={fact.fact_id} className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <KindTag kind={fact.kind} />
                    <span className="text-[11px] text-slate-500">{fact.source_step}</span>
                  </div>
                  <p className="break-words text-xs leading-5 text-slate-300">{fact.content}</p>
                </div>
              ))}
              {blackboard.facts.length === 0 && <DataEmpty title="暂无事实" />}
            </div>
            <div className="space-y-2">
              {blackboard.intents.slice(0, 10).map((intent) => (
                <div key={intent.intent_id} className="rounded-lg border border-violet-500/20 bg-violet-500/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-white">{intent.title}</span>
                    <StatePill tone={intent.status === 'completed' ? 'jade' : intent.status === 'failed' ? 'crimson' : 'violet'} className="min-h-6 px-2 py-0.5">
                      {intent.status}
                    </StatePill>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-400">{intent.rationale}</p>
                </div>
              ))}
              <div className="rounded-lg border border-ember-500/20 bg-ember-500/10 p-3">
                <div className="mb-2 text-xs font-semibold text-ember-200">人工提示</div>
                <div className="flex gap-2">
                  <input
                    className="input min-w-0 flex-1"
                    value={hintInput}
                    onChange={(event) => onHintChange(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') onAddHint() }}
                    placeholder="补充线索、限制或人工判断"
                  />
                  <GlowButton size="sm" onClick={onAddHint} loading={hintSubmitting} disabled={!hintInput.trim()}>
                    <Plus size={13} />
                  </GlowButton>
                </div>
                {error && <div className="mt-2 text-xs text-crimson-300">{error}</div>}
              </div>
            </div>
          </div>
        )}
      </GlassPanel>

      <div className="space-y-4">
        <GlassPanel tone={costSummary?.budget_exceeded ? 'crimson' : 'ember'}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ember-300">Cost Route</div>
              <h2 className="mt-1 text-lg font-semibold text-white">模型成本与路由</h2>
            </div>
            <DollarSign size={18} className="text-ember-300" />
          </div>
          {!costSummary ? (
            <DataEmpty title="暂无成本数据" />
          ) : (
            <div className="space-y-3 text-xs">
              <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3">
                <div className="text-slate-500">本题成本</div>
                <div className={costSummary.budget_exceeded ? 'mt-1 font-mono text-2xl font-bold text-crimson-200' : 'mt-1 font-mono text-2xl font-bold text-jade-200'}>
                  ${costSummary.total_cost_usd.toFixed(6)}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-cyan-500/10 p-2 text-cyan-200">cheap<br/><span className="font-mono text-lg">{costSummary.cheap_calls}</span></div>
                <div className="rounded-lg bg-violet-500/10 p-2 text-violet-200">expert<br/><span className="font-mono text-lg">{costSummary.expert_calls}</span></div>
                <div className="rounded-lg bg-slate-500/10 p-2 text-slate-300">fallback<br/><span className="font-mono text-lg">{costSummary.fallback_calls}</span></div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-slate-400">
                <span>输入 tokens <b className="font-mono text-white">{costSummary.total_input_tokens}</b></span>
                <span>输出 tokens <b className="font-mono text-white">{costSummary.total_output_tokens}</b></span>
                <span>成功 <b className="font-mono text-jade-200">{costSummary.successful_calls}</b></span>
                <span>失败 <b className="font-mono text-crimson-200">{costSummary.failed_calls}</b></span>
              </div>
            </div>
          )}
        </GlassPanel>

        <GlassPanel tone="violet">
          <div className="mb-3 flex items-center gap-2">
            <Eye size={15} className="text-violet-300" />
            <h2 className="text-sm font-semibold text-white">Observer 旁路监督</h2>
          </div>
          {observerHints.length === 0 ? (
            <p className="text-xs leading-5 text-slate-500">暂无旁路建议。Observer 只监督跑偏、循环和预算浪费，不直接执行工具。</p>
          ) : (
            <div className="space-y-2">
              {observerHints.slice(0, 6).map((hint) => (
                <div key={hint.hint_id} className="rounded-lg border border-violet-500/20 bg-violet-500/10 px-3 py-2 text-xs leading-5 text-violet-100">
                  <div className="mb-1 text-[10px] text-violet-300">{formatTime(hint.created_at)}</div>
                  {hint.content}
                </div>
              ))}
            </div>
          )}
        </GlassPanel>
      </div>
    </div>
  )
}
