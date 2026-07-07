import { useEffect, useState } from 'react'
import { Shield, ExternalLink, Loader2, CheckCircle2, XCircle, Zap, Brain, AlertTriangle, Search } from 'lucide-react'
import {
  getHealth, getLLMStatus, scopeCheck, testLLM, ctfGetRouterStatus,
  getLlmSettings, updateLlmSettings, getSettingsAudit, resetRuntimeConfig,
  type HealthStatus, type LLMStatus, type LLMTestResult, type ScopeCheckResult,
  type RouterStatus, type LlmSettingsSnapshot, type LlmSettingsUpdate, type AuditEntry,
} from '../api'
import { Surface, GlowButton, SectionHeader, LoadingState, ErrorState } from '../components/ui'
import { BrandMark } from '../components/brand'
import { PageHeader } from '../components/layout'

const CONFIG_ITEMS = [
  { key: 'APP_NAME', value: 'ZHULONG-X', desc: '应用名称' },
  { key: 'APP_ENV', value: 'dev', desc: '运行环境' },
  { key: 'BACKEND_PORT', value: '8000', desc: '后端端口' },
  { key: 'FRONTEND_PORT', value: '3000', desc: '前端端口' },
  { key: 'DATABASE_URL', value: 'sqlite:///./data/zhulongx.db', desc: '数据库路径' },
]

export default function Settings() {
  const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null)
  const [llmLoading, setLlmLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<LLMTestResult | null>(null)
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [scopeUrl, setScopeUrl] = useState('')
  const [scopeChecking, setScopeChecking] = useState(false)
  const [scopeResult, setScopeResult] = useState<ScopeCheckResult | null>(null)
  const [scopeError, setScopeError] = useState('')
  const [routerStatus, setRouterStatus] = useState<RouterStatus | null>(null)
  const [llmSettings, setLlmSettings] = useState<LlmSettingsSnapshot | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [editForm, setEditForm] = useState<LlmSettingsUpdate>({})

  useEffect(() => {
    Promise.all([getLLMStatus(), getHealth(), ctfGetRouterStatus(), getLlmSettings()])
      .then(([llm, h, router, settings]) => {
        setLlmStatus(llm.data); setHealth(h.data); setRouterStatus(router.data); setLlmSettings(settings.data)
      })
      .catch(() => {})
      .finally(() => setLlmLoading(false))
    getSettingsAudit(20).then((r) => setAuditEntries(r.data.entries)).catch(() => {})
  }, [])

  const refreshSettings = () => {
    getLlmSettings().then((r) => setLlmSettings(r.data)).catch(() => {})
    ctfGetRouterStatus().then((r) => setRouterStatus(r.data)).catch(() => {})
    getSettingsAudit(20).then((r) => setAuditEntries(r.data.entries)).catch(() => {})
    setEditForm({})
  }

  const handleSave = async () => {
    setSaving(true); setSaveResult(null); setSaveError(null)
    try {
      const isDangerous = editForm.LLM_ROUTER_ENABLED === false
      const r = await updateLlmSettings(editForm, isDangerous)
      setSaveResult(`已更新 ${Object.keys(r.data.applied).length} 项：${Object.keys(r.data.applied).join(', ')}`)
      refreshSettings()
    } catch (e: any) { setSaveError(e?.response?.data?.detail || e.message || '保存失败') }
    finally { setSaving(false) }
  }

  const handleReset = async () => {
    if (!confirm('确定要清空 runtime_config 并恢复 .env 默认吗？')) return
    setSaving(true)
    try {
      await resetRuntimeConfig()
      setSaveResult('runtime_config 已清空，请重启后端恢复 .env 默认')
      refreshSettings()
    } catch (e: any) { setSaveError(e?.response?.data?.detail || e.message) }
    finally { setSaving(false) }
  }

  const updateField = (key: keyof LlmSettingsUpdate, value: string | number | boolean) => {
    setEditForm((p) => ({ ...p, [key]: value }))
  }

  const handleTest = async () => {
    setTesting(true); setTestResult(null)
    try { const r = await testLLM(); setTestResult(r.data) }
    catch (e: any) { setTestResult({ success: false, message: e?.response?.data?.detail || '请求失败', model: '' }) }
    finally { setTesting(false) }
  }

  const handleScopeCheck = async () => {
    if (!scopeUrl.trim()) return
    setScopeChecking(true); setScopeResult(null); setScopeError('')
    try { const r = await scopeCheck(scopeUrl.trim()); setScopeResult(r.data) }
    catch (e: any) { setScopeError(e?.response?.data?.detail || 'Scope 检查失败') }
    finally { setScopeChecking(false) }
  }

  const modeLabel = () => {
    if (!llmStatus) return null
    if (!llmStatus.enabled) return { text: '规则模式', cls: 'text-cyan-400 bg-cyan-400/10 border-cyan-500/30', icon: <Zap size={12} /> }
    if (testResult && !testResult.success) return { text: 'LLM 不可用，规则兜底', cls: 'text-ember-400 bg-ember-400/10 border-ember-500/30', icon: <AlertTriangle size={12} /> }
    return { text: 'LLM 模式', cls: 'text-violet-400 bg-violet-400/10 border-violet-500/30', icon: <Brain size={12} /> }
  }
  const mode = modeLabel()

  return (
    <div className="p-6 md:p-8 max-w-3xl mx-auto">
      <PageHeader
        title="系统设置"
        subtitle="当前平台配置信息（修改请编辑 .env 文件）"
        icon={<Shield size={20} className="text-ember-400" />}
      />

      <Surface variant="panel" className="p-5 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <BrandMark size={24} className="text-ember-400" />
          <div>
            <div className="font-bold text-white">烛龙 X / ZHULONG-X</div>
            <div className="text-xs text-slate-500">自主决策网络安全智能体 · LLM 规则兜底 · 沙箱约束</div>
          </div>
          {mode && (
            <span className={`ml-auto flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg font-medium border ${mode.cls}`}>
              {mode.icon} {mode.text}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {['Python 3.11+', 'FastAPI', 'React 18', 'SQLite', 'WebSocket', 'Agent Runtime'].map((t) => (
            <span key={t} className="px-2 py-1 bg-obsidian-700/60 rounded-lg text-slate-400 border border-obsidian-600/30">{t}</span>
          ))}
        </div>
      </Surface>

      {llmSettings && (
        <Surface variant="panel" className="overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-obsidian-600/30 flex items-center justify-between">
            <SectionHeader title="LLM 配置" icon={<Brain size={14} className="text-violet-400" />} />
            <div className="flex items-center gap-2">
              <GlowButton variant="secondary" size="sm" onClick={handleReset} disabled={saving}>
                恢复默认
              </GlowButton>
              <GlowButton size="sm" onClick={handleSave} disabled={saving || Object.keys(editForm).length === 0} loading={saving}>
                保存{Object.keys(editForm).length > 0 ? ` (${Object.keys(editForm).length})` : ''}
              </GlowButton>
            </div>
          </div>

          {saveResult && (
            <div className="px-5 py-2 bg-jade-500/10 border-b border-jade-500/20 text-xs text-jade-400 flex items-center gap-2">
              <CheckCircle2 size={12} /> {saveResult}
            </div>
          )}
          {saveError && (
            <div className="px-5 py-2 bg-crimson-500/10 border-b border-crimson-500/20 text-xs text-crimson-400 flex items-center gap-2">
              <XCircle size={12} /> {saveError}
            </div>
          )}

          <div className="px-5 py-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-slate-300">启用 LLM</div>
                <div className="text-[10px] text-slate-600">关闭后只走规则引擎 + 静态分析</div>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => updateField('LLM_ENABLED', true)}
                  className={`px-3 py-1 text-[11px] rounded-lg border ${editForm.LLM_ENABLED === true || (!('LLM_ENABLED' in editForm) && llmSettings.global.LLM_ENABLED === true) ? 'bg-jade-500/20 text-jade-300 border-jade-500/40' : 'bg-obsidian-700/50 text-slate-400 border-obsidian-600'}`}
                >ON</button>
                <button type="button" onClick={() => updateField('LLM_ENABLED', false)}
                  className={`px-3 py-1 text-[11px] rounded-lg border ${editForm.LLM_ENABLED === false ? 'bg-crimson-500/20 text-crimson-300 border-crimson-500/40' : 'bg-obsidian-700/50 text-slate-400 border-obsidian-600'}`}
                >OFF</button>
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-500 mb-1 block">Provider 预设</label>
              <div className="flex flex-wrap gap-1">
                {[
                  { name: 'DeepSeek', provider: 'deepseek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
                  { name: 'GLM (智谱)', provider: 'glm', url: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.6' },
                  { name: 'Qwen (阿里)', provider: 'qwen', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-coder-plus' },
                  { name: 'Moonshot', provider: 'moonshot', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
                  { name: 'OpenAI', provider: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                  { name: 'Ollama 本地', provider: 'openai_compatible', url: 'http://localhost:11434/v1', model: 'qwen2.5-coder' },
                ].map((p) => (
                  <button key={p.name} type="button" onClick={() => setEditForm((prev) => ({ ...prev, LLM_PROVIDER: p.provider, LLM_BASE_URL: p.url, LLM_MODEL: p.model }))}
                    className="px-2 py-1 text-[11px] bg-obsidian-700/60 text-slate-300 rounded-lg border border-obsidian-600/40 hover:bg-violet-500/15 hover:text-violet-300 hover:border-violet-500/40 transition-colors"
                  >{p.name}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-500 mb-1 block">API Base URL</label>
              <input type="text" value={editForm.LLM_BASE_URL ?? ''} onChange={(e) => updateField('LLM_BASE_URL', e.target.value)}
                placeholder={String(llmSettings.global.LLM_BASE_URL || 'https://api.deepseek.com/v1')}
                className={`w-full px-3 py-2 bg-obsidian-950/60 border rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none ${'LLM_BASE_URL' in editForm ? 'border-violet-500/60 bg-violet-500/5' : 'border-obsidian-600/40'}`}
              />
            </div>

            <div>
              <label className="text-xs text-slate-500 mb-1 block">API Key <span className="text-slate-600">（留空 = 保持不变）</span></label>
              <input type="password" value={editForm.LLM_API_KEY ?? ''} onChange={(e) => updateField('LLM_API_KEY', e.target.value)}
                placeholder={String(llmSettings.global.LLM_API_KEY || '(not configured)')}
                className={`w-full px-3 py-2 bg-obsidian-950/60 border rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none ${'LLM_API_KEY' in editForm && editForm.LLM_API_KEY ? 'border-violet-500/60 bg-violet-500/5' : 'border-obsidian-600/40'}`}
              />
            </div>

            <div>
              <label className="text-xs text-slate-500 mb-1 block">Model</label>
              <input type="text" value={editForm.LLM_MODEL ?? ''} onChange={(e) => updateField('LLM_MODEL', e.target.value)}
                placeholder={String(llmSettings.global.LLM_MODEL || 'deepseek-chat')}
                className={`w-full px-3 py-2 bg-obsidian-950/60 border rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none ${'LLM_MODEL' in editForm ? 'border-violet-500/60 bg-violet-500/5' : 'border-obsidian-600/40'}`}
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-obsidian-600/30">
              <div className="text-xs text-slate-500">
                当前状态：
                <span className={`ml-1 font-mono ${llmSettings.global.LLM_ENABLED ? 'text-jade-400' : 'text-slate-500'}`}>
                  {llmSettings.global.LLM_ENABLED ? '● live' : '○ disabled'}
                </span>
                <span className="ml-2 text-slate-600">|</span>
                <span className="ml-2">{String(llmSettings.global.LLM_API_KEY).includes('configured') ? '✓ key 已配置' : '✗ 无 key (mock)'}</span>
              </div>
              <GlowButton variant="secondary" size="sm" onClick={handleTest} disabled={testing} loading={testing}>
                <Zap size={12} /> 测试连接
              </GlowButton>
            </div>

            {testResult !== null && (
              <div className={`px-3 py-2 text-xs rounded-lg border flex items-start gap-2 ${testResult.success ? 'bg-jade-500/10 text-jade-400 border-jade-500/20' : 'bg-crimson-500/10 text-crimson-400 border-crimson-500/20'}`}>
                {testResult.success ? <CheckCircle2 size={14} className="shrink-0 mt-0.5" /> : <XCircle size={14} className="shrink-0 mt-0.5" />}
                <div>
                  <div className="font-medium">{testResult.success ? '连接成功' : '连接失败'}</div>
                  <div className="text-slate-400">{testResult.message}</div>
                </div>
              </div>
            )}

            {auditEntries.length > 0 && (
              <details className="pt-2 border-t border-obsidian-600/30">
                <summary className="text-[11px] text-slate-500 cursor-pointer hover:text-slate-300">
                  最近配置变更（{auditEntries.length} 条）
                </summary>
                <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                  {auditEntries.slice(0, 10).map((e, i) => (
                    <div key={i} className="text-[10px] font-mono text-slate-500 flex gap-2">
                      <span className="text-slate-600">{new Date(e.ts * 1000).toLocaleString('zh-CN', { hour12: false })}</span>
                      <span className="text-ember-300">{e.field}</span>
                      <span className="text-slate-600">:</span>
                      <span className="text-slate-500">{e.old}</span>
                      <span className="text-slate-600">→</span>
                      <span className="text-jade-300">{e.new}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}

            <div className="text-[10px] text-slate-600 pt-1">
              配置保存后热重载，无需重启。API key 永不明文显示。v6 模型路由会自动复用此配置作为 cheap lane。
            </div>
          </div>
        </Surface>
      )}

      {health?.scope_config_summary && (
        <Surface variant="panel" className="overflow-hidden mb-6">
          <div className="px-5 py-3 border-b border-obsidian-600/30">
            <SectionHeader title="ScopeGuard" icon={<Shield size={14} className="text-cyan-400" />} />
          </div>
          <div className="divide-y divide-obsidian-600/20">
            <InfoRow k="Competition Mode" v={health.scope_config_summary.competition_mode ? 'true' : 'false'} highlight={health.scope_config_summary.competition_mode} />
            <InfoRow k="CIDR" v={health.scope_config_summary.cidrs.join(', ') || '(empty)'} warn={!health.scope_config_summary.cidrs.length && health.scope_config_summary.competition_mode} />
            <InfoRow k="Domains" v={health.scope_config_summary.domains.join(', ') || '(empty)'} />
            <InfoRow k="Ports" v={health.scope_config_summary.ports.join(', ') || 'any'} />
            <InfoRow k="Localhost" v={health.scope_config_summary.allow_localhost ? 'allowed when scoped' : 'blocked'} />
            <InfoRow k="Private IP" v={health.scope_config_summary.allow_private_ips ? 'allowed when scoped' : 'blocked'} />
            <InfoRow k="Request Budget" v={`${health.scope_config_summary.max_requests_per_task}/task, ${health.scope_config_summary.max_requests_per_target}/target`} />
          </div>
          <div className="border-t border-obsidian-600/30 p-4">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input
                className="bg-obsidian-950/60 border border-obsidian-600/40 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-ember-500/40"
                placeholder="http://target.example:8080/path"
                value={scopeUrl}
                onChange={(e) => setScopeUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleScopeCheck() }}
              />
              <GlowButton variant="secondary" size="sm" onClick={handleScopeCheck} disabled={scopeChecking} loading={scopeChecking}>
                <Search size={12} /> 检查
              </GlowButton>
            </div>
            {scopeError && (
              <div className="mt-3 text-xs text-crimson-400 flex items-center gap-2"><XCircle size={14} /> {scopeError}</div>
            )}
            {scopeResult && (
              <div className={`mt-3 rounded-lg border px-3 py-3 text-xs ${scopeResult.allowed ? 'border-jade-500/20 bg-jade-500/10 text-jade-300' : 'border-crimson-500/20 bg-crimson-500/10 text-crimson-300'}`}>
                <div className="flex items-center gap-2 font-medium">
                  {scopeResult.allowed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  {scopeResult.allowed ? '允许' : '拦截'} · {scopeResult.reason}
                </div>
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-400">
                  <div>Host: <span className="text-slate-200">{scopeResult.host || '-'}</span></div>
                  <div>Port: <span className="text-slate-200">{scopeResult.port || '-'}</span></div>
                  <div>Rule: <span className="text-slate-200">{scopeResult.matched_rule || '-'}</span></div>
                  <div>Mode: <span className="text-slate-200">{scopeResult.competition_mode ? 'competition' : 'safe'}</span></div>
                  <div className="sm:col-span-2">Resolved: <span className="text-slate-200">{scopeResult.resolved_ip_summary.join(', ') || '-'}</span></div>
                </div>
              </div>
            )}
          </div>
        </Surface>
      )}

      <Surface variant="panel" className="overflow-hidden mb-6">
        <div className="px-5 py-3 border-b border-obsidian-600/30 text-sm font-medium text-white">环境配置</div>
        <div className="divide-y divide-obsidian-600/20">
          {CONFIG_ITEMS.map((item) => (
            <div key={item.key} className="flex items-center justify-between px-5 py-3">
              <div>
                <div className="text-sm font-mono text-cyan-400">{item.key}</div>
                <div className="text-xs text-slate-500">{item.desc}</div>
              </div>
              <div className="text-sm text-slate-300 font-mono">{item.value}</div>
            </div>
          ))}
        </div>
      </Surface>

      <Surface variant="panel" className="overflow-hidden">
        <div className="px-5 py-3 border-b border-obsidian-600/30 text-sm font-medium text-white">快速链接</div>
        <div className="divide-y divide-obsidian-600/20">
          {[
            { label: 'API 文档 (Swagger UI)', href: '/docs' },
            { label: '健康检查接口', href: '/api/health' },
            { label: 'LLM 状态接口', href: '/api/llm/status' },
          ].map((link) => (
            <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-between px-5 py-3 hover:bg-obsidian-800/40 transition-colors group">
              <span className="text-sm text-slate-300">{link.label}</span>
              <ExternalLink size={14} className="text-slate-500 group-hover:text-cyan-400" />
            </a>
          ))}
        </div>
      </Surface>

      <div className="mt-6 text-xs text-slate-600 text-center">
        本平台仅用于授权安全测试，禁止用于非法用途
      </div>
    </div>
  )
}

function InfoRow({ k, v, highlight, warn }: { k: string; v: string; highlight?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <div className="text-xs text-slate-500">{k}</div>
      <div className={`text-xs font-mono ${highlight ? 'text-jade-400' : warn ? 'text-ember-400' : 'text-slate-300'}`}>{v}</div>
    </div>
  )
}
