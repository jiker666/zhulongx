import { Activity, Cpu, ShieldCheck, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ZhulongLogo } from '../brand'
import { AgentOrbit } from '../visual'
import { GlassPanel, GlowButton, StatePill } from '../ui'
import { designCopy } from '../../styles/design-system'
import { toneForState } from '../../lib/status'

interface CommandHeroProps {
  backendStatus?: string
  llmMode?: string
  llmModel?: string
  runningCount: number
  scopeConfigured?: boolean
}

export default function CommandHero({ backendStatus, llmMode, llmModel, runningCount, scopeConfigured }: CommandHeroProps) {
  const llmTone = llmMode === 'live' ? 'jade' : llmMode === 'mock' ? 'ember' : 'slate'
  return (
    <GlassPanel tone="ember" className="relative min-h-[360px] p-0">
      <div className="absolute inset-0 bg-obsidian-noise opacity-80" aria-hidden="true" />
      <div className="absolute inset-x-8 top-16 hidden h-px bg-gradient-to-r from-transparent via-ember-300/40 to-transparent md:block" aria-hidden="true" />
      <div className="relative grid gap-6 p-5 md:grid-cols-[1.15fr_.85fr] md:p-8">
        <div className="flex flex-col justify-between gap-8">
          <div>
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <StatePill tone={toneForState(backendStatus)} icon={<Activity size={13} />}>
                后端 {backendStatus || '未知'}
              </StatePill>
              <StatePill tone={llmTone} icon={<Cpu size={13} />}>
                LLM {llmMode || 'unknown'}{llmModel ? ` · ${llmModel}` : ''}
              </StatePill>
              <StatePill tone={scopeConfigured ? 'jade' : 'ember'} icon={<ShieldCheck size={13} />}>
                ScopeGuard {scopeConfigured ? '已配置' : '待确认'}
              </StatePill>
            </div>
            <div className="flex items-center gap-4">
              <ZhulongLogo size={68} glowing />
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-ember-300">ZHULONG-X</p>
                <h1 className="mt-2 text-4xl font-black text-white md:text-6xl">
                  烛龙·玄枢
                </h1>
              </div>
            </div>
            <p className="mt-5 text-lg font-medium text-ember-100">烛照隐微，枢决攻防</p>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-300 md:text-base">
              面向授权 CTF / 靶场 / 教学的自主决策安全智能体作战中枢。
              {designCopy.promise}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link to="/ctf">
              <GlowButton size="lg" glowing>
                <Sparkles size={17} /> 进入 CTF 作战大厅
              </GlowButton>
            </Link>
            <Link to="/settings">
              <GlowButton size="lg" variant="secondary">
                <ShieldCheck size={17} /> 检查安全边界
              </GlowButton>
            </Link>
          </div>
        </div>
        <div className="relative flex min-h-[260px] items-center justify-center">
          <div className="absolute inset-0 rounded-full bg-cyan-500/5 blur-3xl" aria-hidden="true" />
          <AgentOrbit size={260} activeTool={runningCount > 0 ? 'run_shell' : undefined} className="relative z-10" />
          <div className="absolute bottom-2 left-1/2 w-full max-w-xs -translate-x-1/2 rounded-lg border border-cyan-500/20 bg-obsidian-950/70 px-4 py-3 text-center backdrop-blur">
            <div className="text-[11px] uppercase tracking-[0.22em] text-cyan-300">Agent Orbit</div>
            <div className="mt-1 text-sm text-white">{runningCount > 0 ? `${runningCount} 个任务正在推进` : '等待下一道题面进入轨道'}</div>
          </div>
        </div>
      </div>
    </GlassPanel>
  )
}
