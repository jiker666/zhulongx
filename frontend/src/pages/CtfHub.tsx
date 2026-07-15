import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertCircle, RefreshCw, Trophy } from 'lucide-react'
import {
  ctfCreateTask, ctfListDemos, ctfListTasks, ctfLlmStatus, ctfRunDemo, ctfUploadAttachment,
  type CtfDemo, type CtfTask, type LlmStatus,
} from '../api'
import {
  ChallengeTypeFilter,
  ChallengeWarRoomHeader,
  CtfTaskCard,
  DemoChallengeCard,
  ImportChallengePanel,
  type ChallengeCreateForm,
  type DemoRunResult,
} from '../components/ctf'
import { DataEmpty, ErrorState, GlassPanel, GlowButton, LoadingState, SectionShell, StatePill } from '../components/ui'
import { categoryTone } from '../lib/status'

const DEFAULT_FORM: ChallengeCreateForm = {
  title: '',
  description: '',
  category: 'auto',
  flag_format: '',
  authorized: false,
  allow_network: false,
}

function taskStatusBucket(task: CtfTask) {
  if (task.state === 'DONE') return 'solved'
  if (['FAILED', 'HUMAN_REQUIRED'].includes(task.state)) return 'failed'
  if (task.best_flag || task.candidate_flags.length > 0) return 'candidate'
  if (task.is_running || ['AGENT_THINK', 'RUN_SCRIPT', 'RUN_SHELL', 'ANALYZE_FILES', 'VERIFY_FLAG'].includes(task.state)) return 'running'
  return 'pending'
}

export default function CtfHub() {
  const navigate = useNavigate()
  const importRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [demos, setDemos] = useState<CtfDemo[]>([])
  const [tasks, setTasks] = useState<CtfTask[]>([])
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, DemoRunResult>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [candidateOnly, setCandidateOnly] = useState(false)
  const [form, setForm] = useState<ChallengeCreateForm>(DEFAULT_FORM)
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [createError, setCreateError] = useState('')

  const refresh = useCallback(() => {
    Promise.all([ctfListDemos(), ctfListTasks(), ctfLlmStatus()])
      .then(([d, t, l]) => {
        setDemos((d.data as any)?.demos || (d.data as any) || [])
        setTasks(t.data)
        setLlm(l.data)
        setError(null)
      })
      .catch((e) => setError(e?.message || '无法连接后端'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    const hasRunningResult = Object.values(results).some(
      (result) => result.state && !['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(result.state),
    )
    if (!hasRunningResult) return
    const timer = setInterval(refresh, 1500)
    return () => clearInterval(timer)
  }, [results, refresh])

  const runDemo = async (demoId: string) => {
    setRunning(demoId)
    setError(null)
    try {
      const response = await ctfRunDemo(demoId, 0, 600)
      const data = response.data
      setResults((previous) => ({ ...previous, [demoId]: { demoId, taskId: data.task_id, match: data.match, flag: data.best_flag, state: data.state } }))
      const timer = setInterval(async () => {
        try {
          const tasksResponse = await ctfListTasks()
          const task = tasksResponse.data.find((item) => item.task_id === data.task_id)
          if (task) {
            setResults((previous) => ({ ...previous, [demoId]: { ...previous[demoId], state: task.state, flag: task.best_flag } }))
            if (['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(task.state)) {
              clearInterval(timer)
              refresh()
            }
          }
        } catch {
          clearInterval(timer)
        }
      }, 1500)
    } catch (e: any) {
      const message = e?.response?.data?.detail || e.message
      setError(`运行 ${demoId} 失败: ${message}`)
      setResults((previous) => ({ ...previous, [demoId]: { demoId, taskId: '', state: 'FAILED', error: message } }))
    } finally {
      setRunning(null)
    }
  }

  const handleCreate = async () => {
    if (!form.title.trim()) { setCreateError('请填写题目标题'); return }
    if (!form.description.trim()) { setCreateError('请填写题面描述'); return }
    setCreating(true)
    setCreateError('')
    try {
      const response = await ctfCreateTask({
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category,
        flag_format: form.flag_format.trim() || null,
        authorized: form.authorized,
        allow_network: form.allow_network && form.authorized,
        max_rounds: 0,
        max_time_sec: 600,
      })
      const taskId = response.data.task_id
      if (uploadFiles.length > 0) {
        setUploading(true)
        for (const file of uploadFiles) {
          try {
            await ctfUploadAttachment(taskId, file)
          } catch (e: any) {
            console.warn(`附件 ${file.name} 上传失败:`, e?.message)
          }
        }
      }
      setForm(DEFAULT_FORM)
      setUploadFiles([])
      navigate(`/ctf/${taskId}`)
    } catch (e: any) {
      setCreateError(e?.response?.data?.detail || e.message || '创建失败')
    } finally {
      setCreating(false)
      setUploading(false)
    }
  }

  const solvedCount = tasks.filter((task) => task.state === 'DONE').length
  const runningCount = tasks.filter((task) => task.is_running).length

  const filteredTasks = useMemo(() => tasks.filter((task) => {
    const category = (task.plan?.category || task.category_hint || '').toLowerCase()
    if (typeFilter !== 'all' && category !== typeFilter) return false
    if (statusFilter !== 'all' && taskStatusBucket(task) !== statusFilter) return false
    if (candidateOnly && !task.best_flag && task.candidate_flags.length === 0) return false
    return true
  }), [candidateOnly, statusFilter, tasks, typeFilter])

  const filteredDemos = useMemo(() => demos.filter((demo) => typeFilter === 'all' || demo.category === typeFilter), [demos, typeFilter])

  if (loading) return <div className="mx-auto max-w-[1500px] p-6"><LoadingState message="加载 CTF 作战大厅" /></div>

  return (
    <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6 lg:p-8">
      <ChallengeWarRoomHeader
        llm={llm}
        totalDemos={demos.length}
        totalTasks={tasks.length}
        running={runningCount}
        solved={solvedCount}
        onNew={() => importRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      />

      {error && <ErrorState title="同步失败" detail={error} onRetry={refresh} />}

      <div className="grid gap-6 xl:grid-cols-[430px_1fr]">
        <div ref={importRef} className="space-y-4">
          <ImportChallengePanel
            form={form}
            files={uploadFiles}
            createError={createError}
            creating={creating}
            uploading={uploading}
            fileInputRef={fileInputRef}
            onFormChange={setForm}
            onFilesChange={setUploadFiles}
            onCreate={handleCreate}
          />
          <GlassPanel tone="crimson">
            <div className="flex items-start gap-3">
              <AlertCircle size={18} className="mt-0.5 flex-shrink-0 text-ember-300" />
              <div>
                <h2 className="text-sm font-semibold text-white">授权范围提示</h2>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  未勾选“已获授权”时，任务会保持禁网策略。需要联网的靶场题请先确认比赛或教学范围，再打开 allow_network。
                </p>
              </div>
            </div>
          </GlassPanel>
        </div>

        <div className="space-y-6">
          <ChallengeTypeFilter
            type={typeFilter}
            status={statusFilter}
            candidateOnly={candidateOnly}
            onType={setTypeFilter}
            onStatus={setStatusFilter}
            onCandidateOnly={setCandidateOnly}
          />

          <SectionShell
            eyebrow="Challenge Board"
            title={`作战任务 · ${filteredTasks.length}`}
            description="每张卡片都把题型、状态、候选 flag、证据数量和最后动作放在同一视野内。"
            action={<GlowButton variant="secondary" size="sm" onClick={refresh}><RefreshCw size={13} /> 刷新</GlowButton>}
          >
            {filteredTasks.length === 0 ? (
              <DataEmpty title="没有匹配的作战任务" description="放宽筛选条件，或从左侧导入一题让 Agent 开始分类与计划。" />
            ) : (
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {filteredTasks.map((task) => <CtfTaskCard key={task.task_id} task={task} />)}
              </div>
            )}
          </SectionShell>

          <SectionShell
            eyebrow="Demo Range"
            title={`内置题集 · ${filteredDemos.length}`}
            description="适合演示端到端闭环：启动后可进入单题驾驶舱查看推理、证据、候选 flag 与 WP。"
          >
            {filteredDemos.length === 0 ? (
              <DataEmpty icon={<Trophy size={22} />} title="当前题型暂无内置题" description="切回全部题型，或导入自己的题面和附件。" />
            ) : (
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {filteredDemos.map((demo) => (
                  <DemoChallengeCard
                    key={demo.id}
                    demo={demo}
                    running={running}
                    result={results[demo.id]}
                    onRun={runDemo}
                  />
                ))}
              </div>
            )}
          </SectionShell>
        </div>
      </div>

      <GlassPanel tone="jade" className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">候选战果复核队列</div>
          <p className="mt-1 text-xs text-slate-400">有候选 flag 的任务会优先展示，人工复核后再提交或生成 WP。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {tasks.filter((task) => task.best_flag || task.candidate_flags.length > 0).slice(0, 5).map((task) => (
            <Link key={task.task_id} to={`/ctf/${task.task_id}`}>
              <StatePill tone={categoryTone(task.plan?.category || task.category_hint)}>{task.title}</StatePill>
            </Link>
          ))}
          {tasks.every((task) => !task.best_flag && task.candidate_flags.length === 0) && (
            <StatePill tone="slate">等待候选 flag</StatePill>
          )}
        </div>
      </GlassPanel>
    </div>
  )
}
