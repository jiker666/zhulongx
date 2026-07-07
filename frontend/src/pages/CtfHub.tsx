import { useEffect, useState, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Flame, Target, Play, Loader2, CheckCircle2, XCircle, Trophy,
  ArrowRight, Cpu, AlertCircle, Plus, X, Paperclip, Trash2,
  Shield, Zap, Clock, FileCode2, Radio,
} from 'lucide-react'
import {
  ctfListDemos, ctfRunDemo, ctfListTasks, ctfLlmStatus,
  ctfCreateTask, ctfUploadAttachment,
  type CtfDemo, type CtfTask, type LlmStatus,
} from '../api'
import { z, statusStyle, categoryStyle } from '../styles/tokens'
import { Surface, GlowButton, StatusBadge, SectionHeader, EmptyState, LoadingState, ErrorState, ProgressRing } from '../components/ui'
import { BrandMark } from '../components/brand'
import { PageHeader } from '../components/layout'

interface DemoResult {
  demoId: string
  taskId: string
  match?: boolean | null
  flag?: string | null
  state?: string
  error?: string
}

const CAT_ICONS: Record<string, React.ReactNode> = {
  crypto: <FileCode2 size={14} />,
  web: <Radio size={14} />,
  reverse: <Zap size={14} />,
  pwn: <Flame size={14} />,
  misc: <Target size={14} />,
  forensics: <Shield size={14} />,
}

const LLM_STYLE: Record<string, { bg: string; text: string; border: string }> = {
  mock:     { bg: 'bg-ember-500/10',  text: 'text-ember-400',  border: 'border-ember-500/30' },
  live:     { bg: 'bg-jade-500/10',   text: 'text-jade-400',   border: 'border-jade-500/30' },
  disabled: { bg: 'bg-crimson-500/10',text: 'text-crimson-400', border: 'border-crimson-500/30' },
}

function DifficultyMeter({ level }: { level: string }) {
  const n = level === 'hard' ? 3 : level === 'medium' ? 2 : 1
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className={`w-1.5 h-3 rounded-full ${i < n ? 'bg-ember-400' : 'bg-obsidian-600'}`}
        />
      ))}
    </div>
  )
}

function ChallengeCard({
  demo, running, result, onRun,
}: {
  demo: CtfDemo
  running: string | null
  result?: DemoResult
  onRun: (id: string) => void
}) {
  const cs = categoryStyle(demo.category)
  const isRunning = running === demo.id
  const isDone = result?.state === 'DONE'
  const isFailed = result?.state === 'FAILED' || result?.state === 'HUMAN_REQUIRED'
  const isRunningState = result?.state && !isDone && !isFailed

  return (
    <Surface
      variant={isDone ? 'success' : isFailed ? 'danger' : 'panel'}
      className="flex flex-col h-full transition-all duration-300 hover:shadow-glow group"
    >
      <div className="flex items-start justify-between mb-3">
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] uppercase rounded-md border ${cs.bg} ${cs.text} ${cs.border}`}>
          {CAT_ICONS[demo.category] ?? <Target size={12} />}
          {demo.category}
        </span>
        <div className="flex items-center gap-2 text-[10px] text-slate-400">
          <DifficultyMeter level={demo.difficulty} />
          <span>~{demo.est_time_sec}s</span>
          {demo.needs_llm && (
            <span className="px-1.5 py-0.5 bg-violet-500/15 text-violet-400 rounded text-[9px] border border-violet-500/20">
              LLM
            </span>
          )}
        </div>
      </div>

      <h3 className="font-semibold text-white mb-1 text-sm leading-snug">{demo.title}</h3>
      <p className="text-xs text-slate-400 flex-1 mb-3 line-clamp-3">{demo.description}</p>

      {result && (
        <div className={`mb-3 px-3 py-2 rounded-lg text-xs font-mono border ${
          isDone
            ? 'bg-jade-500/10 border-jade-500/30 text-jade-400'
            : isFailed
            ? 'bg-crimson-500/10 border-crimson-500/30 text-crimson-400'
            : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
        }`}>
          {isDone ? (
            <span className="flex items-center gap-1.5">
              <CheckCircle2 size={13} /> {result.flag}
            </span>
          ) : isFailed ? (
            <span className="flex items-center gap-1.5">
              <XCircle size={13} /> {result.state}
              {result.error && <span className="text-crimson-400 ml-1">{result.error}</span>}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin" /> {result.state}...
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mt-auto">
        <GlowButton
          variant={isDone ? 'secondary' : 'primary'}
          size="sm"
          onClick={() => onRun(demo.id)}
          disabled={isRunning}
          className="flex-1"
        >
          {isRunning ? (
            <><Loader2 size={12} className="animate-spin" /> 执行中</>
          ) : (
            <><Play size={12} /> 运行</>
          )}
        </GlowButton>
        {result && (
          <Link to={`/ctf/${result.taskId}`}>
            <GlowButton variant="secondary" size="sm">
              详情 <ArrowRight size={12} />
            </GlowButton>
          </Link>
        )}
      </div>
    </Surface>
  )
}

function TaskRow({ task }: { task: CtfTask }) {
  const ss = statusStyle(task.is_running ? 'RUNNING' : task.state)
  const cs = categoryStyle(task.plan?.category || 'misc')
  const solved = task.state === 'DONE'

  return (
    <Link
      to={`/ctf/${task.task_id}`}
      className="flex items-center gap-4 px-4 py-3 border-b border-obsidian-600/50 last:border-0 hover:bg-obsidian-800/40 transition-colors group"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ss.dot} ${task.is_running ? 'animate-pulse' : ''}`} />
        <span className="text-sm text-white truncate">{task.title}</span>
      </div>

      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border ${cs.bg} ${cs.text} ${cs.border}`}>
        {task.plan?.category || '—'}
      </span>

      <StatusBadge state={task.is_running ? 'RUNNING' : task.state} />

      <span className={`text-xs font-mono ${solved ? 'text-jade-400' : 'text-slate-500'}`}>
        {task.best_flag || '—'}
      </span>

      <span className="text-xs text-slate-500 tabular-nums w-8 text-right">{task.rounds_used}</span>

      <ArrowRight size={14} className="text-slate-500 group-hover:text-ember-400 transition-colors" />
    </Link>
  )
}

export default function CtfHub() {
  const navigate = useNavigate()
  const [demos, setDemos] = useState<CtfDemo[]>([])
  const [tasks, setTasks] = useState<CtfTask[]>([])
  const [llm, setLlm] = useState<LlmStatus | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, DemoResult>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showNew, setShowNew] = useState(false)
  const [newForm, setNewForm] = useState({
    title: '', description: '', category: 'auto',
    flag_format: '', authorized: false, allow_network: false,
  })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
    const hasRunning = Object.values(results).some(
      (r) => r.state && !['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(r.state)
    )
    if (!hasRunning) return
    const iv = setInterval(refresh, 1500)
    return () => clearInterval(iv)
  }, [results, refresh])

  const runDemo = async (demoId: string) => {
    setRunning(demoId)
    setError(null)
    try {
      const r = await ctfRunDemo(demoId, 0, 600)
      const data = r.data
      setResults((p) => ({ ...p, [demoId]: { demoId, taskId: data.task_id, match: data.match, flag: data.best_flag, state: data.state } }))
      const iv = setInterval(async () => {
        try {
          const er = await ctfListTasks()
          const task = er.data.find((t) => t.task_id === data.task_id)
          if (task) {
            setResults((p) => ({ ...p, [demoId]: { ...p[demoId], state: task.state, flag: task.best_flag } }))
            if (['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(task.state)) { clearInterval(iv); refresh() }
          }
        } catch {}
      }, 1500)
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message
      setError(`运行 ${demoId} 失败: ${msg}`)
      setResults((p) => ({ ...p, [demoId]: { demoId, taskId: '', state: 'FAILED', error: msg } }))
    } finally { setRunning(null) }
  }

  const handleCreate = async () => {
    if (!newForm.title.trim()) { setCreateError('请填写题目标题'); return }
    if (!newForm.description.trim()) { setCreateError('请填写题面描述'); return }
    setCreating(true); setCreateError('')
    try {
      const res = await ctfCreateTask({
        title: newForm.title.trim(), description: newForm.description.trim(),
        category: newForm.category, flag_format: newForm.flag_format.trim() || null,
        authorized: newForm.authorized,
        allow_network: newForm.allow_network && newForm.authorized,
        max_rounds: 0, max_time_sec: 600,
      })
      const taskId = res.data.task_id
      if (uploadFiles.length > 0) {
        setUploading(true)
        for (const file of uploadFiles) {
          try { await ctfUploadAttachment(taskId, file) } catch (e: any) { console.warn(`附件 ${file.name} 上传失败:`, e?.message) }
        }
        setUploading(false)
      }
      setShowNew(false)
      setNewForm({ title: '', description: '', category: 'auto', flag_format: '', authorized: false, allow_network: false })
      setUploadFiles([])
      navigate(`/ctf/${taskId}`)
    } catch (e: any) {
      setCreateError(e?.response?.data?.detail || e.message || '创建失败')
    } finally { setCreating(false) }
  }

  const solvedCount = tasks.filter((t) => t.state === 'DONE').length
  const runningCount = tasks.filter((t) => t.is_running).length

  return (
    <div className="min-h-screen bg-obsidian-950">
      <PageHeader
        title="CTF 擂台"
        subtitle="内置题集一键开战 · 自建题目智能识别题型 · 实时追踪战况"
        icon={<Trophy size={20} className="text-ember-400" />}
        action={
          <div className="flex items-center gap-3">
            {llm && (() => {
              const ls = LLM_STYLE[llm.mode] || LLM_STYLE.disabled
              return (
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs ${ls.bg} ${ls.text} ${ls.border}`}>
                  <Cpu size={13} />
                  <span className="font-mono uppercase">{llm.mode}</span>
                  <span className="opacity-40">·</span>
                  <span>{llm.model}</span>
                </div>
              )
            })()}
            <GlowButton onClick={() => setShowNew(true)} size="sm">
              <Plus size={14} /> 新建题目
            </GlowButton>
          </div>
        }
      />

      <div className="px-6 md:px-8 pb-8 space-y-8">
        {error && <ErrorState title="同步失败" detail={error} onRetry={refresh} />}

        {loading ? (
          <LoadingState />
        ) : (
          <>
            {/* Arena Pulse Bar */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-obsidian-800/60 border border-obsidian-600/30">
                <Trophy size={18} className="text-ember-400" />
                <div>
                  <div className="text-lg font-bold text-white tabular-nums">{demos.length}</div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider">题集</div>
                </div>
              </div>
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-obsidian-800/60 border border-obsidian-600/30">
                <Flame size={18} className="text-cyan-400" />
                <div>
                  <div className="text-lg font-bold text-white tabular-nums">{tasks.length}</div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider">作战</div>
                </div>
              </div>
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-obsidian-800/60 border border-obsidian-600/30">
                <CheckCircle2 size={18} className="text-jade-400" />
                <div>
                  <div className="text-lg font-bold text-white tabular-nums">{solvedCount}</div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider">攻克</div>
                </div>
              </div>
              <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-obsidian-800/60 border border-obsidian-600/30">
                <Radio size={18} className={`${runningCount > 0 ? 'text-ember-400 animate-pulse' : 'text-slate-500'}`} />
                <div>
                  <div className="text-lg font-bold text-white tabular-nums">{runningCount}</div>
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider">运行中</div>
                </div>
              </div>
            </div>

            {/* Demo Gallery */}
            <section>
              <SectionHeader
                title={`内置题集 · ${demos.length}`}
                badge={llm?.mode === 'mock' ? 'Mock 模式' : 'Live 模式'}
                icon={<Trophy size={16} className="text-ember-400" />}
              />
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {demos.map((d) => (
                  <ChallengeCard
                    key={d.id}
                    demo={d}
                    running={running}
                    result={results[d.id]}
                    onRun={runDemo}
                  />
                ))}
              </div>
              {demos.length === 0 && (
                <EmptyState icon={<Trophy size={32} />} title="暂无内置题集" />
              )}
            </section>

            {/* Task History */}
            <section>
              <SectionHeader
                title={`作战记录 · ${tasks.length}`}
                action={{ label: '刷新', onClick: refresh }}
                icon={<Flame size={16} className="text-cyan-400" />}
              />
              <Surface variant="panel" className="overflow-hidden">
                {tasks.length === 0 ? (
                  <EmptyState icon={<Flame size={32} />} title="暂无作战记录" description="先运行一个 demo 试试" />
                ) : (
                  <div>
                    <div className="flex items-center gap-4 px-4 py-2 border-b border-obsidian-600/30 text-[10px] uppercase tracking-wider text-slate-500 font-medium">
                      <span className="flex-1">标题</span>
                      <span className="w-16 text-center">题型</span>
                      <span className="w-20 text-center">状态</span>
                      <span className="w-24">Flag</span>
                      <span className="w-8 text-right">轮次</span>
                      <span className="w-5" />
                    </div>
                    {tasks.map((t) => (
                      <TaskRow key={t.task_id} task={t} />
                    ))}
                  </div>
                )}
              </Surface>
            </section>
          </>
        )}
      </div>

      {/* New Challenge Modal */}
      {showNew && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowNew(false)}
        >
          <div
            className="bg-obsidian-900 border border-ember-500/30 rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-ember-500/20">
              <h3 className="font-bold text-white flex items-center gap-2">
                <BrandMark size={20} className="text-ember-400" /> 新建 CTF 题目
              </h3>
              <button onClick={() => { setShowNew(false); setUploadFiles([]) }} className="text-slate-400 hover:text-white">
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="rounded-lg border border-ember-500/20 bg-ember-500/5 px-3 py-2 text-[11px] text-ember-300/80">
                只需填写标题和题面，模型会自动识别题型（web/crypto/reverse/pwn/misc/forensics）。
                附件可直接在此上传，也可以创建后到详情页补充。
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">
                  题目标题 <span className="text-crimson-400">*</span>
                </label>
                <input
                  className="w-full bg-obsidian-700 border border-obsidian-500 rounded-lg px-3 py-2.5 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-ember-500 text-sm"
                  placeholder="例如：神秘流量包"
                  value={newForm.title}
                  onChange={(e) => setNewForm({ ...newForm, title: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">
                  题面描述 <span className="text-crimson-400">*</span>
                  <span className="text-slate-500 text-xs ml-2">（模型据此识别题型和思路）</span>
                </label>
                <textarea
                  className="w-full bg-obsidian-700 border border-obsidian-500 rounded-lg px-3 py-2.5 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-ember-500 text-sm min-h-[120px] resize-y font-mono"
                  placeholder="流量包里藏着 flag，请分析这段抓包数据找出隐藏的 flag。"
                  value={newForm.description}
                  onChange={(e) => setNewForm({ ...newForm, description: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1.5">
                  附件 <span className="text-slate-500 text-xs ml-1">（可选，支持多文件）</span>
                </label>
                <div
                  className="border-2 border-dashed border-obsidian-500 rounded-lg p-3 text-center cursor-pointer hover:border-ember-500/40 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={18} className="mx-auto text-slate-500 mb-1" />
                  <p className="text-xs text-slate-400">点击选择文件，或拖放附件到此处</p>
                  <p className="text-[10px] text-slate-600 mt-1">支持任意格式（pcap/zip/py/bin/png…），单文件 ≤ 30MB</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const files = e.target.files
                      if (files) setUploadFiles((p) => [...p, ...Array.from(files)])
                      e.target.value = ''
                    }}
                  />
                </div>
                {uploadFiles.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {uploadFiles.map((f, i) => (
                      <div key={`${f.name}-${i}`} className="flex items-center gap-2 text-xs bg-obsidian-700 border border-obsidian-500 rounded-lg px-3 py-1.5">
                        <Paperclip size={12} className="text-ember-400 flex-shrink-0" />
                        <span className="text-slate-300 truncate flex-1">{f.name}</span>
                        <span className="text-slate-600 flex-shrink-0">
                          {f.size < 1024 ? `${f.size}B` : f.size < 1048576 ? `${(f.size / 1024).toFixed(1)}KB` : `${(f.size / 1048576).toFixed(1)}MB`}
                        </span>
                        <button onClick={() => setUploadFiles((p) => p.filter((_, idx) => idx !== i))} className="text-slate-500 hover:text-crimson-400 flex-shrink-0">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">
                    题型 <span className="text-slate-500 text-xs ml-1">（auto = 模型识别）</span>
                  </label>
                  <select
                    className="w-full bg-obsidian-700 border border-obsidian-500 rounded-lg px-3 py-2.5 text-slate-200 focus:outline-none focus:border-ember-500 text-sm"
                    value={newForm.category}
                    onChange={(e) => setNewForm({ ...newForm, category: e.target.value })}
                  >
                    <option value="auto">auto（模型识别）</option>
                    <option value="web">web</option>
                    <option value="crypto">crypto</option>
                    <option value="reverse">reverse</option>
                    <option value="pwn">pwn</option>
                    <option value="misc">misc</option>
                    <option value="forensics">forensics</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1.5">
                    flag 格式 <span className="text-slate-500 text-xs">（可选）</span>
                  </label>
                  <input
                    className="w-full bg-obsidian-700 border border-obsidian-500 rounded-lg px-3 py-2.5 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-ember-500 text-sm font-mono"
                    placeholder="例如 flag\\{.*\\}"
                    value={newForm.flag_format}
                    onChange={(e) => setNewForm({ ...newForm, flag_format: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={newForm.authorized} onChange={(e) => setNewForm({ ...newForm, authorized: e.target.checked })} className="rounded bg-obsidian-700 border-obsidian-500 accent-ember-500" />
                  <span>已获授权</span>
                  <span className="text-slate-500 text-xs">（未授权将强制禁网）</span>
                </label>
                <label className={`flex items-center gap-2 text-sm cursor-pointer ${newForm.authorized ? 'text-slate-300' : 'text-slate-600'}`}>
                  <input type="checkbox" checked={newForm.allow_network && newForm.authorized} disabled={!newForm.authorized} onChange={(e) => setNewForm({ ...newForm, allow_network: e.target.checked })} className="rounded bg-obsidian-700 border-obsidian-500 accent-ember-500" />
                  <span>允许联网</span>
                  <span className="text-slate-500 text-xs">（需先勾选已授权）</span>
                </label>
              </div>

              {createError && (
                <div className="text-xs text-crimson-400 bg-crimson-500/10 border border-crimson-500/20 rounded-lg px-3 py-2">
                  {createError}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2 border-t border-ember-500/10">
                <GlowButton variant="secondary" onClick={() => { setShowNew(false); setUploadFiles([]) }}>
                  取消
                </GlowButton>
                <GlowButton
                  onClick={handleCreate}
                  disabled={creating || uploading || !newForm.title.trim() || !newForm.description.trim()}
                >
                  {uploading ? <><Loader2 size={14} className="animate-spin" /> 上传附件中…</>
                  : creating ? <><Loader2 size={14} className="animate-spin" /> 创建中…</>
                  : <><CheckCircle2 size={14} /> 创建并开始</>}
                </GlowButton>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
