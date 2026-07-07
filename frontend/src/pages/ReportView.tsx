import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { getReport, type Report } from '../api'
import { PageHeader } from '../components/layout'
import { Surface, GlowButton, LoadingState, ErrorState } from '../components/ui'
import { ArrowLeft, Download, ExternalLink, ScrollText } from 'lucide-react'

export default function ReportView() {
  const { id } = useParams<{ id: string }>()
  const taskId = Number(id)
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    getReport(taskId)
      .then(r => setReport(r.data))
      .catch(() => setError('报告未找到，请确认任务已完成'))
      .finally(() => setLoading(false))
  }, [taskId])

  const handleDownload = () => {
    if (!report) return
    const blob = new Blob([report.content], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `task_${taskId}_report.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <LoadingState />

  return (
    <div className="space-y-6">
      <PageHeader
        title="安全分析报告"
        subtitle={`任务 #${taskId} — 烛龙智能体深度分析输出`}
        action={
          <div className="flex gap-2">
            <a
              href={`/api/tasks/${taskId}/report/html`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <GlowButton variant="secondary" size="sm">
                <ExternalLink size={14} /> HTML
              </GlowButton>
            </a>
            <GlowButton variant="secondary" size="sm" onClick={handleDownload}>
              <Download size={14} /> 下载 MD
            </GlowButton>
          </div>
        }
      />

      {error ? (
        <ErrorState title="报告不可用" detail={error} onRetry={() => window.location.reload()} />
      ) : report ? (
        <Surface variant="panel" className="p-8">
          <div className="flex items-center gap-2 mb-6 pb-4 border-b border-obsidian-700">
            <ScrollText size={18} className="text-ember-400" />
            <span className="text-sm text-gray-400">
              生成时间：{new Date(report.created_at).toLocaleString('zh-CN')}
            </span>
          </div>
          <div className="prose prose-invert prose-ember max-w-none
            prose-headings:text-ember-400 prose-headings:border-b prose-headings:border-obsidian-700 prose-headings:pb-2
            prose-a:text-cyan-400 prose-a:no-underline hover:prose-a:underline
            prose-code:text-ember-300 prose-code:bg-obsidian-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded
            prose-pre:bg-obsidian-950 prose-pre:border prose-pre:border-obsidian-700
            prose-strong:text-ember-300
            prose-li:marker:text-ember-500
          ">
            <ReactMarkdown>{report.content}</ReactMarkdown>
          </div>
        </Surface>
      ) : null}

      <div className="flex justify-start">
        <Link to={`/tasks/${taskId}`}>
          <GlowButton variant="secondary" size="sm">
            <ArrowLeft size={14} /> 返回任务详情
          </GlowButton>
        </Link>
      </div>
    </div>
  )
}
