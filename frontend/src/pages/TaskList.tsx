import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getTasks, runTask, type Task } from '../api'
import { Play, Eye, FileText, RefreshCw, ListTodo } from 'lucide-react'
import { statusStyle } from '../styles/tokens'
import { Surface, GlowButton, StatusBadge, SectionHeader, EmptyState, LoadingState } from '../components/ui'
import { PageHeader } from '../components/layout'

const TYPE_LABELS: Record<string, string> = {
  web_scan: 'Web扫描', code_audit: '代码审计', log_analysis: '日志分析',
  reverse_helper: '逆向辅助', auto: '自动',
}

export default function TaskList() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [runningId, setRunningId] = useState<number | null>(null)

  const load = () => { setLoading(true); getTasks().then((r) => setTasks(r.data)).finally(() => setLoading(false)) }

  useEffect(() => {
    load()
    const iv = setInterval(load, 5000)
    return () => clearInterval(iv)
  }, [])

  const handleRun = async (task: Task) => {
    setRunningId(task.id)
    try { await runTask(task.id); setTimeout(load, 1000) } finally { setRunningId(null) }
  }

  return (
    <div className="p-6 md:p-8 max-w-[1440px] mx-auto">
      <PageHeader
        title="任务编排"
        subtitle={`共 ${tasks.length} 个任务`}
        icon={<ListTodo size={20} className="text-ember-400" />}
        action={
          <div className="flex items-center gap-2">
            <GlowButton variant="secondary" onClick={load} size="sm">
              <RefreshCw size={13} /> 刷新
            </GlowButton>
            <Link to="/tasks/new">
              <GlowButton size="sm">+ 新建任务</GlowButton>
            </Link>
          </div>
        }
      />

      {loading && tasks.length === 0 ? (
        <LoadingState message="加载任务" />
      ) : tasks.length === 0 ? (
        <EmptyState title="暂无任务" description="创建第一个任务开始" action="新建任务" onAction={() => window.location.href = '/tasks/new'} />
      ) : (
        <Surface variant="panel" className="overflow-hidden">
          <div className="flex items-center gap-4 px-5 py-2.5 border-b border-obsidian-600/30 text-[10px] uppercase tracking-wider text-slate-500 font-medium">
            <span className="w-10">ID</span>
            <span className="flex-1">标题</span>
            <span className="w-20 text-center">类型</span>
            <span className="w-20 text-center">状态</span>
            <span className="w-28">创建时间</span>
            <span className="w-16" />
          </div>
          {tasks.map((task) => (
            <div key={task.id} className="flex items-center gap-4 px-5 py-3 border-b border-obsidian-600/20 last:border-0 hover:bg-obsidian-800/40 transition-colors group">
              <span className="w-10 text-xs text-slate-500">#{task.id}</span>
              <Link to={`/tasks/${task.id}`} className="flex-1 text-sm text-white truncate hover:text-ember-400 transition-colors">
                {task.title}
              </Link>
              <span className="w-20 text-xs text-slate-400 text-center">{TYPE_LABELS[task.task_type] || task.task_type}</span>
              <span className="w-20"><StatusBadge state={task.status} /></span>
              <span className="w-28 text-xs text-slate-500">{new Date(task.created_at).toLocaleString('zh-CN')}</span>
              <div className="w-16 flex items-center gap-1">
                <Link to={`/tasks/${task.id}`} className="p-1.5 rounded hover:bg-obsidian-700/40 text-slate-400 hover:text-white" title="查看详情">
                  <Eye size={14} />
                </Link>
                {(task.status === 'created' || task.status === 'failed') && (
                  <button onClick={() => handleRun(task)} disabled={runningId === task.id} className="p-1.5 rounded hover:bg-obsidian-700/40 text-cyan-400 hover:text-cyan-300 disabled:opacity-50" title="运行任务">
                    <Play size={14} />
                  </button>
                )}
                {task.status === 'completed' && (
                  <Link to={`/tasks/${task.id}/report`} className="p-1.5 rounded hover:bg-obsidian-700/40 text-jade-400 hover:text-jade-300" title="查看报告">
                    <FileText size={14} />
                  </Link>
                )}
              </div>
            </div>
          ))}
        </Surface>
      )}
    </div>
  )
}
