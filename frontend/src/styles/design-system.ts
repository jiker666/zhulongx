import type { Tone } from '../lib/status'

export const pipelineStages = [
  { key: 'read', label: '题面读取', tone: 'ember' as Tone },
  { key: 'classify', label: '题型分类', tone: 'violet' as Tone },
  { key: 'plan', label: '计划生成', tone: 'violet' as Tone },
  { key: 'analyze', label: '文件分析', tone: 'cyan' as Tone },
  { key: 'tools', label: '工具调用', tone: 'cyan' as Tone },
  { key: 'sandbox', label: '沙箱执行', tone: 'crimson' as Tone },
  { key: 'flag', label: 'Flag 校验', tone: 'jade' as Tone },
  { key: 'writeup', label: 'WP 生成', tone: 'ember' as Tone },
]

export const capabilitySet = [
  { key: 'web', label: 'Web', tone: 'cyan' as Tone },
  { key: 'crypto', label: 'Crypto', tone: 'violet' as Tone },
  { key: 'reverse', label: 'Reverse', tone: 'ember' as Tone },
  { key: 'pwn', label: 'Pwn', tone: 'crimson' as Tone },
  { key: 'misc', label: 'Misc', tone: 'jade' as Tone },
  { key: 'forensics', label: 'Forensics', tone: 'cyan' as Tone },
]

export const designCopy = {
  promise:
    '从题面到 flag，不只自动执行，更能解释每一步为什么可信。',
  safety:
    '默认拒绝非授权目标，危险动作必须落在 ScopeGuard 与沙箱边界内。',
  judge:
    '题目理解、任务规划、工具调用、沙箱执行、失败反思、证据留存、候选 flag 与中文 WP 生成在同一条链路中闭环。',
}
