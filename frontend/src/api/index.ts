import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

export default api

// Types
export interface Task {
  id: number
  title: string
  description: string
  task_type: string
  target: string
  status: string
  uploaded_file: string
  intent_result?: string
  report_status?: string
  created_at: string
  updated_at: string
  // Round 2
  plan_source?: string
  llm_enabled?: boolean
  llm_model?: string
}

export interface Step {
  id: number
  task_id: number
  step_index: number
  phase: string
  action: string
  reason: string
  tool_name: string
  input_summary: string
  output_summary: string
  next_decision: string
  status: string
  created_at: string
  // Round 2
  plan_source?: string
  risk_level?: string
  confidence?: number
  requires_confirmation?: boolean
  decision_trace?: string
}

export interface Report {
  id: number
  task_id: number
  content: string
  file_path: string
  created_at: string
}

export interface Tool {
  name: string
  description: string
  category: string
  enabled: boolean
  input_schema: string
  output_schema: string
  permissions: string
  risk_level: string
  timeout_seconds: number
  tags: string
}

export interface LLMStatus {
  enabled: boolean
  provider: string
  base_url: string
  base_url_host?: string
  api_key_configured: boolean
  model: string
  timeout?: number
  max_retries?: number
  last_success?: number | null
  last_error?: string
}

export interface LLMTestResult {
  success: boolean
  message: string
  model: string
  usage?: Record<string, number>
  attempts?: number
}

export interface HealthStatus {
  status: string
  app: string
  version: string
  database: string
  enabled_tools_count: number
  storage: Record<string, string>
  llm_enabled: boolean
  scope_config_summary: {
    competition_mode: boolean
    configured: boolean
    cidrs: string[]
    domains: string[]
    ports: number[]
    allow_localhost: boolean
    allow_private_ips: boolean
    max_requests_per_task: number
    max_requests_per_target: number
    default_http_timeout: number
  }
  llm: {
    enabled: boolean
    provider: string
    model: string
    base_url_host: string
    api_key_configured: boolean
  }
}

export interface Evidence {
  id: number
  evidence_uid: string
  source_tool: string
  task_id?: number
  challenge_id?: number
  input_summary: string
  output_excerpt: string
  content_hash: string
  reproduction_hint: string
  created_at: string
}

export interface AnswerCandidate {
  id: number
  challenge_id?: number
  task_id?: number
  candidate: string
  source: string
  evidence: string
  evidence_id: string
  confidence: number
  why_selected: string
  validation_status: string
  note: string
  created_at: string
  updated_at: string
}

export interface SubmitChallengePayload {
  answer: string
  submitter: string
  submission_note?: string
  candidate_id?: number
  submit_status?: 'ready_to_submit' | 'submitted' | 'accepted' | 'rejected'
}

export interface ScopeCheckResult {
  allowed: boolean
  reason: string
  matched_rule: string
  normalized_target: string
  resolved_ip_summary: string[]
  host: string
  port?: number
  competition_mode: boolean
}

export interface FinalOpsDebrief {
  markdown: string
  total_challenges: number
  solved: string[]
  unsolved: string[]
  by_status: Record<string, number>
  by_type: Record<string, number>
  submitted_count: number
  accepted_count: number
  rejected_count: number
  average_time_to_submit_seconds: number
  average_time_to_accepted_seconds: number
}

export interface Challenge {
  id: number
  name: string
  challenge_type: string
  description: string
  target: string
  uploaded_file: string
  tags: string[]
  priority: string
  status: string
  assignee: string
  reviewer: string
  submitter: string
  submit_status: string
  submitted_answer: string
  submitted_at?: string
  submission_note: string
  notes: string
  latest_summary: string
  next_suggestion: string
  confidence: string
  runbook: Record<string, any>
  task_ids: number[]
  evidence: Evidence[]
  answer_candidates: AnswerCandidate[]
  created_at: string
  updated_at: string
}

// API functions
export const getTasks = () => api.get<Task[]>('/tasks')
export const getTask = (id: number) => api.get<Task>(`/tasks/${id}`)
export const createTask = (data: Partial<Task>) => api.post<Task>('/tasks', data)
export const runTask = (id: number) => api.post(`/tasks/${id}/run`)
export const getSteps = (id: number) => api.get<Step[]>(`/tasks/${id}/steps`)
export const getReport = (id: number) => api.get<Report>(`/tasks/${id}/report`)
export const getTools = () => api.get<Tool[]>('/tools')
export const setToolEnabled = (name: string, enabled: boolean) => api.patch(`/tools/${name}/enabled`, { enabled })
export const confirmStep = (id: number) => api.post(`/tasks/${id}/confirm-step`)
export const denyStep = (id: number) => api.post(`/tasks/${id}/deny-step`)
export const cancelTask = (id: number) => api.post(`/tasks/${id}/cancel`)
export const pauseTask = (id: number) => api.post(`/tasks/${id}/pause`)
export const resumeTask = (id: number) => api.post(`/tasks/${id}/resume`)
export const addTaskManualResult = (id: number, data: { author?: string; result: string }) => api.post(`/tasks/${id}/manual-result`, data)
export const uploadFile = (file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  return api.post('/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}
// Round 2: LLM
export const getLLMStatus = () => api.get<LLMStatus>('/llm/status')
export const testLLM = () => api.post<LLMTestResult>('/llm/test')
export const getHealth = () => api.get<HealthStatus>('/health')

// Final Ops
export const getChallenges = (params?: Record<string, string>) => api.get<Challenge[]>('/challenges', { params })
export const getChallenge = (id: number) => api.get<Challenge>(`/challenges/${id}`)
export const createChallenge = (data: Partial<Challenge>) => api.post<Challenge>('/challenges', data)
export const patchChallenge = (id: number, data: Partial<Challenge>) => api.patch<Challenge>(`/challenges/${id}`, data)
export const importChallenges = (data: { format: string; content: string; default_assignee?: string }) => api.post('/challenges/import', data)
export const runChallengeTriage = (id: number) => api.post<Challenge>(`/challenges/${id}/run-triage`)
export const addChallengeNote = (id: number, data: { author?: string; note: string; note_type?: string }) => api.post<Challenge>(`/challenges/${id}/add-note`, data)
export const addChallengeManualResult = (id: number, data: { author?: string; result: string; validation_status?: string; candidate?: string }) => api.post<Challenge>(`/challenges/${id}/manual-result`, data)
export const addAnswerCandidate = (id: number, data: Partial<AnswerCandidate>) => api.post<AnswerCandidate>(`/challenges/${id}/answer-candidate`, data)
export const patchAnswerCandidate = (id: number, data: Partial<AnswerCandidate>) => api.patch<AnswerCandidate>(`/answer-candidates/${id}`, data)
export const getChallengeBrief = (id: number) => api.get<{ markdown: string; answer_candidates: string[]; evidence_ids: string[] }>(`/challenges/${id}/brief`)
export const submitChallenge = (id: number, data: SubmitChallengePayload) => api.post<Challenge>(`/challenges/${id}/submit`, data)
export const scopeCheck = (url: string) => api.post<ScopeCheckResult>('/scope/check', { url })
export const getFinalOpsDebrief = () => api.get<FinalOpsDebrief>('/final-ops/debrief')
export const exportFinalOps = () => api.get('/final-ops/export')
export const importFinalOpsBackup = (data: Record<string, any>) => api.post('/final-ops/import', { data })

// ============== 烛龙·玄枢 CTF API ==============

export interface CtfTask {
  task_id: string
  title: string
  description: string
  category_hint: string
  flag_format?: string | null
  authorized: boolean
  allow_network: boolean
  max_rounds: number
  max_time_sec: number
  shell_history: Array<{
    command: string
    exit_code: number | null
    stdout: string
    stderr: string
    duration_ms: number
  }>
  attachments: string[]
  state: string
  rounds_used: number
  is_running?: boolean
  source?: string
  demo_id?: string | null
  plan?: {
    category: string
    confidence: number
    initial_guess: string
    script_plan: string[]
    risks: string[]
    fallback: string
  } | null
  analysis?: Record<string, any> | null
  current_script: string
  script_runs: Array<{
    success: boolean
    exit_code: number
    stdout: string
    stderr: string
    duration_ms: number
    timed_out: boolean
    workdir: string
    error?: string | null
    run_index?: number
  }>
  evidence: Array<{
    step: string
    timestamp: number
    duration_ms: number
    input_summary: string
    output_summary: string
    success: boolean
    artifacts: Record<string, any>
  }>
  candidate_flags: Array<{ flag: string; source: string; confidence: number }>
  best_flag?: string | null
  has_writeup: boolean
  writeup_md?: string
  error: string
  created_at: number
  updated_at: number
}

export interface CtfDemo {
  id: string
  title: string
  category: string
  difficulty: string
  description: string
  flag_format?: string | null
  has_attachment: boolean
  needs_llm?: boolean
  est_time_sec?: number
  path: string
}

export interface CtfBenchmark {
  total: number
  solved: number
  success_rate: number
  avg_duration_ms: number
  category_breakdown: Record<string, { total: number; solved: number }>
  category_success_rate: Record<string, number>
  human_takeover: number
  tool_calls_total: number
}

export const ctfListTasks = () => api.get<CtfTask[]>('/ctf/tasks')
export const ctfGetTask = (taskId: string) => api.get<CtfTask>(`/ctf/tasks/${taskId}`)
export const ctfCreateTask = (data: {
  title: string
  description: string
  category?: string
  flag_format?: string | null
  authorized?: boolean
  allow_network?: boolean
  max_rounds?: number
  max_time_sec?: number
}) => api.post<{ task_id: string; state: string }>('/ctf/tasks', data)
export const ctfUploadAttachment = (taskId: string, file: File) => {
  const formData = new FormData()
  formData.append('file', file)
  return api.post(`/ctf/tasks/${taskId}/attachments`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}
export const ctfSolveTask = (taskId: string, payload: { mode?: string; max_rounds?: number; max_time_sec?: number }) =>
  api.post<CtfTask>(`/ctf/tasks/${taskId}/solve`, payload)
export const ctfGetEvents = (taskId: string) =>
  api.get<{
    task_id: string
    state: string
    events: CtfTask['evidence']
    script_runs: CtfTask['script_runs']
    candidate_flags: CtfTask['candidate_flags']
  }>(`/ctf/tasks/${taskId}/events`)
export const ctfGetWriteup = (taskId: string) =>
  api.get<string>(`/ctf/tasks/${taskId}/writeup`, { responseType: 'text' as const })
export const ctfListDemos = () => api.get<CtfDemo[]>('/ctf/demos')
export const ctfRunDemo = (demoId: string, maxRounds = 0, maxTimeSec = 600) =>
  api.post<CtfTask & { expected_flag?: string | null; match?: boolean | null }>(
    `/ctf/demos/${demoId}/run?max_rounds=${maxRounds}&max_time_sec=${maxTimeSec}`
  )
export const ctfBenchmark = () => api.get<CtfBenchmark>('/ctf/benchmark')

// LLM 模式查询
export interface LlmStatus {
  mode: 'mock' | 'live' | 'disabled'
  provider: string
  model: string
  base_url_host: string
  api_key_configured: boolean
  enabled: boolean
}
export const ctfLlmStatus = () => api.get<LlmStatus>('/ctf/llm/status')

// ============== v6: Blackboard / Cost / Router ==============

export interface BlackboardFact {
  fact_id: string
  task_id: string
  kind: string // file|clue|candidate|error|tool_result|constraint
  content: string
  confidence: number
  source_step: string
  evidence_ref?: string | null
  created_at: number
}

export interface BlackboardIntent {
  intent_id: string
  task_id: string
  title: string
  rationale: string
  status: string // pending|in_progress|completed|failed|deprecated
  priority: number
  depends_on: string[]
  result_fact_ids: string[]
  created_at: number
  updated_at: number
}

export interface BlackboardHint {
  hint_id: string
  task_id: string
  content: string
  source: string // human|observer|system
  consumed: boolean
  created_at: number
}

export interface BlackboardSnapshot {
  task_id: string
  facts: BlackboardFact[]
  intents: BlackboardIntent[]
  hints: BlackboardHint[]
  fact_count: number
  candidate_count: number
}

export interface TaskCostSummary {
  task_id: string
  total_calls: number
  successful_calls: number
  failed_calls: number
  cheap_calls: number
  expert_calls: number
  fallback_calls: number
  static_only_calls: number
  total_input_tokens: number
  total_output_tokens: number
  total_cost_usd: number
  budget_per_task_usd: number
  budget_exceeded: boolean
  cache_hits: number
  by_step: Record<string, number>
  by_model: Record<string, number>
}

export interface RouterStatus {
  router_enabled: boolean
  budget_per_task_usd: number
  budget_daily_usd: number
  compress_threshold_chars: number
  cheap: {
    provider: string
    model: string
    base_url_host: string
    api_key_configured: boolean
    max_tokens: number
  }
  expert: {
    provider: string
    model: string
    base_url_host: string
    api_key_configured: boolean
    max_tokens: number
  }
  fallback: {
    provider: string
    model: string
    base_url_host: string
    api_key_configured: boolean
  }
  daily_total_cost_usd: number
}

export const ctfGetBlackboard = (taskId: string) =>
  api.get<BlackboardSnapshot>(`/ctf/tasks/${taskId}/blackboard`)
export const ctfAddHint = (taskId: string, data: { content: string; source?: string }) =>
  api.post<BlackboardHint>(`/ctf/tasks/${taskId}/hints`, data)
export const ctfUpdateIntent = (taskId: string, intentId: string, data: Partial<{
  status: string
  title: string
  rationale: string
  priority: number
  result_fact_ids: string[]
}>) => api.patch<BlackboardIntent>(`/ctf/tasks/${taskId}/intents/${intentId}`, data)
export const ctfGetTaskCost = (taskId: string) =>
  api.get<TaskCostSummary>(`/ctf/tasks/${taskId}/cost`)
export const ctfStopTask = (taskId: string) =>
  api.post<{ task_id: string; state: string; note: string }>(`/ctf/tasks/${taskId}/stop`)

export const ctfGetRouterStatus = () =>
  api.get<RouterStatus>('/ctf/llm/router/status')

// ============== v6.1: Runtime Settings API ==============

export interface LlmSettingsSnapshot {
  router: Record<string, string | number | boolean>
  global: Record<string, string | number | boolean>
  cheap: Record<string, string | number | boolean>
  expert: Record<string, string | number | boolean>
  fallback: Record<string, string | number | boolean>
}

export interface LlmSettingsUpdate {
  // 主配置（前端简化版只暴露这几个）
  LLM_ENABLED?: boolean
  LLM_PROVIDER?: string
  LLM_BASE_URL?: string
  LLM_MODEL?: string
  LLM_API_KEY?: string
  // Router（高级，前端不默认暴露）
  LLM_ROUTER_ENABLED?: boolean
  LLM_BUDGET_PER_TASK_USD?: number
  LLM_BUDGET_DAILY_USD?: number
  LLM_COMPRESS_THRESHOLD_CHARS?: number
  // Cheap lane（高级）
  LLM_CHEAP_PROVIDER?: string
  LLM_CHEAP_BASE_URL?: string
  LLM_CHEAP_MODEL?: string
  LLM_CHEAP_API_KEY?: string
  LLM_CHEAP_MAX_TOKENS?: number
  LLM_CHEAP_TEMPERATURE?: number
  // Expert lane（高级）
  LLM_EXPERT_PROVIDER?: string
  LLM_EXPERT_BASE_URL?: string
  LLM_EXPERT_MODEL?: string
  LLM_EXPERT_API_KEY?: string
  LLM_EXPERT_MAX_TOKENS?: number
  LLM_EXPERT_TEMPERATURE?: number
  // Fallback lane（高级）
  LLM_FALLBACK_PROVIDER?: string
  LLM_FALLBACK_BASE_URL?: string
  LLM_FALLBACK_MODEL?: string
  LLM_FALLBACK_API_KEY?: string
}

export interface LlmSettingsUpdateResult {
  ok: boolean
  applied: Record<string, string>
  skipped: string[]
  note: string
}

export interface AuditEntry {
  ts: number
  actor: string
  field: string
  old: string
  new: string
}

export const getLlmSettings = () => api.get<LlmSettingsSnapshot>('/settings/llm')
export const updateLlmSettings = (data: LlmSettingsUpdate, confirmDangerous = false) =>
  api.put<LlmSettingsUpdateResult>('/settings/llm', data, {
    headers: confirmDangerous ? { 'X-Confirm-Dangerous': 'yes' } : {},
  })
export const getSettingsAudit = (limit = 50) =>
  api.get<{ entries: AuditEntry[] }>(`/settings/audit?limit=${limit}`)
export const resetRuntimeConfig = () =>
  api.post('/settings/reset', {}, { headers: { 'X-Confirm-Dangerous': 'yes' } })

// 全局错误处理：网络断开时给统一提示
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (!error.response) {
      // 网络错误
      console.error('[ZHULONG-X] 网络错误，后端可能未启动:', error.message)
    }
    return Promise.reject(error)
  }
)
