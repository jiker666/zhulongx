import { type RefObject } from 'react'
import { CheckCircle2, Loader2, Paperclip, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { GlassPanel, GlowButton, StatePill } from '../ui'

export interface ChallengeCreateForm {
  title: string
  description: string
  category: string
  flag_format: string
  authorized: boolean
  allow_network: boolean
}

interface ImportChallengePanelProps {
  form: ChallengeCreateForm
  files: File[]
  createError: string
  creating: boolean
  uploading: boolean
  fileInputRef: RefObject<HTMLInputElement>
  onFormChange: (form: ChallengeCreateForm) => void
  onFilesChange: (files: File[]) => void
  onCreate: () => void
}

function fileSize(size: number) {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
  return `${(size / 1024 / 1024).toFixed(1)}MB`
}

export default function ImportChallengePanel({
  form,
  files,
  createError,
  creating,
  uploading,
  fileInputRef,
  onFormChange,
  onFilesChange,
  onCreate,
}: ImportChallengePanelProps) {
  return (
    <GlassPanel tone="ember" className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-ember-300">Quick Import</div>
          <h2 className="mt-1 text-lg font-semibold text-white">导入第一手题面</h2>
          <p className="mt-1 text-xs leading-5 text-slate-400">填题面、附件、flag 格式与授权状态，Agent 会在详情页继续推理。</p>
        </div>
        <StatePill tone={form.authorized ? 'jade' : 'ember'} icon={<ShieldCheck size={13} />}>
          {form.authorized ? '授权' : '禁网'}
        </StatePill>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-slate-300">题目标题</span>
          <input className="input" value={form.title} onChange={(e) => onFormChange({ ...form, title: e.target.value })} placeholder="例如 神秘流量包" />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-slate-300">flag 格式</span>
          <input className="input font-mono" value={form.flag_format} onChange={(e) => onFormChange({ ...form, flag_format: e.target.value })} placeholder="flag\\{.*\\}" />
        </label>
      </div>

      <label className="space-y-1.5">
        <span className="text-xs font-medium text-slate-300">题面描述</span>
        <textarea className="input min-h-[132px] resize-y font-mono leading-6" value={form.description} onChange={(e) => onFormChange({ ...form, description: e.target.value })} placeholder="把题面、附件提示、目标说明、授权范围写在这里。" />
      </label>

      <div className="grid gap-3 md:grid-cols-[1fr_180px]">
        <div>
          <button
            type="button"
            className="flex w-full flex-col items-center justify-center rounded-lg border border-dashed border-slate-700 bg-obsidian-950/40 px-4 py-5 text-center transition hover:border-ember-400/50"
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={18} className="text-ember-300" />
            <span className="mt-2 text-xs text-slate-300">上传附件</span>
            <span className="mt-1 text-[11px] text-slate-600">pcap / zip / py / bin / image</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) onFilesChange([...files, ...Array.from(event.target.files)])
              event.target.value = ''
            }}
          />
        </div>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-slate-300">题型</span>
          <select className="input" value={form.category} onChange={(e) => onFormChange({ ...form, category: e.target.value })}>
            <option value="auto">auto</option>
            <option value="web">web</option>
            <option value="crypto">crypto</option>
            <option value="reverse">reverse</option>
            <option value="pwn">pwn</option>
            <option value="misc">misc</option>
            <option value="forensics">forensics</option>
          </select>
          <label className="mt-3 flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={form.authorized} onChange={(e) => onFormChange({ ...form, authorized: e.target.checked, allow_network: e.target.checked ? form.allow_network : false })} className="accent-ember-500" />
            已获授权
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input type="checkbox" checked={form.allow_network && form.authorized} disabled={!form.authorized} onChange={(e) => onFormChange({ ...form, allow_network: e.target.checked })} className="accent-ember-500 disabled:opacity-40" />
            允许联网
          </label>
        </label>
      </div>

      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((file, index) => (
            <div key={`${file.name}-${index}`} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-obsidian-950/40 px-3 py-2 text-xs">
              <Paperclip size={12} className="flex-shrink-0 text-ember-300" />
              <span className="min-w-0 flex-1 truncate text-slate-300">{file.name}</span>
              <span className="text-slate-600">{fileSize(file.size)}</span>
              <button type="button" className="text-slate-500 hover:text-crimson-300" onClick={() => onFilesChange(files.filter((_, i) => i !== index))} aria-label={`移除 ${file.name}`}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {createError && <div className="rounded-lg border border-crimson-500/25 bg-crimson-500/10 px-3 py-2 text-xs text-crimson-300">{createError}</div>}

      <GlowButton onClick={onCreate} disabled={creating || uploading || !form.title.trim() || !form.description.trim()} className="w-full">
        {uploading ? <><Loader2 size={14} className="animate-spin" /> 上传附件中</> : creating ? <><Loader2 size={14} className="animate-spin" /> 创建中</> : <><CheckCircle2 size={14} /> 创建题目并进入驾驶舱</>}
      </GlowButton>
    </GlassPanel>
  )
}
