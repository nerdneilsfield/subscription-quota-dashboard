// Formatting helpers for dashboard values. Rules per spec:
//  - formatNumber: <1000 rounded raw; <1_000_000 locale thousands; >=1_000_000 compact 1-decimal.
//  - formatBurnRate: two decimals + "/h".
//  - formatPercentUsed: Math.round; overflow shows ">100%".
//  - formatRelativeTime: human buckets relative to `now`.

export function formatNumber(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return Math.round(value).toLocaleString()
  return value.toLocaleString(undefined, {
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

export function formatRelativeTime(iso: string, now: Date): string {
  const target = new Date(iso).getTime()
  const diffMs = target - now.getTime()
  const abs = Math.abs(diffMs)
  const secs = abs / 1000
  const mins = secs / 60
  const hours = mins / 60
  const days = hours / 24
  const future = diffMs >= 0
  const fmt = (qty: number, unit: string): string => {
    const q = Math.max(1, Math.round(qty))
    return future ? `in ${q}${unit}` : `${q}${unit} ago`
  }
  if (secs < 60) return fmt(secs, "s")
  if (mins < 60) return fmt(mins, "m")
  if (hours < 24) return fmt(hours, "h")
  return fmt(days, "d")
}
