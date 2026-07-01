import { useEffect, useState } from 'react'
import { Shield, ExternalLink, Loader2, CheckCircle2, XCircle, Zap, Brain, AlertTriangle, Search, Layers } from 'lucide-react'
import { getHealth, getLLMStatus, scopeCheck, testLLM, ctfGetRouterStatus, getLlmSettings, updateLlmSettings, getSettingsAudit, resetRuntimeConfig, HealthStatus, LLMStatus, LLMTestResult, ScopeCheckResult, RouterStatus, LlmSettingsSnapshot, LlmSettingsUpdate, AuditEntry } from '../api'

const CONFIG_ITEMS = [
  { key: 'APP_NAME', value: 'CyberPilot', desc: '应用名称' },
  { key: 'APP_ENV', value: 'dev', desc: '运行环境' },
  { key: 'BACKEND_PORT', value: '8000', desc: '后端端口' },
  { key: 'FRONTEND_PORT', value: '3000', desc: '前端端口' },
  { key: 'DATABASE_URL', value: 'sqlite:///./data/cyberpilot.db', desc: '数据库路径' },
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
        setLlmStatus(llm.data)
        setHealth(h.data)
        setRouterStatus(router.data)
        setLlmSettings(settings.data)
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
    setSaving(true)
    setSaveResult(null)
    setSaveError(null)
    try {
      const isDangerous = editForm.LLM_ROUTER_ENABLED === false
      const r = await updateLlmSettings(editForm, isDangerous)
      setSaveResult(`已更新 ${Object.keys(r.data.applied).length} 项：${Object.keys(r.data.applied).join(', ')}`)
      refreshSettings()
    } catch (e: any) {
      setSaveError(e?.response?.data?.detail || e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!confirm('确定要清空 runtime_config 并恢复 .env 默认吗？')) return
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

  const updateField = (key: keyof LlmSettingsUpdate, value: string | number | boolean) => {
    setEditForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await testLLM()
      setTestResult(r.data)
    } catch (e: any) {
      setTestResult({ success: false, message: e?.response?.data?.detail || '请求失败', model: '' })
    } finally {
      setTesting(false)
    }
  }

  const modeLabel = () => {
    if (!llmStatus) return null
    if (!llmStatus.enabled) return { text: '规则模式', cls: 'text-cyan-400 bg-cyan-400/10', icon: <Zap size={12} /> }
    if (testResult && !testResult.success) return { text: 'LLM 不可用，规则兜底', cls: 'text-orange-400 bg-orange-400/10', icon: <AlertTriangle size={12} /> }
    return { text: 'LLM 模式', cls: 'text-purple-400 bg-purple-400/10', icon: <Brain size={12} /> }
  }
  const mode = modeLabel()

  const handleScopeCheck = async () => {
    if (!scopeUrl.trim()) return
    setScopeChecking(true)
    setScopeResult(null)
    setScopeError('')
    try {
      const r = await scopeCheck(scopeUrl.trim())
      setScopeResult(r.data)
    } catch (e: any) {
      setScopeError(e?.response?.data?.detail || 'Scope 检查失败')
    } finally {
      setScopeChecking(false)
    }
  }

  return (
    <div className="p-8 max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">系统设置</h1>
        <p className="text-gray-400 text-sm mt-1">当前平台配置信息（修改请编辑 .env 文件）</p>
      </div>

      {/* System Info */}
      <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-5 mb-5">
        <div className="flex items-center gap-3 mb-4">
          <Shield size={22} className="text-cyan-400" />
          <div>
            <div className="font-bold text-white">CyberPilot FinalOps v4</div>
            <div className="text-xs text-gray-500">决赛作战台 · LLM 规则兜底 · Podman 交付</div>
          </div>
          {mode && (
            <span className={`ml-auto flex items-center gap-1 text-xs px-2 py-1 rounded font-medium ${mode.cls}`}>
              {mode.icon} {mode.text}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="px-2 py-1 bg-[#1f2937] rounded text-gray-400">Python 3.11+</span>
          <span className="px-2 py-1 bg-[#1f2937] rounded text-gray-400">FastAPI</span>
          <span className="px-2 py-1 bg-[#1f2937] rounded text-gray-400">React 18</span>
          <span className="px-2 py-1 bg-[#1f2937] rounded text-gray-400">SQLite</span>
          <span className="px-2 py-1 bg-[#1f2937] rounded text-gray-400">WebSocket</span>
          <span className="px-2 py-1 bg-[#1f2937] rounded text-gray-400">Podman</span>
        </div>
      </div>

      {/* LLM Status */}
      <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden mb-5">
        <div className="px-5 py-3 border-b border-[#1f2937] font-medium text-white text-sm flex items-center gap-2">
          <Brain size={14} className="text-purple-400" /> LLM 配置
        </div>
        {llmLoading ? (
          <div className="px-5 py-4 text-gray-400 text-sm flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> 加载中...
          </div>
        ) : llmStatus ? (
          <div className="divide-y divide-[#1f2937]">
            <LLMRow k="启用状态" v={llmStatus.enabled ? '已启用' : '已禁用'} highlight={llmStatus.enabled} />
            <LLMRow k="Provider" v={llmStatus.provider} />
            <LLMRow k="Base URL Host" v={llmStatus.base_url_host || llmStatus.base_url} />
            <LLMRow k="API Key" v={llmStatus.api_key_configured ? '已配置 (脱敏显示)' : '未配置'} warn={!llmStatus.api_key_configured} />
            <LLMRow k="模型" v={llmStatus.model} />
            <LLMRow k="超时/重试" v={`${llmStatus.timeout || '-'}s / ${llmStatus.max_retries ?? '-'}`} />
            <LLMRow k="最近错误" v={llmStatus.last_error || '无'} warn={Boolean(llmStatus.last_error)} />
            <div className="px-5 py-3 flex items-center justify-between">
              <span className="text-xs text-gray-500">连接测试</span>
              <button
                onClick={handleTest}
                disabled={testing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white text-xs rounded-lg hover:bg-purple-500 disabled:opacity-50"
              >
                {testing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                测试 LLM 连接
              </button>
            </div>
            {testResult !== null && (
              <div className={`px-5 py-3 text-xs flex items-start gap-2 ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                {testResult.success
                  ? <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                  : <XCircle size={14} className="shrink-0 mt-0.5" />}
                <div>
                  <div className="font-medium mb-0.5">{testResult.success ? '连接成功' : '连接失败'}</div>
                  <div className="text-gray-400">{testResult.message}</div>
                  {testResult.model && <div className="text-gray-500 mt-0.5">模型: {testResult.model}</div>}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="px-5 py-4 text-red-400 text-sm">获取 LLM 状态失败</div>
        )}
      </div>

      {/* v6.1: 可编辑 LLM 配置 */}
      {llmSettings && (
        <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden mb-5">
          <div className="px-5 py-3 border-b border-[#1f2937] font-medium text-white text-sm flex items-center gap-2 justify-between">
            <span className="flex items-center gap-2">
              <Layers size={14} className="text-amber-400" /> v6 模型路由配置（可编辑）
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleReset}
                disabled={saving}
                className="flex items-center gap-1 px-2 py-1 text-[11px] border border-red-500/30 text-red-300 rounded hover:bg-red-500/10 disabled:opacity-50"
              >
                恢复默认
              </button>
              <button
                onClick={handleSave}
                disabled={saving || Object.keys(editForm).length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-xs rounded-lg hover:bg-amber-500 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                保存 ({Object.keys(editForm).length})
              </button>
            </div>
          </div>
          {saveResult && (
            <div className="px-5 py-2 bg-green-500/10 border-b border-green-500/20 text-xs text-green-300">{saveResult}</div>
          )}
          {saveError && (
            <div className="px-5 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-300">{saveError}</div>
          )}

          {/* Router 全局 */}
          <div className="px-5 py-3 border-b border-[#1f2937]">
            <div className="text-[10px] text-amber-300 uppercase mb-2 font-bold">Router 全局</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <SettingField
                label="路由启用" type="bool"
                current={llmSettings.router.LLM_ROUTER_ENABLED as boolean}
                edited={editForm.LLM_ROUTER_ENABLED as boolean | undefined}
                onChange={(v) => updateField('LLM_ROUTER_ENABLED', v)}
                warn={editForm.LLM_ROUTER_ENABLED === false}
              />
              <SettingField
                label="单题预算 (USD)" type="number" step="0.01"
                current={llmSettings.router.LLM_BUDGET_PER_TASK_USD as number}
                edited={editForm.LLM_BUDGET_PER_TASK_USD as number | undefined}
                onChange={(v) => updateField('LLM_BUDGET_PER_TASK_USD', Number(v))}
              />
              <SettingField
                label="日预算 (USD)" type="number" step="0.10"
                current={llmSettings.router.LLM_BUDGET_DAILY_USD as number}
                edited={editForm.LLM_BUDGET_DAILY_USD as number | undefined}
                onChange={(v) => updateField('LLM_BUDGET_DAILY_USD', Number(v))}
              />
              <SettingField
                label="压缩阈值 (chars)" type="number"
                current={llmSettings.router.LLM_COMPRESS_THRESHOLD_CHARS as number}
                edited={editForm.LLM_COMPRESS_THRESHOLD_CHARS as number | undefined}
                onChange={(v) => updateField('LLM_COMPRESS_THRESHOLD_CHARS', Number(v))}
              />
            </div>
          </div>

          {/* Cheap Lane */}
          <div className="px-5 py-3 border-b border-[#1f2937]">
            <div className="text-[10px] text-blue-300 uppercase mb-2 font-bold">Cheap Lane（日常分类/计划，推荐 DeepSeek-V4-Flash）</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
              <SettingField label="Provider" current={llmSettings.cheap.LLM_CHEAP_PROVIDER as string} edited={editForm.LLM_CHEAP_PROVIDER} onChange={(v) => updateField('LLM_CHEAP_PROVIDER', v)} />
              <SettingField label="Model" current={llmSettings.cheap.LLM_CHEAP_MODEL as string} edited={editForm.LLM_CHEAP_MODEL} onChange={(v) => updateField('LLM_CHEAP_MODEL', v)} />
              <SettingField label="Base URL" current={llmSettings.cheap.LLM_CHEAP_BASE_URL as string} edited={editForm.LLM_CHEAP_BASE_URL} onChange={(v) => updateField('LLM_CHEAP_BASE_URL', v)} />
              <SettingField label="Max Tokens" type="number" current={llmSettings.cheap.LLM_CHEAP_MAX_TOKENS as number} edited={editForm.LLM_CHEAP_MAX_TOKENS as number | undefined} onChange={(v) => updateField('LLM_CHEAP_MAX_TOKENS', Number(v))} />
              <SettingField label="Temperature" type="number" step="0.1" current={llmSettings.cheap.LLM_CHEAP_TEMPERATURE as number} edited={editForm.LLM_CHEAP_TEMPERATURE as number | undefined} onChange={(v) => updateField('LLM_CHEAP_TEMPERATURE', Number(v))} />
              <SettingField
                label="API Key" type="password" sensitive
                current={llmSettings.cheap.LLM_CHEAP_API_KEY as string}
                edited={editForm.LLM_CHEAP_API_KEY}
                onChange={(v) => updateField('LLM_CHEAP_API_KEY', v)}
                placeholder="留空=保持不变，输入新值=更新"
              />
            </div>
          </div>

          {/* Expert Lane */}
          <div className="px-5 py-3 border-b border-[#1f2937]">
            <div className="text-[10px] text-purple-300 uppercase mb-2 font-bold">Expert Lane（复杂/卡住时升级，推荐 GLM-5.2）</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
              <SettingField label="Provider" current={llmSettings.expert.LLM_EXPERT_PROVIDER as string} edited={editForm.LLM_EXPERT_PROVIDER} onChange={(v) => updateField('LLM_EXPERT_PROVIDER', v)} />
              <SettingField label="Model" current={llmSettings.expert.LLM_EXPERT_MODEL as string} edited={editForm.LLM_EXPERT_MODEL} onChange={(v) => updateField('LLM_EXPERT_MODEL', v)} />
              <SettingField label="Base URL" current={llmSettings.expert.LLM_EXPERT_BASE_URL as string} edited={editForm.LLM_EXPERT_BASE_URL} onChange={(v) => updateField('LLM_EXPERT_BASE_URL', v)} />
              <SettingField label="Max Tokens" type="number" current={llmSettings.expert.LLM_EXPERT_MAX_TOKENS as number} edited={editForm.LLM_EXPERT_MAX_TOKENS as number | undefined} onChange={(v) => updateField('LLM_EXPERT_MAX_TOKENS', Number(v))} />
              <SettingField label="Temperature" type="number" step="0.1" current={llmSettings.expert.LLM_EXPERT_TEMPERATURE as number} edited={editForm.LLM_EXPERT_TEMPERATURE as number | undefined} onChange={(v) => updateField('LLM_EXPERT_TEMPERATURE', Number(v))} />
              <SettingField
                label="API Key" type="password" sensitive
                current={llmSettings.expert.LLM_EXPERT_API_KEY as string}
                edited={editForm.LLM_EXPERT_API_KEY}
                onChange={(v) => updateField('LLM_EXPERT_API_KEY', v)}
                placeholder="留空=保持不变，输入新值=更新"
              />
            </div>
          </div>

          {/* Fallback Lane */}
          <div className="px-5 py-3 border-b border-[#1f2937]">
            <div className="text-[10px] text-gray-300 uppercase mb-2 font-bold">Fallback Lane（备用，可选）</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
              <SettingField label="Provider" current={llmSettings.fallback.LLM_FALLBACK_PROVIDER as string} edited={editForm.LLM_FALLBACK_PROVIDER} onChange={(v) => updateField('LLM_FALLBACK_PROVIDER', v)} />
              <SettingField label="Model" current={llmSettings.fallback.LLM_FALLBACK_MODEL as string} edited={editForm.LLM_FALLBACK_MODEL} onChange={(v) => updateField('LLM_FALLBACK_MODEL', v)} />
              <SettingField label="Base URL" current={llmSettings.fallback.LLM_FALLBACK_BASE_URL as string} edited={editForm.LLM_FALLBACK_BASE_URL} onChange={(v) => updateField('LLM_FALLBACK_BASE_URL', v)} />
              <SettingField
                label="API Key" type="password" sensitive
                current={llmSettings.fallback.LLM_FALLBACK_API_KEY as string}
                edited={editForm.LLM_FALLBACK_API_KEY}
                onChange={(v) => updateField('LLM_FALLBACK_API_KEY', v)}
                placeholder="留空=保持不变"
              />
            </div>
          </div>

          {/* 今日成本 + 审计 */}
          {routerStatus && (
            <div className="px-5 py-3 border-b border-[#1f2937] grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-gray-500 mb-1">今日已用成本</div>
                <div className={`font-mono font-bold ${routerStatus.daily_total_cost_usd > routerStatus.budget_daily_usd * 0.8 ? 'text-red-300' : 'text-green-300'}`}>
                  ${routerStatus.daily_total_cost_usd.toFixed(6)} / ${routerStatus.budget_daily_usd.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-gray-500 mb-1">运行状态</div>
                <div className="text-gray-300">
                  {routerStatus.router_enabled ? '✓ 路由启用' : '✗ 路由禁用'} ·
                  cheap:{routerStatus.cheap.api_key_configured ? '✓' : '✗'} ·
                  expert:{routerStatus.expert.api_key_configured ? '✓' : '✗'}
                </div>
              </div>
            </div>
          )}

          {auditEntries.length > 0 && (
            <div className="px-5 py-3">
              <div className="text-[10px] text-gray-500 uppercase mb-2">最近配置变更（审计日志）</div>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {auditEntries.slice(0, 10).map((e, i) => (
                  <div key={i} className="text-[11px] font-mono text-gray-400 flex gap-2">
                    <span className="text-gray-600">{new Date(e.ts * 1000).toLocaleString('zh-CN', { hour12: false })}</span>
                    <span className="text-amber-300">{e.field}</span>
                    <span className="text-gray-500">:</span>
                    <span className="text-gray-500">{e.old}</span>
                    <span className="text-gray-500">→</span>
                    <span className="text-green-300">{e.new}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="px-5 py-3 text-[10px] text-gray-600 border-t border-[#1f2937]">
            分级规则：静态命中 → 不调 LLM；日常 → cheap；连续失败/循环/长上下文 → 升级 expert；超预算 → 转人工。
            API key 永不明文显示，留空提交=保持不变，配置热重载无需重启。
          </div>
        </div>
      )}

      {health?.scope_config_summary && (
        <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden mb-5">
          <div className="px-5 py-3 border-b border-[#1f2937] font-medium text-white text-sm flex items-center gap-2">
            <Shield size={14} className="text-cyan-400" /> ScopeGuard
          </div>
          <div className="divide-y divide-[#1f2937]">
            <LLMRow k="Competition Mode" v={health.scope_config_summary.competition_mode ? 'true' : 'false'} highlight={health.scope_config_summary.competition_mode} />
            <LLMRow k="CIDR" v={health.scope_config_summary.cidrs.join(', ') || '(empty)'} warn={!health.scope_config_summary.cidrs.length && health.scope_config_summary.competition_mode} />
            <LLMRow k="Domains" v={health.scope_config_summary.domains.join(', ') || '(empty)'} />
            <LLMRow k="Ports" v={health.scope_config_summary.ports.join(', ') || 'any'} />
            <LLMRow k="Localhost" v={health.scope_config_summary.allow_localhost ? 'allowed when scoped' : 'blocked'} />
            <LLMRow k="Private IP" v={health.scope_config_summary.allow_private_ips ? 'allowed when scoped' : 'blocked'} />
            <LLMRow k="Request Budget" v={`${health.scope_config_summary.max_requests_per_task}/task, ${health.scope_config_summary.max_requests_per_target}/target`} />
          </div>
          <div className="border-t border-[#1f2937] p-4">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input
                className="input"
                placeholder="http://target.example:8080/path"
                value={scopeUrl}
                onChange={e => setScopeUrl(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleScopeCheck() }}
              />
              <button
                onClick={handleScopeCheck}
                disabled={scopeChecking}
                className="flex items-center gap-1.5 px-3 py-2 bg-cyan-600 text-white text-xs rounded-lg hover:bg-cyan-500 disabled:opacity-50"
              >
                {scopeChecking ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                检查
              </button>
            </div>
            {scopeError && (
              <div className="mt-3 text-xs text-red-400 flex items-center gap-2">
                <XCircle size={14} /> {scopeError}
              </div>
            )}
            {scopeResult && (
              <div className={`mt-3 rounded-lg border px-3 py-3 text-xs ${scopeResult.allowed ? 'border-green-500/20 bg-green-500/10 text-green-300' : 'border-red-500/20 bg-red-500/10 text-red-300'}`}>
                <div className="flex items-center gap-2 font-medium">
                  {scopeResult.allowed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  {scopeResult.allowed ? '允许' : '拦截'} · {scopeResult.reason}
                </div>
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-gray-400">
                  <div>Host: <span className="text-gray-200">{scopeResult.host || '-'}</span></div>
                  <div>Port: <span className="text-gray-200">{scopeResult.port || '-'}</span></div>
                  <div>Rule: <span className="text-gray-200">{scopeResult.matched_rule || '-'}</span></div>
                  <div>Mode: <span className="text-gray-200">{scopeResult.competition_mode ? 'competition' : 'safe'}</span></div>
                  <div className="sm:col-span-2">Resolved: <span className="text-gray-200">{scopeResult.resolved_ip_summary.join(', ') || '-'}</span></div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Config */}
      <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden mb-5">
        <div className="px-5 py-3 border-b border-[#1f2937] font-medium text-white text-sm">环境配置</div>
        <div className="divide-y divide-[#1f2937]">
          {CONFIG_ITEMS.map(item => (
            <div key={item.key} className="flex items-center justify-between px-5 py-3">
              <div>
                <div className="text-sm font-mono text-cyan-400">{item.key}</div>
                <div className="text-xs text-gray-500">{item.desc}</div>
              </div>
              <div className="text-sm text-gray-300 font-mono">{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Links */}
      <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-[#1f2937] font-medium text-white text-sm">快速链接</div>
        <div className="divide-y divide-[#1f2937]">
          <a href="/docs" target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-between px-5 py-3 hover:bg-[#1f2937]/50 group">
            <span className="text-sm text-gray-300">API 文档 (Swagger UI)</span>
            <ExternalLink size={14} className="text-gray-500 group-hover:text-cyan-400" />
          </a>
          <a href="/api/health" target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-between px-5 py-3 hover:bg-[#1f2937]/50 group">
            <span className="text-sm text-gray-300">健康检查接口</span>
            <ExternalLink size={14} className="text-gray-500 group-hover:text-cyan-400" />
          </a>
          <a href="/api/llm/status" target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-between px-5 py-3 hover:bg-[#1f2937]/50 group">
            <span className="text-sm text-gray-300">LLM 状态接口</span>
            <ExternalLink size={14} className="text-gray-500 group-hover:text-cyan-400" />
          </a>
        </div>
      </div>

      <div className="mt-6 text-xs text-gray-600 text-center">
        本平台仅用于授权安全测试，禁止用于非法用途
      </div>
    </div>
  )
}

function LLMRow({ k, v, highlight, warn }: { k: string; v: string; highlight?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <div className="text-xs text-gray-500">{k}</div>
      <div className={`text-xs font-mono ${highlight ? 'text-green-400' : warn ? 'text-yellow-400' : 'text-gray-300'}`}>{v}</div>
    </div>
  )
}

function SettingField({
  label,
  current,
  edited,
  onChange,
  type = 'text',
  step,
  sensitive,
  placeholder,
  warn,
}: {
  label: string
  current: string | number | boolean
  edited?: string | number | boolean
  onChange: (v: string | boolean) => void
  type?: 'text' | 'number' | 'password' | 'bool'
  step?: string
  sensitive?: boolean
  placeholder?: string
  warn?: boolean
}) {
  const isDirty = edited !== undefined && edited !== ''
  const displayValue = isDirty ? String(edited) : ''
  // 当前值的脱敏显示
  const currentDisplay = sensitive
    ? (typeof current === 'string' && current.includes('configured') ? current : '(not configured)')
    : String(current)

  if (type === 'bool') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-gray-500 flex items-center justify-between">
          <span>{label}</span>
          {warn && <span className="text-red-400 text-[9px]">⚠ 危险</span>}
        </label>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onChange(true)}
            className={`px-2 py-1 text-[10px] rounded ${(!isDirty && current === true) || edited === true ? 'bg-green-500/30 text-green-200 border border-green-500/40' : 'bg-gray-700/50 text-gray-400 border border-gray-700'}`}
          >ON</button>
          <button
            type="button"
            onClick={() => onChange(false)}
            className={`px-2 py-1 text-[10px] rounded ${(isDirty && edited === false) || (!isDirty && current === false) ? 'bg-red-500/30 text-red-200 border border-red-500/40' : 'bg-gray-700/50 text-gray-400 border border-gray-700'}`}
          >OFF</button>
          {!isDirty && <span className="text-[9px] text-gray-600 ml-1">当前: {currentDisplay}</span>}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-gray-500 flex items-center justify-between">
        <span>{label}</span>
        {!isDirty && <span className="text-[9px] text-gray-600 truncate max-w-[120px]" title={currentDisplay}>{currentDisplay}</span>}
      </label>
      <input
        type={type}
        step={step}
        value={displayValue}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || (isDirty ? '' : `当前: ${currentDisplay}`)}
        className={`px-2 py-1 bg-black/40 border rounded text-gray-200 placeholder-gray-600 text-[11px] focus:outline-none ${isDirty ? 'border-amber-500/60 bg-amber-500/5' : 'border-gray-700'}`}
      />
    </div>
  )
}
