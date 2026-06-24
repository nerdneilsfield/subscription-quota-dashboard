import { formatRelativeTime } from "../format"

interface TimeDisplayProps {
  iso: string
  now: Date
  overdueIfPast?: boolean
  prefix?: string
}

export function TimeDisplay({ iso, now, overdueIfPast, prefix }: TimeDisplayProps) {
  const target = new Date(iso).getTime()
  const isPast = target < now.getTime()
  const text = overdueIfPast && isPast ? "overdue" : formatRelativeTime(iso, now)
  return (
    <time dateTime={iso} title={iso}>
      {prefix ? `${prefix} ${text}` : text}
    </time>
  )
}
