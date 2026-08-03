// Formatting helpers for dashboard values. Rules per spec:
//  - formatNumber: <1000 rounded raw; <1_000_000 locale thousands; >=1_000_000 compact 1-decimal.
//  - formatBurnRate: two decimals + "/h".
//  - formatPercentUsed: Math.round; overflow shows ">100%".
//  - formatRelativeTime: human buckets relative to `now`.

import { formatRelativeTimeText, getTranslator, type Locale } from "./i18n"

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
