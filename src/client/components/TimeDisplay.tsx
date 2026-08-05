import { useEffect, useState } from "react"
import { formatCountdown, formatRelativeTime, formatResetAt } from "../format"
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

interface ResetTimeDisplayProps {
  iso: string | undefined
  now: Date
  timezone: string | undefined
}

export function ResetTimeDisplay({ iso, now, timezone = "UTC" }: ResetTimeDisplayProps) {
  const { locale, t } = useI18n()
  const [current, setCurrent] = useState(now)

  useEffect(() => {
    if (!iso) return
    const baseNow = now.getTime()
    const startedAt = Date.now()
    setCurrent(now)
    const timer = window.setInterval(() => {
      setCurrent(new Date(baseNow + Date.now() - startedAt))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [iso, now])

  if (!iso) return <span className="reset-time reset-time--missing">{t("resetNotReported")}</span>

  return (
    <span className="reset-time">
      <time dateTime={iso} title={`${iso} (${timezone})`}>{t("resetAt")}: {formatResetAt(iso, timezone)}</time>
      <span>{t("timeRemaining")}: {formatCountdown(iso, current, locale)}</span>
    </span>
  )
}
