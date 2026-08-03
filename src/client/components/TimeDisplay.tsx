import { formatRelativeTime } from "../format"
import { useI18n } from "../i18n"

interface TimeDisplayProps {
  iso: string
  now: Date
  overdueIfPast?: boolean
  prefix?: string
}

export function TimeDisplay({ iso, now, overdueIfPast, prefix }: TimeDisplayProps) {
  const { locale, t } = useI18n()
  const target = new Date(iso).getTime()
  const isPast = target < now.getTime()
  const text = overdueIfPast && isPast ? t("formatOverdue") : formatRelativeTime(iso, now, locale)
  return (
    <time dateTime={iso} title={iso}>
      {prefix ? `${prefix} ${text}` : text}
    </time>
  )
}
