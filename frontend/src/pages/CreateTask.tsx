import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createTask, runTask, uploadFile } from '../api'
import { PageHeader } from '../components/layout'
import { Surface, GlowButton, SectionHeader } from '../components/ui'
import { Upload, Play, Loader2, Shield, FileCode, Globe, FileSearch, Cpu, Sparkles } from 'lucide-react'

const TASK_TYPES = [
  { value: 'web_scan', label: 'Web 扫描', icon: Globe, desc: '对 Web 目标进行安全扫描' },
  { value: 'code_audit', label: '代码审计', icon: FileCode, desc: '静态分析源码安全风险' },
  { value: 'log_analysis', label: '日志分析', icon: FileSearch, desc: '分析日志中的异常行为' },
  { value: 'reverse_helper', label: '逆向辅助', icon: Cpu, desc: '辅助二进制/固件逆向' },
  { value: 'auto', label: '自动识别', icon: Sparkles, desc: '智能体自动判断分析类型' },
]

function FieldType({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-sm font-medium text-ember-400">{label}</label>
      {children}
    </div>
  )
}

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
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title="部署任务"
        subtitle="向烛龙智能体下达安全分析指令"
      />

      <Surface variant="glass" className="p-4 flex items-start gap-3">
        <Shield size={16} className="text-ember-400 mt-0.5 shrink-0" aria-hidden="true" />
        <p className="text-xs text-ember-300/80 leading-relaxed">
          安全边界：平台默认只做只读、有限、可审计的安全分析。请使用本地样例或明确授权目标。
        </p>
      </Surface>

      <Surface variant="panel" className="p-6 space-y-5">
        <SectionHeader title="任务配置" />

        <FieldType label="任务标题 *">
          <input
            className="input"
            placeholder="例如：审计 Java 项目中的水平越权风险"
            value={form.title}
            onChange={e => setForm({ ...form, title: e.target.value })}
          />
        </FieldType>

        <FieldType label="任务描述">
          <textarea
            className="input min-h-[80px] resize-y"
            placeholder="描述分析目标和关注点..."
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
          />
        </FieldType>

        <FieldType label="任务类型">
          <select
            className="input appearance-none cursor-pointer"
            value={form.task_type}
            onChange={e => setForm({ ...form, task_type: e.target.value })}
          >
            {TASK_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3" role="radiogroup" aria-label="任务类型选择">
            {TASK_TYPES.map(t => {
              const Icon = t.icon
              const active = form.task_type === t.value
              return (
                <button
                  key={t.value}
                  role="radio"
                  aria-checked={active}
                  onClick={() => setForm({ ...form, task_type: t.value })}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs transition-all
                    ${active
                      ? 'border-ember-500/50 bg-ember-500/10 text-ember-300'
                      : 'border-obsidian-700 bg-obsidian-800 text-gray-500 hover:text-gray-400'
                    }`}
                >
                  <Icon size={14} className={active ? 'text-ember-400' : 'text-gray-600'} aria-hidden="true" />
                  {t.label}
                </button>
              )
            })}
          </div>
        </FieldType>

        <FieldType label="目标 URL（Web 扫描时填写）">
          <input
            className="input"
            placeholder="http://example.com"
            value={form.target}
            onChange={e => setForm({ ...form, target: e.target.value })}
          />
        </FieldType>

        <FieldType label="上传文件（代码审计/日志分析）">
          <div className="flex items-center gap-3">
            <label className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm cursor-pointer transition-all
              border border-obsidian-700 bg-obsidian-800 text-gray-300
              hover:border-ember-500/50 hover:bg-obsidian-700`}>
              <Upload size={15} className="text-ember-400" aria-hidden="true" />
              {file ? file.name : '选择文件'}
              <input type="file" className="hidden" onChange={handleFileChange} aria-label="选择上传文件" />
            </label>
            {uploading && <Loader2 size={16} className="animate-spin text-ember-400" aria-label="上传中" />}
            {uploadedPath && <span className="text-xs text-jade-400" aria-live="polite">已上传</span>}
          </div>
          <p className="text-xs text-slate-600 mt-1">支持 .zip .java .js .log .txt 等，最大 50MB</p>
          {uploadedPath && (
            <div className="mt-2 rounded border border-obsidian-700 bg-obsidian-950 px-3 py-2 text-xs text-slate-500 break-all font-mono">
              {uploadedPath}
            </div>
          )}
        </FieldType>

        {error && (
          <div className="p-3 text-sm text-crimson-400" role="alert">
            <Surface variant="danger">
            {error}
            </Surface>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <GlowButton
            variant="secondary"
            className="flex-1"
            disabled={submitting}
            onClick={() => handleSubmit(false)}
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : null}
            保存草稿
          </GlowButton>
          <GlowButton
            variant="primary"
            className="flex-1"
            disabled={submitting}
            onClick={() => handleSubmit(true)}
          >
            <Play size={15} />
            {submitting ? '部署中...' : '创建并运行'}
          </GlowButton>
        </div>
      </Surface>
    </div>
  )
}
