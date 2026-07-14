export type Tone = 'ember' | 'cyan' | 'violet' | 'jade' | 'crimson' | 'slate'

export interface ToneClass {
  bg: string
  text: string
  border: string
  dot: string
  ring: string
}

export const toneClass: Record<Tone, ToneClass> = {
  ember: {
    bg: 'bg-ember-500/10',
    text: 'text-ember-300',
    border: 'border-ember-500/30',
    dot: 'bg-ember-400',
    ring: 'ring-ember-500/20',
  },
  cyan: {
    bg: 'bg-cyan-500/10',
    text: 'text-cyan-300',
    border: 'border-cyan-500/30',
    dot: 'bg-cyan-400',
    ring: 'ring-cyan-500/20',
  },
  violet: {
    bg: 'bg-violet-500/10',
    text: 'text-violet-300',
    border: 'border-violet-500/30',
    dot: 'bg-violet-400',
    ring: 'ring-violet-500/20',
  },
  jade: {
    bg: 'bg-jade-500/10',
    text: 'text-jade-300',
    border: 'border-jade-500/30',
    dot: 'bg-jade-400',
    ring: 'ring-jade-500/20',
  },
  crimson: {
    bg: 'bg-crimson-500/10',
    text: 'text-crimson-300',
    border: 'border-crimson-500/30',
    dot: 'bg-crimson-400',
    ring: 'ring-crimson-500/20',
  },
  slate: {
    bg: 'bg-slate-500/10',
    text: 'text-slate-300',
    border: 'border-slate-500/20',
    dot: 'bg-slate-400',
    ring: 'ring-slate-500/15',
  },
}

export const ctfStateLabel: Record<string, string> = {
  INIT: '初始化',
  CLASSIFY: '题型识别',
  PLAN: '规划',
  ANALYZE_FILES: '附件分析',
  AGENT_THINK: '推理中',
  GENERATE_SCRIPT: '生成脚本',
  RUN_SCRIPT: '沙箱执行',
  RUN_SHELL: '命令执行',
  REFLECT_ERROR: '反思修复',
  VERIFY_FLAG: '校验 Flag',
  GENERATE_WRITEUP: '生成 WP',
  DONE: '已解决',
  FAILED: '失败',
  HUMAN_REQUIRED: '人工接管',
  RUNNING: '执行中',
  PENDING: '待命',
}

export const finalStatusLabel: Record<string, string> = {
  new: '待处理',
  triaging: '分诊中',
  running: '处理中',
  need_human: '待复核',
  candidate_found: '有候选',
  submitted: '已提交',
  solved: '已解决',
  accepted: 'Accepted',
  rejected: 'Rejected',
  blocked: '受阻',
  paused: '暂停',
  cancelled: '取消',
}

export function toneForState(state?: string | null): Tone {
  const value = (state || '').toLowerCase()
  if (['done', 'completed', 'solved', 'accepted', 'success'].includes(value)) return 'jade'
  if (['running', 'triaging', 'analyzing', 'agent_think', 'run_shell', 'run_script'].includes(value)) return 'cyan'
  if (['plan', 'classify', 'generate_script', 'reflect_error', 'paused'].includes(value)) return 'violet'
  if (['verify_flag', 'candidate_found', 'submitted', 'waiting'].includes(value)) return 'ember'
  if (['failed', 'error', 'human_required', 'need_human', 'blocked', 'rejected', 'cancelled'].includes(value)) return 'crimson'
  return 'slate'
}

export function toneForRisk(risk?: string | null): Tone {
  const value = (risk || '').toLowerCase()
  if (['high', 'critical', 'danger'].includes(value)) return 'crimson'
  if (['medium', 'moderate'].includes(value)) return 'ember'
  if (['low', 'safe'].includes(value)) return 'jade'
  return 'slate'
}

export function categoryTone(category?: string | null): Tone {
  const value = (category || '').toLowerCase()
  if (value.includes('web') || value.includes('network') || value.includes('pcap')) return 'cyan'
  if (value.includes('crypto') || value.includes('reverse')) return 'violet'
  if (value.includes('pwn') || value.includes('exploit')) return 'crimson'
  if (value.includes('forensic') || value.includes('misc')) return 'jade'
  return 'ember'
}
