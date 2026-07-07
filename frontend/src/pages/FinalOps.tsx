import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  Check, Clipboard, Copy, Download, FileText, Filter, Loader2, Play, Plus,
  RefreshCw, Search, ShieldCheck, Upload, UserRound, XCircle, Zap,
  Shield, Target, Flame, Eye, Crosshair,
} from 'lucide-react'
import {
  addAnswerCandidate,
  addChallengeManualResult,
  addChallengeNote,
  createChallenge,
  exportFinalOps,
  getChallengeBrief,
  getChallenges,
  getFinalOpsDebrief,
  getHealth,
  type Challenge,
  type HealthStatus,
  importChallenges,
  importFinalOpsBackup,
  patchChallenge,
  runChallengeTriage,
  submitChallenge,
} from '../api'
import { PageHeader } from '../components/layout'
import { Surface, GlowButton, StatusBadge, LoadingState, ErrorState, EmptyState, SectionHeader } from '../components/ui'

const TYPES = ['web', 'code', 'log', 'pcap', 'reverse', 'crypto', 'misc', 'unknown']
const STATUSES = ['new', 'triaging', 'running', 'need_human', 'candidate_found', 'submitted', 'solved', 'blocked', 'paused', 'cancelled']
const FILTER_KEY = 'zhulongx.finalops.filters.v1'
const MAX_VISIBLE = 60

const TYPE_RUNE: Record<string, string> = {
  web: '🕸', code: '⌨', log: '📋', pcap: '📡',
  reverse: '🔧', crypto: '🔐', misc: '🎲', unknown: '❓',
}

const STATUS_STATE_MAP: Record<string, 'INIT' | 'RUNNING' | 'DONE' | 'FAILED' | 'HUMAN_REQUIRED'> = {
  new: 'INIT', triaging: 'RUNNING', running: 'RUNNING',
  need_human: 'HUMAN_REQUIRED', candidate_found: 'DONE',
  submitted: 'DONE', solved: 'DONE', blocked: 'FAILED',
  paused: 'INIT', cancelled: 'FAILED',
}

const STATUS_LABEL: Record<string, string> = {
  new: '待命', triaging: '分诊中', running: '执行中',
  need_human: '需人工', candidate_found: '候选命中',
  submitted: '已提交', solved: '已解决', blocked: '受阻',
  paused: '已暂停', cancelled: '已取消',
}

function readFilters() {
  try { return JSON.parse(window.localStorage.getItem(FILTER_KEY) || '{}') }
  catch { return {} }
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

  const showNotice = (message: string) => { setNotice(message); setError('') }

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
      a.download = `zhulongx-finalops-backup-${timestampName()}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showNotice(`已导出 ${r.data.challenges?.length || 0} 个 Challenge 的备份`)
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
      showNotice(`备份导入完成: 新增 ${r.data.imported_challenges || 0} 个`)
      await load()
    } catch (e: any) {
      setError(e?.response?.data?.detail || '导入备份失败')
    } finally {
      event.target.value = ''
    }
  }

  const runTriage = async (id: number) => {
    setRunningId(id)
    try {
      const r = await runChallengeTriage(id)
      setChallenges(prev => prev.map(c => c.id === id ? r.data : c))
      showNotice('Triage 完成')
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Run Triage 失败')
    } finally {
      setRunningId(null)
    }
  }

  const mark = async (challenge: Challenge, status: string) => {
    const r = await patchChallenge(challenge.id, { status })
    setChallenges(prev => prev.map(c => c.id === challenge.id ? r.data : c))
    showNotice(`${challenge.name} 已标记为 ${STATUS_LABEL[status] || status}`)
  }

  const submit = async (challenge: Challenge, submitStatus: 'submitted' | 'accepted' | 'rejected') => {
    const candidate = bestCandidate(challenge)
    const defaultAnswer = challenge.submitted_answer || candidate?.candidate || ''
    if (!defaultAnswer) { setError('没有候选答案'); return }
    const answer = window.prompt(`提交前确认答案 (${submitStatus})`, defaultAnswer)
    if (answer === null || !answer.trim()) return
    const submitter = window.prompt('提交人', challenge.submitter || challenge.assignee || 'team')
    if (submitter === null || !submitter.trim()) return
    const note = window.prompt('提交备注', submitStatus === 'submitted' ? '已在平台提交前人工确认' : `平台返回 ${submitStatus}`)
    if (note === null) return
    const r = await submitChallenge(challenge.id, {
      answer, submitter, submission_note: note,
      candidate_id: candidate?.id, submit_status: submitStatus,
    })
    setChallenges(prev => prev.map(c => c.id === challenge.id ? r.data : c))
    showNotice(`${challenge.name} → ${submitStatus}`)
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

  if (loading) return <LoadingState />

  return (
    <div className="space-y-6">
      <PageHeader
        title="FinalOps 作战台"
        subtitle="题目态势 · 证据链 · 候选答案 · 提交记录"
        action={
          <div className="flex flex-wrap gap-2">
            <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={importBackupFile} />
            <GlowButton variant="secondary" size="sm" onClick={load}>
              <RefreshCw size={14} /> 刷新
            </GlowButton>
            <GlowButton variant="secondary" size="sm" onClick={copyDebrief}>
              <Clipboard size={14} /> Debrief
            </GlowButton>
            <GlowButton variant="secondary" size="sm" onClick={exportBackup}>
              <Download size={14} /> 导出备份
            </GlowButton>
            <GlowButton variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              <Upload size={14} /> 导入备份
            </GlowButton>
          </div>
        }
      />

      {error && (
        <ErrorState title="操作异常" detail={error} onRetry={() => setError('')} />
      )}
      {notice && (
        <Surface variant="glass" className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm text-cyan-400">
          <span>{notice}</span>
          <button onClick={() => setNotice('')} className="text-cyan-500 hover:text-white text-xs">✕</button>
        </Surface>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <TopStat icon={<Zap size={14} />} label="竞赛模式" value={health?.scope_config_summary?.competition_mode ? 'ON' : 'OFF'} tone={health?.scope_config_summary?.competition_mode ? 'text-jade-400' : 'text-gray-500'} />
        <TopStat icon={<Target size={14} />} label="Scope" value={health?.scope_config_summary?.configured ? 'CONFIGURED' : 'EMPTY'} tone={health?.scope_config_summary?.configured ? 'text-cyan-400' : 'text-ember-400'} />
        <TopStat icon={<Eye size={14} />} label="LLM" value={health?.llm?.enabled ? health.llm.model : 'RULE'} tone={health?.llm?.enabled ? 'text-violet-400' : 'text-cyan-400'} />
        <TopStat icon={<Flame size={14} />} label="Running" value={String(running)} tone="text-ember-400" />
        <TopStat icon={<Crosshair size={14} />} label="Submitted" value={String(submitted)} tone="text-violet-400" />
        <TopStat icon={<Shield size={14} />} label="Candidates" value={`${candidateCount} / Solved ${solved}`} tone="text-jade-400" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-5">
        <aside className="space-y-4">
          <Surface variant="panel" className="p-4 space-y-3">
            <SectionHeader title="新建 Challenge" icon={<Plus size={15} className="text-ember-400" />} />
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
            <textarea className={`input min-h-[72px]`} placeholder="题目描述" value={newForm.description} onChange={e => setNewForm({ ...newForm, description: e.target.value })} />
            <GlowButton variant="primary" className="w-full" onClick={create}>
              <Plus size={14} /> 创建
            </GlowButton>
          </Surface>

          <Surface variant="panel" className="p-4 space-y-3">
            <SectionHeader title="批量导入" icon={<Upload size={15} className="text-ember-400" />} />
            <textarea
              className="input min-h-[120px] font-mono text-xs"
              placeholder='JSON/CSV/Markdown'
              value={importText}
              onChange={e => setImportText(e.target.value)}
            />
            <GlowButton variant="secondary" className="w-full" onClick={importJson}>
              <Upload size={14} /> 导入题单
            </GlowButton>
          </Surface>

          <Surface variant="panel" className="p-4 space-y-3">
            <SectionHeader title="Real CTF Case" icon={<FileText size={15} className="text-ember-400" />} />
            <input className="input font-mono text-xs" value={ctfCasePath} onChange={e => setCtfCasePath(e.target.value)} placeholder="ctf_cases/case01" />
            <div className="grid grid-cols-2 gap-2 text-xs">
              <Info label="Blind Solve" value="ON" />
              <Info label="RAG Disabled" value="ON" />
              <Info label="History Disabled" value="ON" />
              <Info label="Search Disabled" value="ON" />
            </div>
            <div className="text-xs text-gray-600 leading-relaxed">Tool Calls 与 Denied Access 记录在 solve_trace.json</div>
            <div className="grid grid-cols-3 gap-2">
              <GlowButton variant="secondary" size="sm" onClick={() => copyCtfCommand('solve')}>Solve</GlowButton>
              <GlowButton variant="secondary" size="sm" onClick={() => copyCtfCommand('eval')}>Eval</GlowButton>
              <GlowButton variant="secondary" size="sm" onClick={() => copyCtfCommand('both')}>Both</GlowButton>
            </div>
          </Surface>

          <Surface variant="glass" className="p-4 space-y-2 text-xs text-gray-400">
            <SectionHeader title="Scope" icon={<ShieldCheck size={15} className="text-ember-400" />} />
            <div>Mode: <span className="text-gray-200">{health?.scope_config_summary?.competition_mode ? 'competition' : 'safe'}</span></div>
            <div>CIDR: <span className="text-gray-200">{health?.scope_config_summary?.cidrs?.join(', ') || '(empty)'}</span></div>
            <div>Domain: <span className="text-gray-200">{health?.scope_config_summary?.domains?.join(', ') || '(empty)'}</span></div>
            <div>Ports: <span className="text-gray-200">{health?.scope_config_summary?.ports?.join(', ') || 'any'}</span></div>
          </Surface>
        </aside>

        <section className="space-y-4">
          <Surface variant="glass" className="p-3">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_150px_150px_150px] gap-2">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-2.5 text-gray-600" />
                <input className="input pl-9" placeholder="搜索题名、目标、标签" value={query} onChange={e => setQuery(e.target.value)} />
              </div>
              <select className="input" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">全部状态</option>
                {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s] || s}</option>)}
              </select>
              <select className="input" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
                <option value="">全部类型</option>
                {TYPES.map(t => <option key={t} value={t}>{TYPE_RUNE[t]} {t}</option>)}
              </select>
              <select className="input" value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)}>
                <option value="">全部负责人</option>
                {assignees.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
            {visible.length > MAX_VISIBLE && (
              <div className="text-xs text-ember-400 mt-2">筛选命中 {visible.length} 个，仅展示前 {MAX_VISIBLE} 个</div>
            )}
          </Surface>

          {visible.length === 0 ? (
            <EmptyState
              title="暂无匹配题目"
              description="调整筛选条件或新建 Challenge"
              icon={<Filter size={34} className="text-gray-600" />}
            />
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

function TopStat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: string }) {
  return (
    <Surface variant="panel" className="p-3">
      <div className="flex items-center gap-1.5 text-xs text-gray-600 mb-1">
        {icon} {label}
      </div>
      <div className={`text-sm font-semibold truncate ${tone}`}>{value}</div>
    </Surface>
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
    <Surface variant="panel" className="overflow-hidden">
      <div className="p-4 border-b border-obsidian-700">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-obsidian-800 border border-obsidian-700">
                {TYPE_RUNE[challenge.challenge_type] || '?'} {challenge.challenge_type}
              </span>
              <StatusBadge
                state={STATUS_STATE_MAP[challenge.status] || 'INIT'}
                label={STATUS_LABEL[challenge.status] || challenge.status}
                pulse={challenge.status === 'running' || challenge.status === 'triaging'}
              />
              {challenge.priority === 'high' && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-crimson-500/10 text-crimson-400 border border-crimson-500/20">
                  P0
                </span>
              )}
            </div>
            <h2 className="text-white font-semibold truncate text-sm">{challenge.name}</h2>
            <div className="text-xs text-gray-600 mt-1 truncate">{challenge.target || challenge.uploaded_file || '题面/附件'}</div>
          </div>
          <div className="text-right text-xs text-gray-600 shrink-0">
            <div className="flex items-center justify-end gap-1 text-gray-400"><UserRound size={12} /> {challenge.assignee || '未分配'}</div>
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

        {candidate ? (
          <Surface variant="glass" className="p-3 border border-cyan-500/20">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-cyan-400">
                最佳候选 · {(candidate.confidence * 100).toFixed(0)}% · {candidate.validation_status}
              </div>
              <button onClick={() => { copy(candidate.candidate); showNotice('候选答案已复制') }} className="p-1 text-gray-500 hover:text-cyan-400 transition-colors">
                <Copy size={14} />
              </button>
            </div>
            <div className="font-mono text-sm text-ember-300 mt-1 break-all">{candidate.candidate}</div>
          </Surface>
        ) : (
          <div className="text-xs text-gray-600 border border-obsidian-700 rounded-lg p-3">暂无答案候选</div>
        )}

        {challenge.submitted_answer && (
          <Surface variant="glass" className="p-3 border border-violet-500/20 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-violet-400">提交记录 · {challenge.submit_status}</span>
              <button onClick={() => { copy(challenge.submitted_answer); showNotice('提交答案已复制') }} className="text-gray-500 hover:text-violet-400 transition-colors">
                <Copy size={13} />
              </button>
            </div>
            <div className="font-mono text-gray-200 break-all mt-1">{challenge.submitted_answer}</div>
            <div className="text-gray-600 mt-1">{challenge.submitted_at ? new Date(challenge.submitted_at).toLocaleString('zh-CN') : ''} {challenge.submission_note}</div>
          </Surface>
        )}

        <div className="text-xs text-gray-400 leading-relaxed line-clamp-2">{challenge.latest_summary || challenge.description || '等待分诊'}</div>
        <div className="text-xs text-gray-600 leading-relaxed line-clamp-2">{challenge.next_suggestion || challenge.runbook?.strategy || '等待下一步建议'}</div>

        <div className="flex flex-wrap gap-2">
          <GlowButton variant="primary" size="sm" onClick={runTriage} disabled={triageLocked}>
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Triage
          </GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={addNote}>Note</GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={addCandidate}>Candidate</GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={() => submit('submitted')}>Submit</GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={() => submit('accepted')} className="text-jade-400">Accepted</GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={() => submit('rejected')} className="text-crimson-400">Rejected</GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={() => mark('blocked')}>Blocked</GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={() => mark('solved')}>Solved</GlowButton>
          <GlowButton variant="secondary" size="sm" onClick={copyBrief}><FileText size={13} /> Brief</GlowButton>
          {challenge.task_ids[0] && (
            <Link to={`/tasks/${challenge.task_ids[0]}/report`}>
              <GlowButton variant="secondary" size="sm">Report</GlowButton>
            </Link>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={() => { copy(evidenceText); showNotice('证据摘要已复制') }} className="text-xs text-gray-500 hover:text-ember-400 transition-colors flex items-center gap-1">
            <Copy size={12} /> 复制证据
          </button>
          <button onClick={() => mark('paused')} className="text-xs text-gray-500 hover:text-ember-400 transition-colors">暂停</button>
          <button onClick={() => mark('need_human')} className="text-xs text-gray-500 hover:text-crimson-400 transition-colors">需人工</button>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2 pt-2 border-t border-obsidian-700">
          <input className="input" placeholder="人工回填：页面返回、截图说明" value={manual} onChange={e => setManual(e.target.value)} />
          <GlowButton variant="secondary" size="sm" onClick={addManual} title="回填人工结果">
            <Check size={15} />
          </GlowButton>
        </div>
      </div>
    </Surface>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-gray-600">{label}</div>
      <div className="text-gray-400 truncate">{value}</div>
    </div>
  )
}
