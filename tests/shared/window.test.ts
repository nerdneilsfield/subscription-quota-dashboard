import { expect, test } from "bun:test"
import {
  computeNextResetAt,
  isValidDuration,
  labelWindow,
  validateNormalizedWindow,
  validateWindow,
} from "../../src/shared/window"

test("isValidDuration accepts 5h, 30m, 7d", () => {
  expect(isValidDuration("5h")).toBe(true)
  expect(isValidDuration("30m")).toBe(true)
  expect(isValidDuration("7d")).toBe(true)
})

test("isValidDuration rejects five-hours", () => {
  expect(isValidDuration("five-hours")).toBe(false)
})

test("validateWindow rejects calendar with both resetAt and anchor", () => {
  const window = {
    kind: "calendar" as const,
    period: "day" as const,
    timezone: "UTC",
    resetAt: "2026-07-01T00:00:00Z",
    anchor: { timeOfDay: "00:00" },
  }
  expect(() => validateWindow(window)).toThrow()
})

test("validateWindow accepts calendar with only resetAt or only anchor", () => {
  expect(() =>
    validateWindow({ kind: "calendar", period: "day", timezone: "UTC", resetAt: "2026-07-01T00:00:00Z" }),
  ).not.toThrow()
  expect(() =>
    validateWindow({ kind: "calendar", period: "day", timezone: "UTC", anchor: { timeOfDay: "00:00" } }),
  ).not.toThrow()
})

test("validateNormalizedWindow accepts calendar with both resetAt and anchor", () => {
  const window = {
    kind: "calendar" as const,
    period: "day" as const,
    timezone: "UTC",
    resetAt: "2026-07-01T00:00:00Z",
    anchor: { timeOfDay: "00:00" },
  }
  expect(() => validateNormalizedWindow(window)).not.toThrow()
})

test("validateNormalizedWindow accepts resetAt alone or anchor alone", () => {
  expect(() =>
    validateNormalizedWindow({ kind: "calendar", period: "day", timezone: "UTC", resetAt: "2026-07-01T00:00:00Z" }),
  ).not.toThrow()
  expect(() =>
    validateNormalizedWindow({ kind: "calendar", period: "day", timezone: "UTC", anchor: { timeOfDay: "00:00" } }),
  ).not.toThrow()
})

test("computeNextResetAt honors ISO dayOfWeek for weekly anchor", () => {
  // 2026-06-25 is Thursday (ISO day 4). Next Monday (ISO day 1) is 2026-06-29.
  const window = {
    kind: "calendar" as const,
    period: "week" as const,
    timezone: "UTC",
    anchor: { dayOfWeek: 1, timeOfDay: "00:00" },
  }
  const next = computeNextResetAt(window, new Date("2026-06-25T00:00:00Z"))
  expect(next).toBe("2026-06-29T00:00:00Z")
})

test("computeNextResetAt clamps dayOfMonth to month end", () => {
  // February 2026 has 28 days; anchor dayOfMonth=31 should clamp to Feb 28.
  const window = {
    kind: "calendar" as const,
    period: "month" as const,
    timezone: "UTC",
    anchor: { dayOfMonth: 31, timeOfDay: "00:00" },
  }
  const next = computeNextResetAt(window, new Date("2026-02-01T00:00:00Z"))
  expect(next).toBe("2026-02-28T00:00:00Z")
})

test("computeNextResetAt resolves DST nonexistent local time to next valid local time", () => {
  // America/New_York springs forward 2026-03-08 02:00->03:00; 02:30 does not exist.
  // 'compatible' disambiguation moves forward to 03:30 EDT = 07:30 UTC.
  const window = {
    kind: "calendar" as const,
    period: "day" as const,
    timezone: "America/New_York",
    anchor: { timeOfDay: "02:30" },
  }
  const next = computeNextResetAt(window, new Date("2026-03-07T12:00:00Z"))
  expect(next).toBe("2026-03-08T07:30:00Z")
})

test("computeNextResetAt resolves DST repeated local time to first occurrence", () => {
  // America/New_York falls back 2026-11-01 02:00->01:00; 01:30 occurs twice.
  // 'compatible' disambiguation picks the earlier occurrence = 01:30 EDT = 05:30 UTC.
  const window = {
    kind: "calendar" as const,
    period: "day" as const,
    timezone: "America/New_York",
    anchor: { timeOfDay: "01:30" },
  }
  const next = computeNextResetAt(window, new Date("2026-10-31T12:00:00Z"))
  expect(next).toBe("2026-11-01T05:30:00Z")
})

test("labelWindow includes reset text when resetAt known", () => {
  const window = {
    kind: "calendar" as const,
    period: "month" as const,
    timezone: "UTC",
  }
  const label = labelWindow(window, "2026-07-01T00:00:00Z")
  expect(label).toBe("Monthly, resets 2026-07-01T00:00:00.000Z")
})

test("labelWindow omits reset text when resetAt absent", () => {
  const window = {
    kind: "rolling" as const,
    duration: "24h",
  }
  expect(labelWindow(window)).toBe("Rolling 24h")
})

test("computeNextResetAt returns future resetAt as-is for calendar window with resetAt", () => {
  const window = {
    kind: "calendar" as const,
    period: "day" as const,
    timezone: "UTC",
    resetAt: "2026-07-01T00:00:00Z",
  }
  const next = computeNextResetAt(window, new Date("2026-06-25T00:00:00Z"))
  expect(next).toBe("2026-07-01T00:00:00Z")
})

test("computeNextResetAt returns undefined for past resetAt", () => {
  const window = {
    kind: "calendar" as const,
    period: "day" as const,
    timezone: "UTC",
    resetAt: "2026-01-01T00:00:00Z",
  }
  const next = computeNextResetAt(window, new Date("2026-06-25T00:00:00Z"))
  expect(next).toBeUndefined()
})
