import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  Check, Clipboard, Copy, Download, FileText, Filter, Loader2, Play, Plus,
  RefreshCw, Search, ShieldCheck, Upload, UserRound, XCircle,
} from 'lucide-react'
import {
  addAnswerCandidate,
  addChallengeManualResult,
  addChallengeNote,
  Challenge,
  createChallenge,
  exportFinalOps,
  getChallengeBrief,
  getChallenges,
  getFinalOpsDebrief,
  getHealth,
  HealthStatus,
  importChallenges,
  importFinalOpsBackup,
  patchChallenge,
  runChallengeTriage,
  submitChallenge,
} from '../api'

const TYPES = ['web', 'code', 'log', 'pcap', 'reverse', 'crypto', 'misc', 'unknown']
const STATUSES = ['new', 'triaging', 'running', 'need_human', 'candidate_found', 'submitted', 'solved', 'blocked', 'paused', 'cancelled']
const FILTER_KEY = 'cyberpilot.finalops.filters.v1'
const MAX_VISIBLE = 60

const STATUS_STYLE: Record<string, string> = {
  new: 'text-gray-300 bg-gray-500/10',
  triaging: 'text-blue-300 bg-blue-500/10',
  running: 'text-yellow-300 bg-yellow-500/10',
  need_human: 'text-orange-300 bg-orange-500/10',
  candidate_found: 'text-cyan-300 bg-cyan-500/10',
  submitted: 'text-purple-300 bg-purple-500/10',
  solved: 'text-green-300 bg-green-500/10',
  blocked: 'text-red-300 bg-red-500/10',
  paused: 'text-amber-300 bg-amber-500/10',
  cancelled: 'text-gray-400 bg-gray-600/10',
}

function readFilters() {
  try {
    return JSON.parse(window.localStorage.getItem(FILTER_KEY) || '{}')
  } catch {
    return {}
  }
}

function badge(text: string, cls = 'text-gray-300 bg-[#1f2937]') {
  return <span className={`px-2 py-1 rounded text-xs font-medium ${cls}`}>{text}</span>
}

function bestCandidate(challenge: Challenge) {
  return [...(challenge.answer_candidates || [])].sort((a, b) => b.confidence - a.confidence)[0]
}

function copy(text: string) {
  navigator.clipboard.writeText(text || '')
}

function timestampName() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export default function FinalOps() {
  const savedFilters = useMemo(() => readFilters(), [])
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [challenges, setChallenges] = useState<Challenge[]>([])
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [statusFilter, setStatusFilter] = useState(savedFilters.statusFilter || '')
  const [typeFilter, setTypeFilter] = useState(savedFilters.typeFilter || '')
  const [assigneeFilter, setAssigneeFilter] = useState(savedFilters.assigneeFilter || '')
  const [query, setQuery] = useState(savedFilters.query || '')
  const [newForm, setNewForm] = useState({ name: '', challenge_type: 'web', target: '', assignee: '', priority: 'medium', description: '' })
  const [importText, setImportText] = useState('')
  const [manual, setManual] = useState<Record<number, string>>({})
  const [ctfCasePath, setCtfCasePath] = useState('ctf_cases/case01')

  const load = async () => {
    setError('')
    try {
      const [c, h] = await Promise.all([getChallenges(), getHealth()])
      setChallenges(c.data)
      setHealth(h.data)
    } catch (e: any) {
      setError(e?.response?.data?.detail || '加载 FinalOps 数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    window.localStorage.setItem(FILTER_KEY, JSON.stringify({ statusFilter, typeFilter, assigneeFilter, query }))
  }, [statusFilter, typeFilter, assigneeFilter, query])

  const visible = useMemo(() => challenges.filter(item => {
    if (statusFilter && item.status !== statusFilter) return false
    if (typeFilter && item.challenge_type !== typeFilter) return false
    if (assigneeFilter && item.assignee !== assigneeFilter) return false
    if (query) {
      const hay = `${item.name} ${item.description} ${item.target} ${item.tags.join(' ')} ${item.latest_summary}`.toLowerCase()
      if (!hay.includes(query.toLowerCase())) return false
    }
    return true
  }), [challenges, statusFilter, typeFilter, assigneeFilter, query])

  const visibleLimited = visible.slice(0, MAX_VISIBLE)
  const assignees = Array.from(new Set(challenges.map(c => c.assignee).filter(Boolean))).sort()
  const running = challenges.filter(c => ['triaging', 'running'].includes(c.status)).length
  const candidateCount = challenges.reduce((sum, c) => sum + c.answer_candidates.length, 0)
  const solved = challenges.filter(c => c.status === 'solved').length
  const submitted = challenges.filter(c => ['submitted', 'accepted', 'rejected'].includes(c.submit_status)).length

  const showNotice = (message: string) => {
    setNotice(message)
    setError('')
  }

  const create = async () => {
    if (!newForm.name.trim()) return
    await createChallenge({ ...newForm, tags: [] })
    setNewForm({ name: '', challenge_type: 'web', target: '', assignee: '', priority: 'medium', description: '' })
    showNotice('Challenge 已创建')
    await load()
  }

  const importJson = async () => {
    if (!importText.trim()) return
    const format = importText.trim().startsWith('{') || importText.trim().startsWith('[') ? 'json' : importText.includes(',') && importText.includes('\n') ? 'csv' : 'markdown'
    const r = await importChallenges({ format, content: importText })
    setImportText('')
    showNotice(`批量导入完成: ${r.data.created || 0} 个`)
    await load()
  }

  const exportBackup = async () => {
    try {
      const r = await exportFinalOps()
      const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cyberpilot-finalops-backup-${timestampName()}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showNotice(`已导出 ${r.data.challenges?.length || 0} 个 Challenge 的备份 JSON`)
    } catch (e: any) {
      setError(e?.response?.data?.detail || '导出备份失败')
    }
  }

  const importBackupFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const r = await importFinalOpsBackup(data)
      showNotice(`备份导入完成: 新增 ${r.data.imported_challenges || 0} 个，总计 ${r.data.total_challenges || 0} 个`)
      await load()
    } catch (e: any) {
      setError(e?.response?.data?.detail || '导入备份失败，请确认 JSON 来自 FinalOps 导出')
    } finally {
      event.target.value = ''
    }
  }

  const runTriage = async (id: number) => {
    setRunningId(id)
    try {
      const r = await runChallengeTriage(id)
      setChallenges(prev => prev.map(c => c.id === id ? r.data : c))
      showNotice('Triage 完成，已更新证据和候选答案')
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Run Triage 失败')
    } finally {
      setRunningId(null)
    }
  }

  const mark = async (challenge: Challenge, status: string) => {
    const r = await patchChallenge(challenge.id, { status })
    setChallenges(prev => prev.map(c => c.id === challenge.id ? r.data : c))
    showNotice(`${challenge.name} 已标记为 ${status}`)
  }

  const submit = async (challenge: Challenge, submitStatus: 'submitted' | 'accepted' | 'rejected') => {
    const candidate = bestCandidate(challenge)
    const defaultAnswer = challenge.submitted_answer || candidate?.candidate || ''
    if (!defaultAnswer) {
      setError('没有候选答案，先人工回填或添加 Candidate')
      return
    }
    const answer = window.prompt(`提交前确认答案 (${submitStatus})`, defaultAnswer)
    if (answer === null || !answer.trim()) return
    const submitter = window.prompt('提交人', challenge.submitter || challenge.assignee || 'team')
    if (submitter === null || !submitter.trim()) return
    const note = window.prompt('提交备注', submitStatus === 'submitted' ? '已在平台提交前人工确认' : `平台返回 ${submitStatus}`)
    if (note === null) return
    const r = await submitChallenge(challenge.id, {
      answer,
      submitter,
      submission_note: note,
      candidate_id: candidate?.id,
      submit_status: submitStatus,
    })
    setChallenges(prev => prev.map(c => c.id === challenge.id ? r.data : c))
    showNotice(`${challenge.name} 提交流程已记录为 ${submitStatus}`)
  }

  const addManual = async (challenge: Challenge) => {
    const value = manual[challenge.id]?.trim()
    if (!value) return
    const r = await addChallengeManualResult(challenge.id, { author: challenge.assignee || 'team', result: value })
    setManual(prev => ({ ...prev, [challenge.id]: '' }))
    setChallenges(prev => prev.map(c => c.id === challenge.id ? r.data : c))
    showNotice('人工回填已保存')
  }

  const copyBrief = async (challenge: Challenge) => {
    const r = await getChallengeBrief(challenge.id)
    copy(r.data.markdown)
    showNotice('Brief 已复制')
  }

  const copyDebrief = async () => {
    const r = await getFinalOpsDebrief()
    copy(r.data.markdown)
    showNotice(`Debrief 已复制: submitted=${r.data.submitted_count}, accepted=${r.data.accepted_count}`)
  }

  const copyCtfCommand = (mode: 'solve' | 'eval' | 'both') => {
    const target = ctfCasePath.trim() || 'ctf_cases/case01'
    const command = mode === 'solve'
      ? `make solve-ctf CASE=${target}`
      : mode === 'eval'
        ? `make evaluate-ctf CASE=${target}`
        : `make solve-and-eval-ctf CASE=${target}`
    copy(command)
    showNotice(`已复制: ${command}`)
  }

  return (
    <div className="p-6 xl:p-8">
      <div className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-bold text-white">FinalOps v4 作战台</h1>
          <p className="text-gray-400 text-sm mt-1">题目、队员、证据、候选答案、提交记录和备份恢复</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={importBackupFile} />
          <button onClick={load} className="btn-dark">
            <RefreshCw size={14} /> 刷新
          </button>
          <button onClick={copyDebrief} className="btn-dark">
            <Clipboard size={14} /> Debrief
          </button>
          <button onClick={exportBackup} className="btn-dark">
            <Download size={14} /> 导出备份
          </button>
          <button onClick={() => fileInputRef.current?.click()} className="btn-dark">
            <Upload size={14} /> 导入备份
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
          <XCircle size={15} /> {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-center justify-between gap-2 text-sm text-cyan-200 bg-cyan-500/10 border border-cyan-500/20 rounded-lg px-3 py-2">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} className="text-cyan-300 hover:text-white" title="关闭">x</button>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-5">
        <TopStat label="Competition" value={health?.scope_config_summary?.competition_mode ? 'ON' : 'OFF'} tone={health?.scope_config_summary?.competition_mode ? 'text-green-300' : 'text-gray-300'} />
        <TopStat label="Scope" value={health?.scope_config_summary?.configured ? 'CONFIGURED' : 'EMPTY'} tone={health?.scope_config_summary?.configured ? 'text-cyan-300' : 'text-yellow-300'} />
        <TopStat label="LLM" value={health?.llm?.enabled ? health.llm.model : 'RULE'} tone={health?.llm?.enabled ? 'text-purple-300' : 'text-cyan-300'} />
        <TopStat label="Running" value={String(running)} tone="text-yellow-300" />
        <TopStat label="Submitted" value={String(submitted)} tone="text-purple-300" />
        <TopStat label="Candidates" value={`${candidateCount} / Solved ${solved}`} tone="text-green-300" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-5">
        <aside className="space-y-4">
          <div className="bg-[#111827] border border-[#1f2937] rounded-lg p-4">
            <div className="flex items-center gap-2 text-white font-medium text-sm mb-3"><Plus size={15} /> 新建 Challenge</div>
            <div className="space-y-2">
              <input className="input" placeholder="题目名称" value={newForm.name} onChange={e => setNewForm({ ...newForm, name: e.target.value })} />
              <div className="grid grid-cols-2 gap-2">
                <select className="input" value={newForm.challenge_type} onChange={e => setNewForm({ ...newForm, challenge_type: e.target.value })}>
                  {TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
                <select className="input" value={newForm.priority} onChange={e => setNewForm({ ...newForm, priority: e.target.value })}>
                  <option>high</option><option>medium</option><option>low</option>
                </select>
              </div>
              <input className="input" placeholder="目标 URL/IP" value={newForm.target} onChange={e => setNewForm({ ...newForm, target: e.target.value })} />
              <input className="input" placeholder="负责人" value={newForm.assignee} onChange={e => setNewForm({ ...newForm, assignee: e.target.value })} />
              <textarea className="input min-h-[86px]" placeholder="题目描述" value={newForm.description} onChange={e => setNewForm({ ...newForm, description: e.target.value })} />
              <button onClick={create} className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm font-medium text-white">
                <Plus size={14} /> 创建
              </button>
            </div>
          </div>

          <div className="bg-[#111827] border border-[#1f2937] rounded-lg p-4">
            <div className="flex items-center gap-2 text-white font-medium text-sm mb-3"><Upload size={15} /> 批量导入</div>
            <textarea
              className="input min-h-[150px] font-mono text-xs"
              placeholder='JSON/CSV/Markdown，例如 {"challenges":[{"name":"web1","type":"web"}]}'
              value={importText}
              onChange={e => setImportText(e.target.value)}
            />
            <button onClick={importJson} className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-[#1f2937] hover:bg-[#374151] rounded-lg text-sm font-medium text-gray-100">
              <Upload size={14} /> 导入题单
            </button>
          </div>

          <div className="bg-[#111827] border border-[#1f2937] rounded-lg p-4">
            <div className="flex items-center gap-2 text-white font-medium text-sm mb-3"><FileText size={15} /> Real CTF Case</div>
            <input className="input font-mono text-xs" value={ctfCasePath} onChange={e => setCtfCasePath(e.target.value)} placeholder="ctf_cases/case01" />
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <Info label="Blind Solve" value="ON" />
              <Info label="RAG Disabled" value="ON" />
              <Info label="History Disabled" value="ON" />
              <Info label="Search Disabled" value="ON" />
            </div>
            <div className="mt-2 text-xs text-gray-500 leading-relaxed">MCP/Skills Tool Calls 与 Denied Access Attempts 记录在 solve_trace.json。</div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <button onClick={() => copyCtfCommand('solve')} className="btn-subtle justify-center">Solve</button>
              <button onClick={() => copyCtfCommand('eval')} className="btn-subtle justify-center">Eval</button>
              <button onClick={() => copyCtfCommand('both')} className="btn-subtle justify-center">Both</button>
            </div>
            <div className="mt-2 text-xs text-gray-500 leading-relaxed">Evaluator 仅用于本地训练评估；比赛现场不要读取标准答案。</div>
          </div>

          <div className="bg-[#111827] border border-[#1f2937] rounded-lg p-4 text-xs text-gray-400 space-y-1.5">
            <div className="flex items-center gap-2 text-white font-medium text-sm mb-2"><ShieldCheck size={15} /> Scope</div>
            <div>Mode: <span className="text-gray-200">{health?.scope_config_summary?.competition_mode ? 'competition' : 'safe'}</span></div>
            <div>CIDR: <span className="text-gray-200">{health?.scope_config_summary?.cidrs?.join(', ') || '(empty)'}</span></div>
            <div>Domain: <span className="text-gray-200">{health?.scope_config_summary?.domains?.join(', ') || '(empty)'}</span></div>
            <div>Ports: <span className="text-gray-200">{health?.scope_config_summary?.ports?.join(', ') || 'any'}</span></div>
          </div>
        </aside>

        <section>
          <div className="bg-[#111827] border border-[#1f2937] rounded-lg p-3 mb-4">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_150px_150px_150px] gap-2">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-2.5 text-gray-500" />
                <input className="input pl-9" placeholder="搜索题名、目标、标签" value={query} onChange={e => setQuery(e.target.value)} />
              </div>
              <select className="input" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">全部状态</option>
                {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className="input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                <option value="">全部类型</option>
                {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select className="input" value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)}>
                <option value="">全部负责人</option>
                {assignees.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            {visible.length > MAX_VISIBLE && (
              <div className="text-xs text-yellow-300 mt-2">当前筛选命中 {visible.length} 个，仅展示前 {MAX_VISIBLE} 个；缩小筛选条件可继续查看。</div>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-gray-400"><Loader2 className="animate-spin" size={16} /> 加载中...</div>
          ) : visible.length === 0 ? (
            <div className="text-center text-gray-500 py-16 bg-[#111827] border border-[#1f2937] rounded-lg">
              <Filter size={34} className="mx-auto mb-3 opacity-40" /> 暂无匹配题目
            </div>
          ) : (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4">
              {visibleLimited.map(challenge => (
                <ChallengeCard
                  key={challenge.id}
                  challenge={challenge}
                  running={runningId === challenge.id}
                  manual={manual[challenge.id] || ''}
                  setManual={value => setManual(prev => ({ ...prev, [challenge.id]: value }))}
                  runTriage={() => runTriage(challenge.id)}
                  mark={status => mark(challenge, status)}
                  submit={status => submit(challenge, status)}
                  addManual={() => addManual(challenge)}
                  copyBrief={() => copyBrief(challenge)}
                  reload={load}
                  showNotice={showNotice}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function TopStat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-[#111827] border border-[#1f2937] rounded-lg p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-sm font-semibold truncate ${tone}`}>{value}</div>
    </div>
  )
}

function ChallengeCard({
  challenge, running, manual, setManual, runTriage, mark, submit, addManual, copyBrief, reload, showNotice,
}: {
  challenge: Challenge
  running: boolean
  manual: string
  setManual: (value: string) => void
  runTriage: () => void
  mark: (status: string) => void
  submit: (status: 'submitted' | 'accepted' | 'rejected') => void
  addManual: () => void
  copyBrief: () => void
  reload: () => void
  showNotice: (message: string) => void
}) {
  const candidate = bestCandidate(challenge)
  const evidenceText = (challenge.evidence || []).map(e => `${e.evidence_uid}: ${e.output_excerpt}`).join('\n\n')
  const triageLocked = running || ['triaging', 'running'].includes(challenge.status)

  const addCandidate = async () => {
    const value = window.prompt('答案候选')
    if (!value) return
    await addAnswerCandidate(challenge.id, { candidate: value, source: 'manual', confidence: 0.75, why_selected: '人工录入' })
    showNotice('人工候选已保存')
    await reload()
  }

  const addNote = async () => {
    const value = window.prompt('备注')
    if (!value) return
    await addChallengeNote(challenge.id, { author: challenge.assignee || 'team', note: value })
    showNotice('备注已保存')
    await reload()
  }

  return (
    <article className="bg-[#111827] border border-[#1f2937] rounded-lg overflow-hidden">
      <div className="p-4 border-b border-[#1f2937]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              {badge(challenge.challenge_type, 'text-cyan-300 bg-cyan-500/10')}
              {badge(challenge.status, STATUS_STYLE[challenge.status] || STATUS_STYLE.new)}
              {badge(challenge.submit_status || 'not_submitted', challenge.submit_status === 'accepted' ? 'text-green-300 bg-green-500/10' : challenge.submit_status === 'rejected' ? 'text-red-300 bg-red-500/10' : 'text-purple-300 bg-purple-500/10')}
              {badge(challenge.priority, challenge.priority === 'high' ? 'text-red-300 bg-red-500/10' : 'text-gray-300 bg-[#1f2937]')}
            </div>
            <h2 className="text-white font-semibold truncate">{challenge.name}</h2>
            <div className="text-xs text-gray-500 mt-1 truncate">{challenge.target || challenge.uploaded_file || '题面/附件'}</div>
          </div>
          <div className="text-right text-xs text-gray-500 shrink-0">
            <div className="flex items-center justify-end gap-1 text-gray-300"><UserRound size={12} /> {challenge.assignee || '未分配'}</div>
            <div className="mt-1">{new Date(challenge.updated_at).toLocaleString('zh-CN')}</div>
          </div>
        </div>
      </div>

      <div className="p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <Info label="Tasks" value={challenge.task_ids.join(', ') || 'none'} />
          <Info label="Evidence" value={String(challenge.evidence.length)} />
          <Info label="Reviewer" value={challenge.reviewer || 'none'} />
          <Info label="Submitter" value={challenge.submitter || 'none'} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs border border-[#1f2937] rounded-lg p-3 bg-[#0b1220]">
          <Info label="Blind Solve Mode" value="ON" />
          <Info label="RAG Disabled" value="ON" />
          <Info label="Historical Matching Disabled" value="ON" />
          <Info label="MCP/Skills Tool Calls" value="trace ledger" />
          <Info label="Denied Access Attempts" value="trace log" />
        </div>

        {candidate ? (
          <div className="border border-cyan-500/20 rounded-lg p-3 bg-cyan-500/5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-cyan-300">最高置信候选 · {(candidate.confidence * 100).toFixed(0)}% · {candidate.validation_status}</div>
              <button onClick={() => { copy(candidate.candidate); showNotice('候选答案已复制') }} className="p-1 text-gray-400 hover:text-cyan-300" title="复制答案候选">
                <Copy size={14} />
              </button>
            </div>
            <div className="font-mono text-sm text-white mt-1 break-all">{candidate.candidate}</div>
          </div>
        ) : (
          <div className="text-xs text-gray-500 border border-[#1f2937] rounded-lg p-3">暂无答案候选</div>
        )}

        {challenge.submitted_answer && (
          <div className="border border-purple-500/20 rounded-lg p-3 bg-purple-500/5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-purple-300">提交记录 · {challenge.submit_status}</span>
              <button onClick={() => { copy(challenge.submitted_answer); showNotice('提交答案已复制') }} className="text-gray-400 hover:text-purple-300" title="复制提交答案">
                <Copy size={13} />
              </button>
            </div>
            <div className="font-mono text-gray-100 break-all mt-1">{challenge.submitted_answer}</div>
            <div className="text-gray-500 mt-1">{challenge.submitted_at ? new Date(challenge.submitted_at).toLocaleString('zh-CN') : ''} {challenge.submission_note}</div>
          </div>
        )}

        <div className="text-xs text-gray-400 leading-relaxed line-clamp-2">{challenge.latest_summary || challenge.description || '等待分诊'}</div>
        <div className="text-xs text-gray-500 leading-relaxed line-clamp-2">{challenge.next_suggestion || challenge.runbook?.strategy || '等待下一步建议'}</div>

        <div className="flex flex-wrap gap-2">
          <button onClick={runTriage} disabled={triageLocked} className="btn-primary">
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Triage
          </button>
          <button onClick={addNote} className="btn-dark">Note</button>
          <button onClick={addCandidate} className="btn-dark">Candidate</button>
          <button onClick={() => submit('submitted')} className="btn-dark">Submit</button>
          <button onClick={() => submit('accepted')} className="btn-dark text-green-300">Accepted</button>
          <button onClick={() => submit('rejected')} className="btn-dark text-red-300">Rejected</button>
          <button onClick={() => mark('blocked')} className="btn-dark">Blocked</button>
          <button onClick={() => mark('solved')} className="btn-dark">Solved</button>
          <button onClick={copyBrief} className="btn-dark"><FileText size={13} /> Brief</button>
          {challenge.task_ids[0] && (
            <Link to={`/tasks/${challenge.task_ids[0]}/report`} className="btn-dark">Report</Link>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={() => { copy(evidenceText); showNotice('证据摘要已复制') }} className="btn-subtle"><Copy size={12} /> 复制证据</button>
          <button onClick={() => mark('paused')} className="btn-subtle">暂停</button>
          <button onClick={() => mark('need_human')} className="btn-subtle">需人工</button>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2 pt-2 border-t border-[#1f2937]">
          <input className="input" placeholder="人工回填：页面返回、截图说明、提交结果" value={manual} onChange={e => setManual(e.target.value)} />
          <button onClick={addManual} className="px-3 py-2 bg-[#1f2937] rounded-lg text-gray-100 hover:bg-[#374151]" title="回填人工结果">
            <Check size={15} />
          </button>
        </div>
      </div>
    </article>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-gray-600">{label}</div>
      <div className="text-gray-300 truncate">{value}</div>
    </div>
  )
}
