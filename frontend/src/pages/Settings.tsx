import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, ExternalLink, RotateCcw, Save, Shield, XCircle } from 'lucide-react'
import {
  ctfGetRouterStatus,
  getHealth,
  getLLMStatus,
  getLlmSettings,
  getSettingsAudit,
  resetRuntimeConfig,
  scopeCheck,
  testLLM,
  updateLlmSettings,
  type AuditEntry,
  type HealthStatus,
  type LLMStatus,
  type LLMTestResult,
  type LlmSettingsSnapshot,
  type LlmSettingsUpdate,
  type RouterStatus,
  type ScopeCheckResult,
} from '../api'
import { AuditLogTimeline, ModelRouterStatus, ScopeGuardConsole } from '../components/security'
import { BrandMark } from '../components/brand'
import { ErrorState, GlassPanel, GlowButton, LoadingState, StatePill } from '../components/ui'

const CONFIG_ITEMS = [
  { key: 'APP_NAME', value: 'ZHULONG-X', desc: '应用名称' },
  { key: 'APP_ENV', value: 'dev', desc: '运行环境' },
  { key: 'BACKEND_PORT', value: '8000', desc: '后端端口' },
  { key: 'FRONTEND_PORT', value: '3000', desc: '前端端口' },
  { key: 'DATABASE_URL', value: 'sqlite:///./data/zhulongx.db', desc: '数据库路径' },
]

const PRESETS = [
  { name: 'DeepSeek', provider: 'deepseek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'GLM', provider: 'glm', url: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-4.6' },
  { name: 'Qwen', provider: 'qwen', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-coder-plus' },
  { name: 'Moonshot', provider: 'moonshot', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: 'OpenAI', provider: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'Ollama 本地', provider: 'openai_compatible', url: 'http://localhost:11434/v1', model: 'qwen2.5-coder' },
]

function truthy(value: unknown) {
  return value === true || value === 'true' || value === '1'
}

export default function Settings() {
  const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null)
  const [testResult, setTestResult] = useState<LLMTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [routerStatus, setRouterStatus] = useState<RouterStatus | null>(null)
  const [llmSettings, setLlmSettings] = useState<LlmSettingsSnapshot | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [editForm, setEditForm] = useState<LlmSettingsUpdate>({})
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [scopeUrl, setScopeUrl] = useState('')
  const [scopeChecking, setScopeChecking] = useState(false)
  const [scopeResult, setScopeResult] = useState<ScopeCheckResult | null>(null)
  const [scopeError, setScopeError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoadError(null)
    Promise.all([getLLMStatus(), getHealth(), ctfGetRouterStatus(), getLlmSettings(), getSettingsAudit(30)])
      .then(([llm, healthResponse, router, settings, audit]) => {
        setLlmStatus(llm.data)
        setHealth(healthResponse.data)
        setRouterStatus(router.data)
        setLlmSettings(settings.data)
        setAuditEntries(audit.data.entries)
      })
      .catch((e) => setLoadError(e?.response?.data?.detail || e.message || '加载设置失败'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  const refreshSettings = () => {
    getLlmSettings().then((response) => setLlmSettings(response.data)).catch(() => {})
    ctfGetRouterStatus().then((response) => setRouterStatus(response.data)).catch(() => {})
    getSettingsAudit(30).then((response) => setAuditEntries(response.data.entries)).catch(() => {})
    getLLMStatus().then((response) => setLlmStatus(response.data)).catch(() => {})
    setEditForm({})
  }

  const updateField = (key: keyof LlmSettingsUpdate, value: string | number | boolean) => {
    setEditForm((previous) => ({ ...previous, [key]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveResult(null)
    setSaveError(null)
    try {
      const isDangerous = editForm.LLM_ROUTER_ENABLED === false
      const response = await updateLlmSettings(editForm, isDangerous)
      setSaveResult(`已更新 ${Object.keys(response.data.applied).length} 项：${Object.keys(response.data.applied).join(', ')}`)
      refreshSettings()
    } catch (e: any) {
      setSaveError(e?.response?.data?.detail || e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!window.confirm('确定要清空 runtime_config 并恢复 .env 默认吗？')) return
    setSaving(true)
    try {
      await resetRuntimeConfig()
      setSaveResult('runtime_config 已清空，请重启后端恢复 .env 默认')
      refreshSettings()
    } catch (e: any) {
      setSaveError(e?.response?.data?.detail || e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const response = await testLLM()
      setTestResult(response.data)
    } catch (e: any) {
      setTestResult({ success: false, message: e?.response?.data?.detail || '请求失败', model: '' })
    } finally {
      setTesting(false)
    }
  }

  const handleScopeCheck = async () => {
    if (!scopeUrl.trim()) return
    setScopeChecking(true)
    setScopeResult(null)
    setScopeError('')
    try {
      const response = await scopeCheck(scopeUrl.trim())
      setScopeResult(response.data)
    } catch (e: any) {
      setScopeError(e?.response?.data?.detail || 'Scope 检查失败')
    } finally {
      setScopeChecking(false)
    }
  }

  if (loading) return <div className="mx-auto max-w-[1500px] p-6"><LoadingState message="加载安全边界控制台" /></div>
  if (loadError) return <div className="mx-auto max-w-[1500px] p-6"><ErrorState title="设置加载失败" detail={loadError} onRetry={load} /></div>

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6 lg:p-8">
      <GlassPanel tone="jade" className="p-0">
        <div className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:p-6">
          <div>
            <div className="mb-4 flex flex-wrap gap-2">
              <StatePill tone="jade" icon={<Shield size={13} />}>安全边界控制台</StatePill>
              <StatePill tone={health?.scope_config_summary?.configured ? 'jade' : 'ember'}>
                Scope {health?.scope_config_summary?.configured ? 'configured' : 'empty'}
              </StatePill>
              <StatePill tone={llmStatus?.enabled ? 'violet' : 'cyan'}>
                {llmStatus?.enabled ? 'LLM live' : 'rule fallback'}
              </StatePill>
            </div>
            <div className="flex items-start gap-4">
              <BrandMark size={38} className="mt-1 text-ember-300" />
              <div>
                <h1 className="text-3xl font-black text-white md:text-5xl">默认拒绝，授权放行</h1>
                <p className="mt-3 max-w-4xl text-sm leading-7 text-slate-300">
                  Settings 不是普通配置页，而是让评委确认玄枢不会越界的控制台：ScopeGuard、模型路由、运行配置与审计链路都在这里可见。
                </p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:min-w-[360px]">
            <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3"><div className="text-[11px] text-slate-500">Audit</div><div className="mt-1 text-2xl font-bold text-white">{auditEntries.length}</div></div>
            <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-3"><div className="text-[11px] text-slate-500">Router</div><div className="mt-1 text-sm font-bold text-white">{routerStatus?.router_enabled ? 'ON' : 'OFF'}</div></div>
            <div className="col-span-2 rounded-lg border border-ember-500/20 bg-ember-500/10 p-3 text-xs leading-5 text-ember-100">
              API key 永不明文显示，危险配置需要二次确认。
            </div>
          </div>
        </div>
      </GlassPanel>

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <ScopeGuardConsole
          health={health}
          url={scopeUrl}
          checking={scopeChecking}
          result={scopeResult}
          error={scopeError}
          onUrlChange={setScopeUrl}
          onCheck={handleScopeCheck}
        />
        <ModelRouterStatus
          llmStatus={llmStatus}
          routerStatus={routerStatus}
          testResult={testResult}
          testing={testing}
          onTest={handleTest}
        />
      </div>

      {llmSettings && (
        <GlassPanel tone="violet">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-violet-300">Runtime LLM Config</div>
              <h2 className="mt-1 text-lg font-semibold text-white">LLM 配置</h2>
              <p className="mt-1 text-xs leading-5 text-slate-400">保存后热重载。留空 API key 表示保持不变，不会回显密钥。</p>
            </div>
            <div className="flex gap-2">
              <GlowButton variant="secondary" size="sm" onClick={handleReset} disabled={saving}><RotateCcw size={13} /> 恢复默认</GlowButton>
              <GlowButton size="sm" onClick={handleSave} disabled={saving || Object.keys(editForm).length === 0} loading={saving}><Save size={13} /> 保存{Object.keys(editForm).length ? ` (${Object.keys(editForm).length})` : ''}</GlowButton>
            </div>
          </div>

          {saveResult && <div className="mb-3 flex items-center gap-2 rounded-lg border border-jade-500/25 bg-jade-500/10 px-3 py-2 text-xs text-jade-300"><CheckCircle2 size={13} /> {saveResult}</div>}
          {saveError && <div className="mb-3 flex items-center gap-2 rounded-lg border border-crimson-500/25 bg-crimson-500/10 px-3 py-2 text-xs text-crimson-300"><XCircle size={13} /> {saveError}</div>}

          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-800 bg-obsidian-950/45 p-4">
                <div className="mb-3 text-sm font-semibold text-white">启用 LLM</div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => updateField('LLM_ENABLED', true)} className={`rounded-lg border px-4 py-2 text-xs ${editForm.LLM_ENABLED === true || (!('LLM_ENABLED' in editForm) && truthy(llmSettings.global.LLM_ENABLED)) ? 'border-jade-500/40 bg-jade-500/15 text-jade-300' : 'border-slate-700 text-slate-400'}`}>ON</button>
                  <button type="button" onClick={() => updateField('LLM_ENABLED', false)} className={`rounded-lg border px-4 py-2 text-xs ${editForm.LLM_ENABLED === false ? 'border-crimson-500/40 bg-crimson-500/15 text-crimson-300' : 'border-slate-700 text-slate-400'}`}>OFF</button>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-slate-300">Provider 预设</label>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      onClick={() => setEditForm((previous) => ({ ...previous, LLM_PROVIDER: preset.provider, LLM_BASE_URL: preset.url, LLM_MODEL: preset.model }))}
                      className="rounded-lg border border-slate-700 bg-obsidian-950/45 px-3 py-1.5 text-xs text-slate-300 transition hover:border-violet-500/40 hover:bg-violet-500/10 hover:text-violet-200"
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-300">API Base URL</span>
                <input className="input" value={String(editForm.LLM_BASE_URL ?? '')} onChange={(event) => updateField('LLM_BASE_URL', event.target.value)} placeholder={String(llmSettings.global.LLM_BASE_URL || 'https://api.deepseek.com/v1')} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-300">API Key <span className="text-slate-600">留空保持不变</span></span>
                <input className="input" type="password" value={String(editForm.LLM_API_KEY ?? '')} onChange={(event) => updateField('LLM_API_KEY', event.target.value)} placeholder={String(llmSettings.global.LLM_API_KEY || '(not configured)')} />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-slate-300">Model</span>
                <input className="input" value={String(editForm.LLM_MODEL ?? '')} onChange={(event) => updateField('LLM_MODEL', event.target.value)} placeholder={String(llmSettings.global.LLM_MODEL || 'deepseek-chat')} />
              </label>
            </div>
          </div>
        </GlassPanel>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <AuditLogTimeline entries={auditEntries} />
        <div className="space-y-4">
          <GlassPanel tone="slate">
            <h2 className="mb-3 text-lg font-semibold text-white">环境配置</h2>
            <div className="space-y-2">
              {CONFIG_ITEMS.map((item) => (
                <div key={item.key} className="rounded-lg border border-slate-800 bg-obsidian-950/45 px-3 py-2">
                  <div className="font-mono text-xs text-cyan-300">{item.key}</div>
                  <div className="mt-1 text-xs text-slate-500">{item.desc}</div>
                  <div className="mt-1 break-all font-mono text-xs text-slate-300">{item.value}</div>
                </div>
              ))}
            </div>
          </GlassPanel>
          <GlassPanel tone="cyan">
            <h2 className="mb-3 text-lg font-semibold text-white">快速链接</h2>
            <div className="divide-y divide-slate-800">
              {[
                { label: 'API 文档 (Swagger UI)', href: '/docs' },
                { label: '健康检查接口', href: '/api/health' },
                { label: 'LLM 状态接口', href: '/api/llm/status' },
              ].map((link) => (
                <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className="flex items-center justify-between py-3 text-sm text-slate-300 hover:text-cyan-200">
                  {link.label}
                  <ExternalLink size={14} />
                </a>
              ))}
            </div>
          </GlassPanel>
        </div>
      </div>

      <GlassPanel tone="ember" compact className="text-center text-xs leading-5 text-slate-400">
        本平台仅用于授权安全测试、CTF、靶场与教学环境。未授权目标默认拒绝，危险配置必须经过人工确认。
      </GlassPanel>
    </div>
  )
}
