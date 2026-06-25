import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createTask, runTask, uploadFile } from '../api'
import { Upload, Play, Loader2 } from 'lucide-react'

const TASK_TYPES = [
  { value: 'web_scan', label: 'Web 扫描 (web_scan)' },
  { value: 'code_audit', label: '代码审计 (code_audit)' },
  { value: 'log_analysis', label: '日志分析 (log_analysis)' },
  { value: 'reverse_helper', label: '逆向辅助 (reverse_helper)' },
  { value: 'auto', label: '自动识别 (auto)' },
]

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-300 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

const inputCls = 'w-full bg-[#1f2937] border border-[#374151] rounded-lg px-3 py-2.5 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-cyan-500 text-sm'

export default function CreateTask() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    title: '',
    description: '',
    task_type: 'auto',
    target: '',
  })
  const [file, setFile] = useState<File | null>(null)
  const [uploadedPath, setUploadedPath] = useState('')
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFile(f)
    setUploading(true)
    try {
      const res = await uploadFile(f)
      setUploadedPath(res.data.path)
    } catch (err: any) {
      setError('文件上传失败: ' + (err?.response?.data?.detail || err.message))
    } finally {
      setUploading(false)
    }
  }

  const handleSubmit = async (autoRun: boolean) => {
    if (!form.title.trim()) {
      setError('请填写任务标题')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const payload: any = { ...form, uploaded_file: uploadedPath }
      const res = await createTask(payload)
      const taskId = res.data.id
      if (autoRun) {
        await runTask(taskId)
      }
      navigate(`/tasks/${taskId}`)
    } catch (err: any) {
      setError('创建失败: ' + (err?.response?.data?.detail || err.message))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-white mb-1">创建安全任务</h1>
      <p className="text-gray-400 text-sm mb-8">提交分析任务，Agent 将自动生成执行计划并开始工作</p>

      <div className="mb-5 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-4 py-3 text-xs text-cyan-100">
        演示模式：请使用本地样例或明确授权目标；平台默认只做只读、有限、可审计的安全分析。
      </div>

      <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-6 space-y-5">
        <Field label="任务标题 *">
          <input
            className={inputCls}
            placeholder="例如：审计 Java 项目中的水平越权风险"
            value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })}
          />
        </Field>

        <Field label="任务描述">
          <textarea
            className={inputCls + ' min-h-[80px] resize-y'}
            placeholder="描述分析目标和关注点..."
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
          />
        </Field>

        <Field label="任务类型">
          <select
            className={inputCls}
            value={form.task_type}
            onChange={e => setForm({ ...form, task_type: e.target.value })}
          >
            {TASK_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">选择 auto 时会结合描述、URL、上传文件和 ZIP 关键文件自动识别场景。</p>
        </Field>

        <Field label="目标 URL（Web 扫描时填写）">
          <input
            className={inputCls}
            placeholder="http://example.com"
            value={form.target}
            onChange={e => setForm({ ...form, target: e.target.value })}
          />
        </Field>

        <Field label="上传文件（代码审计/日志分析）">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 px-4 py-2 bg-[#1f2937] border border-[#374151] rounded-lg text-sm text-gray-300 cursor-pointer hover:border-cyan-500 transition-colors">
              <Upload size={15} />
              {file ? file.name : '选择文件'}
              <input type="file" className="hidden" onChange={handleFileChange} />
            </label>
            {uploading && <Loader2 size={16} className="animate-spin text-cyan-400" />}
            {uploadedPath && <span className="text-xs text-green-400">✓ 上传成功</span>}
          </div>
          <p className="text-xs text-gray-500 mt-1">支持 .zip .java .js .log .txt 等，最大 50MB；上传路径会作为 uploaded_file 单独提交。</p>
          {uploadedPath && (
            <div className="mt-2 rounded border border-[#374151] bg-[#0b1220] px-3 py-2 text-xs text-gray-400 break-all">
              <span className="text-gray-500">uploaded_file</span> {uploadedPath}
            </div>
          )}
        </Field>

        {error && (
          <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#1f2937] border border-[#374151] rounded-lg text-sm text-gray-300 hover:bg-[#374151] transition-colors disabled:opacity-50"
            disabled={submitting}
            onClick={() => handleSubmit(false)}
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : null}
            保存草稿
          </button>
          <button
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-cyan-500 rounded-lg text-sm text-white font-medium hover:bg-cyan-400 transition-colors disabled:opacity-50"
            disabled={submitting}
            onClick={() => handleSubmit(true)}
          >
            <Play size={15} />
            {submitting ? '处理中...' : '创建并运行'}
          </button>
        </div>
      </div>
    </div>
  )
}
