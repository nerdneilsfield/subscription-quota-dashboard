// Formatting helpers for dashboard values. Rules per spec:
//  - formatNumber: <1000 rounded raw; <1_000_000 locale thousands; >=1_000_000 compact 1-decimal.
//  - formatBurnRate: two decimals + "/h".
//  - formatPercentUsed: Math.round; overflow shows ">100%".
//  - formatRelativeTime: human buckets relative to `now`.

import { formatRelativeTimeText, getTranslator, type Locale } from "./i18n"

/** Mask account identifiers while keeping email structure recognizable. */
export function maskAccount(value: string): string {
  const account = value.trim()
  if (!account) return value
  const at = account.lastIndexOf("@")
  if (at > 0 && at < account.length - 1) {
    const local = maskPart(account.slice(0, at), 2, 2)
    const domain = maskDomain(account.slice(at + 1))
    return `${local}@${domain}`
  }
  return maskPart(account, 2, 2)
}

function maskDomain(domain: string): string {
  const labels = domain.split(".")
  const host = labels.shift() ?? ""
  return `${maskPart(host, 2, 1)}${labels.length > 0 ? `.${labels.join(".")}` : ""}`
}

function maskPart(value: string, keepStart: number, keepEnd: number): string {
  if (value.length <= 1) return value ? "•" : value
  if (value.length <= keepStart + keepEnd) return `${value.slice(0, 1)}${"•".repeat(value.length - 1)}`
  return `${value.slice(0, keepStart)}${"•".repeat(value.length - keepStart - keepEnd)}${value.slice(-keepEnd)}`
}

export function formatNumber(value: number, locale: Locale = "en"): string {
  if (value < 1000) return String(Math.round(value))
  const intlLocale = locale === "zh-CN" ? "zh-CN" : "en-US"
  if (value < 1_000_000) return Math.round(value).toLocaleString(intlLocale)
  return value.toLocaleString(intlLocale, {
    notation: "compact",
    maximumFractionDigits: 1,
  })
}

export function formatBurnRate(value: number): string {
  return `${value.toFixed(2)}/h`
}

export function formatPercentUsed(percent: number, overflow: boolean): string {
  if (overflow) return ">100%"
  return `${Math.round(percent)}%`
}

export function formatRelativeTime(iso: string, now: Date, locale: Locale = "en"): string {
  return formatRelativeTimeText(iso, now, getTranslator(locale))
}

export function formatResetAt(iso: string, timezone: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "shortOffset",
    })
  } catch {
    return formatResetAt(iso, "UTC")
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName}`
}

export function formatCountdown(iso: string, now: Date, locale: Locale = "en"): string {
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return "—"
  const totalSeconds = Math.max(0, Math.ceil((target - now.getTime()) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const paddedMinutes = String(minutes).padStart(2, "0")
  const paddedSeconds = String(seconds).padStart(2, "0")
  return locale === "zh-CN"
    ? `${hours}小时 ${paddedMinutes}分 ${paddedSeconds}秒`
    : `${hours}h ${paddedMinutes}m ${paddedSeconds}s`
}
