import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { getReport, Report } from '../api'
import { Loader2, ArrowLeft, Download, ExternalLink } from 'lucide-react'

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

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link to={`/tasks/${taskId}`} className="p-1.5 rounded hover:bg-[#1f2937] text-gray-400 hover:text-gray-200">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-xl font-bold text-white">安全分析报告</h1>
            <p className="text-gray-400 text-sm mt-0.5">任务 #{taskId}</p>
          </div>
        </div>
        {report && (
          <div className="flex gap-2">
            <a
              href={`/api/tasks/${taskId}/report/html`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1f2937] border border-[#374151] rounded-lg text-sm text-gray-300 hover:bg-[#374151]"
            >
              <ExternalLink size={14} /> HTML
            </a>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1f2937] border border-[#374151] rounded-lg text-sm text-gray-300 hover:bg-[#374151]"
            >
              <Download size={14} /> 下载 MD
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-gray-400">
          <Loader2 className="animate-spin" size={18} /> 加载中...
        </div>
      ) : error ? (
        <div className="text-red-400 bg-red-400/10 border border-red-400/20 rounded-xl p-6">{error}</div>
      ) : report ? (
        <div className="bg-[#111827] border border-[#1f2937] rounded-xl p-8">
          <div className="prose prose-invert max-w-none">
            <ReactMarkdown>{report.content}</ReactMarkdown>
          </div>
        </div>
      ) : null}
    </div>
  )
}
