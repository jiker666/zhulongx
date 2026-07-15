import { History } from 'lucide-react'
import { type AuditEntry } from '../../api'
import { formatTime } from '../../lib/format'
import { DataEmpty, GlassPanel } from '../ui'

interface AuditLogTimelineProps {
  entries: AuditEntry[]
}

export default function AuditLogTimeline({ entries }: AuditLogTimelineProps) {
  return (
    <GlassPanel tone="slate">
      <div className="mb-4 flex items-center gap-2">
        <History size={16} className="text-slate-300" />
        <h2 className="text-lg font-semibold text-white">Audit Log</h2>
      </div>
      {entries.length === 0 ? (
        <DataEmpty title="暂无配置变更记录" />
      ) : (
        <div className="space-y-2">
          {entries.slice(0, 16).map((entry, index) => (
            <div key={`${entry.ts}-${entry.field}-${index}`} className="rounded-lg border border-slate-800 bg-obsidian-950/45 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-slate-500">{formatTime(entry.ts)}</span>
                <span className="text-ember-300">{entry.field}</span>
                <span className="text-slate-500">by {entry.actor}</span>
              </div>
              <div className="mt-1 break-all font-mono text-[11px] text-slate-400">{entry.old} → <span className="text-jade-300">{entry.new}</span></div>
            </div>
          ))}
        </div>
      )}
    </GlassPanel>
  )
}
