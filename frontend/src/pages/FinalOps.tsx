import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Search } from 'lucide-react'
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
  importChallenges,
  importFinalOpsBackup,
  patchChallenge,
  runChallengeTriage,
  submitChallenge,
  type Challenge,
  type HealthStatus,
} from '../api'
import {
  FinalOpsBoard,
  FinalOpsChallengeCard,
  FinalOpsHero,
  FinalOpsSidebar,
  type FinalOpsCreateForm,
} from '../components/finalops'
import { DataEmpty, ErrorState, GlassPanel, LoadingState, StatePill } from '../components/ui'

const TYPES = ['web', 'code', 'log', 'pcap', 'reverse', 'crypto', 'misc', 'unknown']
const STATUSES = ['new', 'triaging', 'running', 'need_human', 'candidate_found', 'submitted', 'solved', 'blocked', 'paused', 'cancelled']
const FILTER_KEY = 'zhulongx.finalops.filters.v2'
const MAX_VISIBLE = 80

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
  const [newForm, setNewForm] = useState<FinalOpsCreateForm>({ name: '', challenge_type: 'web', target: '', assignee: '', priority: 'medium', description: '' })
  const [importText, setImportText] = useState('')
  const [manual, setManual] = useState<Record<number, string>>({})
  const [ctfCasePath, setCtfCasePath] = useState('ctf_cases/case01')

  const load = useCallback(async () => {
    setError('')
    try {
      const [challengeResponse, healthResponse] = await Promise.all([getChallenges(), getHealth()])
      setChallenges(challengeResponse.data)
      setHealth(healthResponse.data)
    } catch (e: any) {
      setError(e?.response?.data?.detail || '加载 FinalOps 数据失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    window.localStorage.setItem(FILTER_KEY, JSON.stringify({ statusFilter, typeFilter, assigneeFilter, query }))
  }, [statusFilter, typeFilter, assigneeFilter, query])

  const visible = useMemo(() => challenges.filter((item) => {
    if (statusFilter && item.status !== statusFilter && item.submit_status !== statusFilter) return false
    if (typeFilter && item.challenge_type !== typeFilter) return false
    if (assigneeFilter && item.assignee !== assigneeFilter) return false
    if (query) {
      const haystack = `${item.name} ${item.description} ${item.target} ${item.tags.join(' ')} ${item.latest_summary}`.toLowerCase()
      if (!haystack.includes(query.toLowerCase())) return false
    }
    return true
  }), [assigneeFilter, challenges, query, statusFilter, typeFilter])

  const visibleLimited = visible.slice(0, MAX_VISIBLE)
  const assignees = Array.from(new Set(challenges.map((challenge) => challenge.assignee).filter(Boolean))).sort()
  const running = challenges.filter((challenge) => ['triaging', 'running'].includes(challenge.status)).length
  const candidateCount = challenges.reduce((sum, challenge) => sum + challenge.answer_candidates.length, 0)
  const solved = challenges.filter((challenge) => challenge.status === 'solved' || challenge.submit_status === 'accepted').length
  const submitted = challenges.filter((challenge) => ['submitted', 'accepted', 'rejected'].includes(challenge.submit_status)).length

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
    const trimmed = importText.trim()
    const format = trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : trimmed.includes(',') && trimmed.includes('\n') ? 'csv' : 'markdown'
    const response = await importChallenges({ format, content: importText })
    setImportText('')
    showNotice(`批量导入完成: ${response.data.created || 0} 个`)
    await load()
  }

  const exportBackup = async () => {
    try {
      const response = await exportFinalOps()
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `zhulongx-finalops-backup-${timestampName()}.json`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      showNotice(`已导出 ${response.data.challenges?.length || 0} 个 Challenge 的备份`)
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
      const response = await importFinalOpsBackup(data)
      showNotice(`备份导入完成: 新增 ${response.data.imported_challenges || 0} 个`)
      await load()
    } catch (e: any) {
      setError(e?.response?.data?.detail || '导入备份失败')
    } finally {
      event.target.value = ''
    }
  }

  const runTriage = async (challenge: Challenge) => {
    setRunningId(challenge.id)
    try {
      const response = await runChallengeTriage(challenge.id)
      setChallenges((previous) => previous.map((item) => item.id === challenge.id ? response.data : item))
      showNotice('Triage 完成')
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Run Triage 失败')
    } finally {
      setRunningId(null)
    }
  }

  const mark = async (challenge: Challenge, status: string) => {
    const response = await patchChallenge(challenge.id, { status })
    setChallenges((previous) => previous.map((item) => item.id === challenge.id ? response.data : item))
    showNotice(`${challenge.name} 已标记为 ${status}`)
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
    const response = await submitChallenge(challenge.id, {
      answer,
      submitter,
      submission_note: note,
      candidate_id: candidate?.id,
      submit_status: submitStatus,
    })
    setChallenges((previous) => previous.map((item) => item.id === challenge.id ? response.data : item))
    showNotice(`${challenge.name} → ${submitStatus}`)
  }

  const addManual = async (challenge: Challenge) => {
    const value = manual[challenge.id]?.trim()
    if (!value) return
    const response = await addChallengeManualResult(challenge.id, { author: challenge.assignee || 'team', result: value })
    setManual((previous) => ({ ...previous, [challenge.id]: '' }))
    setChallenges((previous) => previous.map((item) => item.id === challenge.id ? response.data : item))
    showNotice('人工回填已保存')
  }

  const addCandidate = async (challenge: Challenge) => {
    const value = window.prompt('答案候选')
    if (!value) return
    await addAnswerCandidate(challenge.id, { candidate: value, source: 'manual', confidence: 0.75, why_selected: '人工录入' })
    showNotice('人工候选已保存')
    await load()
  }

  const addNote = async (challenge: Challenge) => {
    const value = window.prompt('备注')
    if (!value) return
    await addChallengeNote(challenge.id, { author: challenge.assignee || 'team', note: value })
    showNotice('备注已保存')
    await load()
  }

  const copyBrief = async (challenge: Challenge) => {
    const response = await getChallengeBrief(challenge.id)
    copy(response.data.markdown)
    showNotice('Brief 已复制')
  }

  const copyDebrief = async () => {
    const response = await getFinalOpsDebrief()
    copy(response.data.markdown)
    showNotice(`Debrief 已复制: submitted=${response.data.submitted_count}, accepted=${response.data.accepted_count}`)
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

  if (loading) return <div className="mx-auto max-w-[1600px] p-6"><LoadingState message="加载 FinalOps 作战台" /></div>

  return (
    <div className="mx-auto max-w-[1800px] space-y-6 p-4 md:p-6 lg:p-8">
      <input ref={fileInputRef} type="file" accept="application/json,.json" className="hidden" onChange={importBackupFile} />

      <FinalOpsHero
        health={health}
        running={running}
        submitted={submitted}
        candidates={candidateCount}
        solved={solved}
        onRefresh={load}
        onDebrief={copyDebrief}
        onExport={exportBackup}
        onImport={() => fileInputRef.current?.click()}
      />

      {error && <ErrorState title="操作异常" detail={error} onRetry={() => setError('')} />}
      {notice && (
        <GlassPanel tone="cyan" compact className="flex items-center justify-between gap-3 text-sm text-cyan-200">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')} className="text-xs text-cyan-400 hover:text-white">关闭</button>
        </GlassPanel>
      )}

      <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
        <FinalOpsSidebar
          types={TYPES}
          form={newForm}
          importText={importText}
          casePath={ctfCasePath}
          health={health}
          onFormChange={setNewForm}
          onImportTextChange={setImportText}
          onCasePathChange={setCtfCasePath}
          onCreate={create}
          onImport={importJson}
          onCopyCommand={copyCtfCommand}
        />

        <section className="space-y-4">
          <GlassPanel tone="slate" compact>
            <div className="grid gap-2 md:grid-cols-[1fr_150px_150px_150px]">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-2.5 text-slate-600" />
                <input className="input pl-9" placeholder="搜索题名、目标、标签、摘要" value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
              <select className="input" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                <option value="">全部状态</option>
                {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                <option value="accepted">accepted</option>
                <option value="rejected">rejected</option>
              </select>
              <select className="input" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value="">全部类型</option>
                {TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
              <select className="input" value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}>
                <option value="">全部负责人</option>
                {assignees.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}
              </select>
            </div>
            {visible.length > MAX_VISIBLE && (
              <div className="mt-2 text-xs text-ember-300">筛选命中 {visible.length} 个，仅展示前 {MAX_VISIBLE} 个</div>
            )}
          </GlassPanel>

          <GlassPanel tone="ember" compact className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white">Brief / Debrief 交付链</div>
              <p className="mt-1 text-xs text-slate-400">每题 Brief 可复制给复核人，全局 Debrief 可直接用于赛后复盘和交付。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <StatePill tone="cyan">visible {visible.length}</StatePill>
              <StatePill tone="jade">accepted {challenges.filter((challenge) => challenge.submit_status === 'accepted').length}</StatePill>
              <StatePill tone="crimson">rejected {challenges.filter((challenge) => challenge.submit_status === 'rejected').length}</StatePill>
            </div>
          </GlassPanel>

          {visible.length === 0 ? (
            <DataEmpty title="暂无匹配题目" description="调整筛选条件、导入题单，或从左侧新建 Challenge。" />
          ) : (
            <FinalOpsBoard
              challenges={visibleLimited}
              renderCard={(challenge) => {
                const candidate = bestCandidate(challenge)
                const evidenceText = (challenge.evidence || []).map((evidence) => `${evidence.evidence_uid}: ${evidence.output_excerpt}`).join('\n\n')
                return (
                  <FinalOpsChallengeCard
                    key={challenge.id}
                    challenge={challenge}
                    candidate={candidate?.candidate}
                    candidateConfidence={candidate?.confidence}
                    running={runningId === challenge.id}
                    manual={manual[challenge.id] || ''}
                    onManualChange={(value) => setManual((previous) => ({ ...previous, [challenge.id]: value }))}
                    onRunTriage={() => runTriage(challenge)}
                    onMark={(status) => mark(challenge, status)}
                    onSubmit={(status) => submit(challenge, status)}
                    onAddManual={() => addManual(challenge)}
                    onAddNote={() => addNote(challenge)}
                    onAddCandidate={() => addCandidate(challenge)}
                    onCopyBrief={() => copyBrief(challenge)}
                    onCopyCandidate={() => { copy(candidate?.candidate || ''); showNotice('候选答案已复制') }}
                    onCopyEvidence={() => { copy(evidenceText); showNotice('证据摘要已复制') }}
                  />
                )
              }}
            />
          )}
        </section>
      </div>

      <GlassPanel tone="jade" compact className="text-xs leading-5 text-slate-400">
        安全提醒：FinalOps 的所有自动化、提交记录、备份恢复和团队演练都默认服务于授权靶场或比赛环境。真实公网目标必须先通过 ScopeGuard 与人工确认。
      </GlassPanel>
    </div>
  )
}
