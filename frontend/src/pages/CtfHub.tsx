import { useEffect, useState, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useRef } from 'react'
import {
  Flame,
  Target,
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  Trophy,
  ArrowRight,
  Cpu,
  AlertCircle,
  Plus,
  X,
  Paperclip,
  Trash2,
} from 'lucide-react'
import {
  ctfListDemos,
  ctfRunDemo,
  ctfListTasks,
  ctfLlmStatus,
  ctfCreateTask,
  ctfUploadAttachment,
  type CtfDemo,
  type CtfTask,
  type LlmStatus,
} from '../api'

const CATEGORY_COLORS: Record<string, string> = {
  crypto: 'border-purple-500/40 text-purple-300 bg-purple-500/10',
  web: 'border-blue-500/40 text-blue-300 bg-blue-500/10',
  reverse: 'border-orange-500/40 text-orange-300 bg-orange-500/10',
  pwn: 'border-red-500/40 text-red-300 bg-red-500/10',
  misc: 'border-green-500/40 text-green-300 bg-green-500/10',
  forensics: 'border-cyan-500/40 text-cyan-300 bg-cyan-500/10',
}

const STATE_COLORS: Record<string, string> = {
  DONE: 'text-green-400',
  FAILED: 'text-red-400',
  HUMAN_REQUIRED: 'text-yellow-400',
  INIT: 'text-gray-400',
  RUNNING: 'text-blue-400',
}

const LLM_MODE_COLORS: Record<string, string> = {
  mock: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300',
  live: 'bg-green-500/10 border-green-500/30 text-green-300',
  disabled: 'bg-red-500/10 border-red-500/30 text-red-300',
}

interface DemoResult {
  demoId: string
  taskId: string
  match?: boolean | null
  flag?: string | null
  state?: string
  error?: string
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

  // 新建题目 modal
  const [showNew, setShowNew] = useState(false)
  const [newForm, setNewForm] = useState({
    title: '',
    description: '',
    category: 'auto',
    flag_format: '',
    authorized: false,
    allow_network: false,
  })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  // 附件上传
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => {
    Promise.all([ctfListDemos(), ctfListTasks(), ctfLlmStatus()])
      .then(([d, t, l]) => {
        // demos endpoint returns {demos: [...], llm: {...}}
        const demosData = (d.data as any)?.demos || (d.data as any) || []
        setDemos(demosData)
        setTasks(t.data)
        setLlm(l.data)
        setError(null)
      })
      .catch((e) => {
        setError(e?.message || '无法连接后端，请确认后端已启动')
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Auto-refresh running tasks
  useEffect(() => {
    const hasRunning = Object.values(results).some(
      (r) => r.state && !['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(r.state)
    )
    if (!hasRunning) return
    const interval = setInterval(refresh, 1500)
    return () => clearInterval(interval)
  }, [results, refresh])

  const runDemo = async (demoId: string) => {
    setRunning(demoId)
    setError(null)
    try {
      const r = await ctfRunDemo(demoId, 8)
      const data = r.data
      setResults((prev) => ({
        ...prev,
        [demoId]: {
          demoId,
          taskId: data.task_id,
          match: data.match,
          flag: data.best_flag,
          state: data.state,
        },
      }))
      // Start polling for completion
      const pollInterval = setInterval(async () => {
        try {
          const er = await ctfListTasks()
          const task = er.data.find((t) => t.task_id === data.task_id)
          if (task) {
            setResults((prev) => ({
              ...prev,
              [demoId]: {
                ...prev[demoId],
                state: task.state,
                flag: task.best_flag,
              },
            }))
            if (['DONE', 'FAILED', 'HUMAN_REQUIRED'].includes(task.state)) {
              clearInterval(pollInterval)
              refresh()
            }
          }
        } catch (e) {
          // ignore poll errors
        }
      }, 1500)
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e.message
      setError(`运行 ${demoId} 失败: ${msg}`)
      setResults((prev) => ({
        ...prev,
        [demoId]: { demoId, taskId: '', state: 'FAILED', error: msg },
      }))
    } finally {
      setRunning(null)
    }
  }

  const handleCreate = async () => {
    if (!newForm.title.trim()) {
      setCreateError('请填写题目标题')
      return
    }
    if (!newForm.description.trim()) {
      setCreateError('请填写题面描述（模型据此识别题型）')
      return
    }
    setCreating(true)
    setCreateError('')
    try {
      const res = await ctfCreateTask({
        title: newForm.title.trim(),
        description: newForm.description.trim(),
        category: newForm.category,
        flag_format: newForm.flag_format.trim() || null,
        authorized: newForm.authorized,
        allow_network: newForm.allow_network && newForm.authorized,
        max_rounds: 8,
      })
      const taskId = res.data.task_id
      // 上传附件（如有）
      if (uploadFiles.length > 0) {
        setUploading(true)
        for (const file of uploadFiles) {
          try {
            await ctfUploadAttachment(taskId, file)
          } catch (e: any) {
            // 单个附件上传失败不阻塞，记录提示
            console.warn(`附件 ${file.name} 上传失败:`, e?.message)
          }
        }
        setUploading(false)
      }
      setShowNew(false)
      setNewForm({ title: '', description: '', category: 'auto', flag_format: '', authorized: false, allow_network: false })
      setUploadFiles([])
      navigate(`/ctf/${taskId}`)
    } catch (e: any) {
      setCreateError(e?.response?.data?.detail || e.message || '创建失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0a0e1a] via-[#0d1426] to-[#0a0e1a] p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Target className="text-amber-400" size={24} /> CTF 作战中心
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            一键运行内置 demo 题，或自建题目让模型自动识别题型
          </p>
        </div>
        <div className="flex items-center gap-2">
          {llm && (
            <div className={`px-3 py-1.5 rounded-lg border text-xs flex items-center gap-2 ${LLM_MODE_COLORS[llm.mode] || LLM_MODE_COLORS.disabled}`}>
              <Cpu size={14} />
              <span className="font-mono uppercase">{llm.mode}</span>
              <span className="opacity-60">·</span>
              <span>{llm.model}</span>
            </div>
          )}
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black text-xs font-medium rounded-lg transition-colors"
          >
            <Plus size={14} /> 新建题目
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2 text-red-300 text-sm">
          <AlertCircle size={16} />
          <span className="flex-1">{error}</span>
          <button onClick={refresh} className="text-red-200 underline text-xs">
            重试
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-gray-400">
          <Loader2 className="animate-spin" size={18} /> 加载中...
        </div>
      ) : (
        <>
          {/* Demo Gallery */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-amber-300 flex items-center gap-2">
                <Trophy size={16} /> 内置 Demo 题集（{demos.length}）
              </h2>
              <span className="text-xs text-gray-500">
                {llm?.mode === 'mock' ? 'Mock 模式：无需 key 即可演示' : 'Live LLM 模式'}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {demos.map((d) => {
                const isRunning = running === d.id
                const result = results[d.id]
                const cat = d.category
                const catColor = CATEGORY_COLORS[cat] || CATEGORY_COLORS.misc
                const isDone = result?.state === 'DONE'
                const isFailed = result?.state === 'FAILED' || result?.state === 'HUMAN_REQUIRED'
                return (
                  <div
                    key={d.id}
                    className={`bg-[#0d1426]/80 backdrop-blur border rounded-xl p-4 transition-all flex flex-col ${
                      isDone
                        ? 'border-green-500/40'
                        : isFailed
                        ? 'border-yellow-500/40'
                        : 'border-amber-500/20 hover:border-amber-500/40'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <span className={`px-2 py-0.5 text-[10px] uppercase rounded border ${catColor}`}>
                        {cat}
                      </span>
                      <div className="flex items-center gap-1 text-[10px] text-gray-500">
                        <span className="uppercase">{d.difficulty}</span>
                        <span>·</span>
                        <span>~{d.est_time_sec}s</span>
                        {d.needs_llm && (
                          <span className="ml-1 px-1 py-0.5 bg-purple-500/20 text-purple-300 rounded text-[9px]">
                            LLM
                          </span>
                        )}
                      </div>
                    </div>
                    <h3 className="font-bold text-white mb-1 text-sm">{d.title}</h3>
                    <p className="text-xs text-gray-400 flex-1 mb-3 line-clamp-3">
                      {d.description}
                    </p>
                    {result && (
                      <div
                        className={`mb-3 px-2 py-1.5 rounded text-xs font-mono border ${
                          isDone
                            ? 'bg-green-500/10 border-green-500/30 text-green-300'
                            : isFailed
                            ? 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300'
                            : 'bg-blue-500/10 border-blue-500/30 text-blue-300'
                        }`}
                      >
                        {isDone ? (
                          <span className="flex items-center gap-1">
                            <CheckCircle size={12} /> {result.flag}
                          </span>
                        ) : isFailed ? (
                          <span className="flex items-center gap-1">
                            <XCircle size={12} /> {result.state}
                            {result.error && <span className="text-red-300 ml-1">{result.error}</span>}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <Loader2 size={12} className="animate-spin" /> {result.state}...
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => runDemo(d.id)}
                        disabled={isRunning}
                        className="flex-1 px-3 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-300 text-xs font-medium hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                      >
                        {isRunning ? (
                          <>
                            <Loader2 className="animate-spin" size={12} /> 执行中
                          </>
                        ) : (
                          <>
                            <Play size={12} /> 运行
                          </>
                        )}
                      </button>
                      {result && (
                        <Link
                          to={`/ctf/${result.taskId}`}
                          className="px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/30 rounded-lg text-cyan-300 text-xs hover:bg-cyan-500/20 flex items-center gap-1"
                        >
                          详情 <ArrowRight size={12} />
                        </Link>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Task List */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-cyan-300 flex items-center gap-2">
                <Flame size={16} /> 历史任务（{tasks.length}）
              </h2>
              <button onClick={refresh} className="text-xs text-gray-500 hover:text-gray-300">
                刷新
              </button>
            </div>
            <div className="bg-[#0d1426]/80 border border-cyan-500/20 rounded-xl overflow-hidden">
              {tasks.length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-12">
                  暂无任务，先运行一个 demo 试试
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-[10px] uppercase text-gray-500 border-b border-cyan-500/20">
                      <th className="text-left px-4 py-2 font-medium">标题</th>
                      <th className="text-left px-4 py-2 font-medium">题型</th>
                      <th className="text-left px-4 py-2 font-medium">状态</th>
                      <th className="text-left px-4 py-2 font-medium">Flag</th>
                      <th className="text-right px-4 py-2 font-medium">轮次</th>
                      <th className="text-right px-4 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => (
                      <tr
                        key={t.task_id}
                        className="border-b border-[#1f2937] hover:bg-cyan-500/5"
                      >
                        <td className="px-4 py-2 text-sm text-white">{t.title}</td>
                        <td className="px-4 py-2 text-xs text-gray-400 uppercase">
                          {t.plan?.category || 'unknown'}
                        </td>
                        <td className={`px-4 py-2 text-xs font-mono ${STATE_COLORS[t.state] || 'text-gray-400'}`}>
                          {t.is_running ? 'RUNNING' : t.state}
                        </td>
                        <td className="px-4 py-2 text-xs font-mono text-green-300">
                          {t.best_flag || '-'}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-500 text-right tabular-nums">
                          {t.rounds_used}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Link
                            to={`/ctf/${t.task_id}`}
                            className="text-xs text-cyan-400 hover:text-cyan-300"
                          >
                            查看 →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {/* 新建题目 Modal */}
      {showNew && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowNew(false)}
        >
          <div
            className="bg-[#0d1426] border border-amber-500/30 rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-amber-500/20">
              <h3 className="font-bold text-white flex items-center gap-2">
                <Plus size={16} className="text-amber-400" /> 新建 CTF 题目
              </h3>
              <button
                onClick={() => { setShowNew(false); setUploadFiles([]); }}
                className="text-gray-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200/80">
                只需填写标题和题面，模型会自动识别题型（web/crypto/reverse/pwn/misc/forensics）。
                附件可直接在此上传，也可以创建后到详情页补充。
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  题目标题 <span className="text-red-400">*</span>
                </label>
                <input
                  className="w-full bg-[#1f2937] border border-[#374151] rounded-lg px-3 py-2.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-amber-500 text-sm"
                  placeholder="例如：神秘流量包"
                  value={newForm.title}
                  onChange={(e) => setNewForm({ ...newForm, title: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  题面描述 <span className="text-red-400">*</span>
                  <span className="text-gray-500 text-xs ml-2">（模型据此识别题型和思路）</span>
                </label>
                <textarea
                  className="w-full bg-[#1f2937] border border-[#374151] rounded-lg px-3 py-2.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-amber-500 text-sm min-h-[120px] resize-y font-mono"
                  placeholder={`流量包里藏着 flag，请分析这段抓包数据找出隐藏的 flag。`}
                  value={newForm.description}
                  onChange={(e) => setNewForm({ ...newForm, description: e.target.value })}
                />
              </div>

              {/* 附件上传 */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  附件 <span className="text-gray-500 text-xs ml-1">（可选，支持多文件）</span>
                </label>
                <div
                  className="border-2 border-dashed border-[#374151] rounded-lg p-3 text-center cursor-pointer hover:border-amber-500/40 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={18} className="mx-auto text-gray-500 mb-1" />
                  <p className="text-xs text-gray-400">
                    点击选择文件，或拖放附件到此处
                  </p>
                  <p className="text-[10px] text-gray-600 mt-1">
                    支持任意格式（pcap/zip/py/bin/png…），单文件 ≤ 30MB
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const files = e.target.files
                      if (files) {
                        setUploadFiles((prev) => [...prev, ...Array.from(files)])
                      }
                      // 重置 input 以便再次选择同名文件
                      e.target.value = ''
                    }}
                  />
                </div>
                {uploadFiles.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {uploadFiles.map((f, i) => (
                      <div
                        key={`${f.name}-${i}`}
                        className="flex items-center gap-2 text-xs bg-[#1f2937] border border-[#374151] rounded-lg px-3 py-1.5"
                      >
                        <Paperclip size={12} className="text-amber-400 flex-shrink-0" />
                        <span className="text-gray-300 truncate flex-1">{f.name}</span>
                        <span className="text-gray-600 flex-shrink-0">
                          {f.size < 1024 ? `${f.size}B` : f.size < 1048576 ? `${(f.size / 1024).toFixed(1)}KB` : `${(f.size / 1048576).toFixed(1)}MB`}
                        </span>
                        <button
                          onClick={() => setUploadFiles((prev) => prev.filter((_, idx) => idx !== i))}
                          className="text-gray-500 hover:text-red-400 flex-shrink-0"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    题型 <span className="text-gray-500 text-xs ml-1">（auto = 模型识别）</span>
                  </label>
                  <select
                    className="w-full bg-[#1f2937] border border-[#374151] rounded-lg px-3 py-2.5 text-gray-200 focus:outline-none focus:border-amber-500 text-sm"
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
                  <label className="block text-sm font-medium text-gray-300 mb-1.5">
                    flag 格式 <span className="text-gray-500 text-xs">（可选）</span>
                  </label>
                  <input
                    className="w-full bg-[#1f2937] border border-[#374151] rounded-lg px-3 py-2.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-amber-500 text-sm font-mono"
                    placeholder="例如 flag\\{.*\\}"
                    value={newForm.flag_format}
                    onChange={(e) => setNewForm({ ...newForm, flag_format: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newForm.authorized}
                    onChange={(e) => setNewForm({ ...newForm, authorized: e.target.checked })}
                    className="rounded bg-[#1f2937] border-[#374151]"
                  />
                  <span>已获授权</span>
                  <span className="text-gray-500 text-xs">（未授权将强制禁网）</span>
                </label>
                <label className={`flex items-center gap-2 text-sm cursor-pointer ${newForm.authorized ? 'text-gray-300' : 'text-gray-600'}`}>
                  <input
                    type="checkbox"
                    checked={newForm.allow_network && newForm.authorized}
                    disabled={!newForm.authorized}
                    onChange={(e) => setNewForm({ ...newForm, allow_network: e.target.checked })}
                    className="rounded bg-[#1f2937] border-[#374151]"
                  />
                  <span>允许联网</span>
                  <span className="text-gray-500 text-xs">（需先勾选已授权）</span>
                </label>
              </div>

              {createError && (
                <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
                  {createError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-amber-500/10">
                <button
                  onClick={() => { setShowNew(false); setUploadFiles([]); }}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                >
                  取消
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating || uploading || !newForm.title.trim() || !newForm.description.trim()}
                  className="flex items-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creating || uploading ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                  {uploading ? '上传附件中…' : creating ? '创建中…' : '创建并开始'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
