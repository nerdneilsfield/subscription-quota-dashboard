import { Temporal } from "@js-temporal/polyfill"
import type { CalendarAnchor, LimitWindow } from "./domain"

export function isValidDuration(value: string): boolean {
  return /^\d+(m|h|d)$/.test(value)
}

export function validateWindow(window: LimitWindow, path = "window"): void {
  if (window.kind === "calendar") {
    if (!window.timezone) throw new Error(`${path}.timezone is required`)
    if (Boolean(window.resetAt) === Boolean(window.anchor)) throw new Error(`${path} must set exactly one of resetAt or anchor`)
  }
  if (window.kind === "rolling" && !isValidDuration(window.duration)) throw new Error(`${path}.duration is invalid`)
  if (window.kind === "fixed" && Date.parse(window.startsAt) >= Date.parse(window.resetAt)) throw new Error(`${path}.startsAt must be before resetAt`)
}

export function validateNormalizedWindow(window: LimitWindow, path = "window"): void {
  if (window.kind === "calendar") {
    if (!window.timezone) throw new Error(`${path}.timezone is required`)
    if (!window.resetAt && !window.anchor) throw new Error(`${path} must set resetAt or anchor`)
  }
  if (window.kind === "rolling" && !isValidDuration(window.duration)) throw new Error(`${path}.duration is invalid`)
  if (window.kind === "fixed" && Date.parse(window.startsAt) >= Date.parse(window.resetAt)) throw new Error(`${path}.startsAt must be before resetAt`)
}

export function labelWindow(window: LimitWindow, _resetAt?: string): string {
  if (window.kind === "calendar") return `${window.period[0]!.toUpperCase()}${window.period.slice(1)}ly`
  if (window.kind === "rolling") return `Rolling ${window.duration}`
  return "Fixed window"
}

export function computeNextResetAt(window: Extract<LimitWindow, { kind: "calendar" }>, from: Date): string | undefined {
  validateNormalizedWindow(window)
  if (window.resetAt) return Date.parse(window.resetAt) > from.getTime() ? window.resetAt : undefined
  return computeCalendarAnchorReset(window, from)
}

function parseTimeOfDay(value: string | undefined): { hour: number; minute: number; second: number } {
  if (value === undefined) return { hour: 0, minute: 0, second: 0 }
  const parts = value.split(":")
  const hour = Number(parts[0] ?? 0)
  const minute = Number(parts[1] ?? 0)
  const second = Number(parts[2] ?? 0)
  return { hour, minute, second }
}

function dateMatchesAnchor(date: Temporal.PlainDate, period: "day" | "week" | "month" | "year", anchor: Partial<CalendarAnchor>): boolean {
  if (period === "day") return true
  if (period === "week") {
    if (anchor.dayOfWeek === undefined) return false
    return date.dayOfWeek === anchor.dayOfWeek
  }
  if (period === "month") {
    if (anchor.dayOfMonth === undefined) return false
    const target = Math.min(anchor.dayOfMonth, date.daysInMonth)
    return date.day === target
  }
  if (anchor.monthOfYear === undefined || anchor.dayOfMonth === undefined) return false
  if (date.month !== anchor.monthOfYear) return false
  const daysInTargetMonth = new Temporal.PlainDate(date.year, anchor.monthOfYear, 1).daysInMonth
  const target = Math.min(anchor.dayOfMonth, daysInTargetMonth)
  return date.day === target
}

function computeCalendarAnchorReset(
  window: Extract<LimitWindow, { kind: "calendar" }>,
  from: Date,
): string | undefined {
  const timezone = window.timezone
  const anchor = window.anchor ?? {}
  const fromInstant = Temporal.Instant.fromEpochMilliseconds(from.getTime())
  const startPlain = fromInstant.toZonedDateTimeISO(timezone).toPlainDate()
  const time = parseTimeOfDay(anchor.timeOfDay)

  for (let i = 0; i < 800; i++) {
    const date = startPlain.add({ days: i })
    if (!dateMatchesAnchor(date, window.period, anchor)) continue
    const zdt = Temporal.ZonedDateTime.from(
      {
        timeZone: timezone,
        year: date.year,
        month: date.month,
        day: date.day,
        hour: time.hour,
        minute: time.minute,
        second: time.second,
      },
      { disambiguation: "compatible" },
    )
    if (Temporal.Instant.compare(zdt.toInstant(), fromInstant) > 0) {
      return zdt.toInstant().toString()
    }
  }
  return undefined
}
