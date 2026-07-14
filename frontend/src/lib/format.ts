export function formatPercent(value: number, digits = 0) {
  if (!Number.isFinite(value)) return '0%'
  return `${value.toFixed(digits)}%`
}

export function formatDuration(msOrSeconds: number, input: 'ms' | 's' = 'ms') {
  const seconds = input === 'ms' ? Math.round(msOrSeconds / 1000) : Math.round(msOrSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const min = minutes % 60
  return min ? `${hours}h ${min}m` : `${hours}h`
}

export function formatTime(ts?: number | string | null) {
  if (!ts) return '-'
  const date = typeof ts === 'number' ? new Date(ts > 10_000_000_000 ? ts : ts * 1000) : new Date(ts)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function compactNumber(value: number) {
  if (!Number.isFinite(value)) return '0'
  return new Intl.NumberFormat('zh-CN', { notation: value > 9999 ? 'compact' : 'standard' }).format(value)
}

export function shortHash(value?: string | null, length = 8) {
  if (!value) return '-'
  return value.length > length ? `${value.slice(0, length)}...` : value
}
