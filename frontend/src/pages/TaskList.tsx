import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getTasks, runTask, Task } from '../api'
import { Play, Eye, FileText, Loader2, RefreshCw } from 'lucide-react'

const STATUS_COLORS: Record<string, string> = {
  created: 'bg-gray-700 text-gray-300',
  planning: 'bg-blue-500/20 text-blue-400',
  running: 'bg-yellow-500/20 text-yellow-400',
  waiting_confirmation: 'bg-yellow-500/20 text-yellow-400',
  completed: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
}
const STATUS_LABELS: Record<string, string> = {
  created: '已创建', planning: '规划中', running: '执行中', completed: '已完成', failed: '失败',
  waiting_confirmation: '等待确认',
}
const TYPE_LABELS: Record<string, string> = {
  web_scan: 'Web扫描', code_audit: '代码审计', log_analysis: '日志分析',
  reverse_helper: '逆向辅助', auto: '自动',
}

export default function TaskList() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [runningId, setRunningId] = useState<number | null>(null)

  const load = () => {
    setLoading(true)
    getTasks().then(r => setTasks(r.data)).finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    const interval = setInterval(load, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleRun = async (task: Task) => {
    setRunningId(task.id)
    try {
      await runTask(task.id)
      setTimeout(load, 1000)
    } finally {
      setRunningId(null)
    }
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">任务列表</h1>
          <p className="text-gray-400 text-sm mt-1">共 {tasks.length} 个任务</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1f2937] border border-[#374151] rounded-lg text-sm text-gray-300 hover:bg-[#374151]">
            <RefreshCw size={14} />刷新
          </button>
          <Link to="/tasks/new" className="flex items-center gap-1.5 px-4 py-1.5 bg-cyan-500 rounded-lg text-sm text-white font-medium hover:bg-cyan-400">
            + 新建任务
          </Link>
        </div>
      </div>

      <div className="bg-[#111827] border border-[#1f2937] rounded-xl overflow-hidden">
        {loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-gray-500">
            <Loader2 className="animate-spin mr-2" size={18} /> 加载中...
          </div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            暂无任务，<Link to="/tasks/new" className="text-cyan-400">创建第一个</Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-[#1f2937]">
              <tr className="text-gray-500 text-left">
                <th className="px-5 py-3 font-medium">ID</th>
                <th className="px-5 py-3 font-medium">标题</th>
                <th className="px-5 py-3 font-medium">类型</th>
                <th className="px-5 py-3 font-medium">状态</th>
                <th className="px-5 py-3 font-medium">创建时间</th>
                <th className="px-5 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1f2937]">
              {tasks.map(task => (
                <tr key={task.id} className="hover:bg-[#1f2937]/30 transition-colors">
                  <td className="px-5 py-3 text-gray-500">#{task.id}</td>
                  <td className="px-5 py-3 text-gray-200 max-w-[240px]">
                    <Link to={`/tasks/${task.id}`} className="hover:text-cyan-400 truncate block">
                      {task.title}
                    </Link>
                  </td>
                  <td className="px-5 py-3 text-gray-400">{TYPE_LABELS[task.task_type] || task.task_type}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${STATUS_COLORS[task.status]}`}>
                      {STATUS_LABELS[task.status] || task.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-gray-500 text-xs">
                    {new Date(task.created_at).toLocaleString('zh-CN')}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2">
                      <Link to={`/tasks/${task.id}`} className="p-1.5 rounded hover:bg-[#374151] text-gray-400 hover:text-gray-200" title="查看详情">
                        <Eye size={14} />
                      </Link>
                      {(task.status === 'created' || task.status === 'failed') && (
                        <button
                          onClick={() => handleRun(task)}
                          disabled={runningId === task.id}
                          className="p-1.5 rounded hover:bg-[#374151] text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
                          title="运行任务"
                        >
                          {runningId === task.id ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                        </button>
                      )}
                      {task.status === 'completed' && (
                        <Link to={`/tasks/${task.id}/report`} className="p-1.5 rounded hover:bg-[#374151] text-green-400 hover:text-green-300" title="查看报告">
                          <FileText size={14} />
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
