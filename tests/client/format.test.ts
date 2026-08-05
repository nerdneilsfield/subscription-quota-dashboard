import { expect, test } from "bun:test"
import {
  formatNumber,
  formatBurnRate,
  formatPercentUsed,
  formatRelativeTime,
  formatResetAt,
  formatCountdown,
  maskAccount,
} from "../../src/client/format"

const NOW = new Date("2026-06-25T12:00:00.000Z")

test("formatNumber rounds raw value below 1000", () => {
  expect(formatNumber(0)).toBe("0")
  expect(formatNumber(42.4)).toBe("42")
  expect(formatNumber(42.6)).toBe("43")
  expect(formatNumber(999)).toBe("999")
})

test("formatNumber uses locale thousands below 1_000_000", () => {
  expect(formatNumber(1000)).toBe("1,000")
  expect(formatNumber(12345)).toBe("12,345")
  expect(formatNumber(999999)).toBe("999,999")
})

test("formatNumber uses compact one-decimal at or above 1_000_000", () => {
  expect(formatNumber(1_000_000)).toBe("1M")
  expect(formatNumber(1_200_000)).toBe("1.2M")
  expect(formatNumber(15_500_000)).toBe("15.5M")
})

test("formatBurnRate uses two decimals plus /h", () => {
  expect(formatBurnRate(0)).toBe("0.00/h")
  expect(formatBurnRate(12.345)).toBe("12.35/h")
  expect(formatBurnRate(7)).toBe("7.00/h")
})

test("formatPercentUsed rounds percent and shows >100% on overflow", () => {
  expect(formatPercentUsed(75.4, false)).toBe("75%")
  expect(formatPercentUsed(99.6, false)).toBe("100%")
  expect(formatPercentUsed(120, true)).toBe(">100%")
  expect(formatPercentUsed(50, true)).toBe(">100%")
})

test("formatRelativeTime renders future buckets", () => {
  expect(formatRelativeTime("2026-06-25T12:00:45.000Z", NOW)).toBe("in 45s")
  expect(formatRelativeTime("2026-06-25T12:05:00.000Z", NOW)).toBe("in 5m")
  expect(formatRelativeTime("2026-06-25T15:00:00.000Z", NOW)).toBe("in 3h")
  expect(formatRelativeTime("2026-06-27T12:00:00.000Z", NOW)).toBe("in 2d")
})

test("formatRelativeTime renders past buckets", () => {
  expect(formatRelativeTime("2026-06-25T11:55:00.000Z", NOW)).toBe("5m ago")
  expect(formatRelativeTime("2026-06-25T09:00:00.000Z", NOW)).toBe("3h ago")
})

test("formatResetAt renders exact cutoff in the selected timezone", () => {
  expect(formatResetAt("2026-06-25T12:00:00.000Z", "Asia/Shanghai"))
    .toBe("2026-06-25 20:00:00 GMT+8")
  expect(formatResetAt("2026-06-25T12:00:00.000Z", "America/Los_Angeles"))
    .toBe("2026-06-25 05:00:00 GMT-7")
})

test("formatCountdown keeps total hours and pads minutes and seconds", () => {
  expect(formatCountdown("2026-06-27T15:04:05.000Z", NOW)).toBe("51h 04m 05s")
  expect(formatCountdown("2026-06-27T15:04:05.000Z", NOW, "zh-CN")).toBe("51小时 04分 05秒")
  expect(formatCountdown("2026-06-25T11:00:00.000Z", NOW)).toBe("0h 00m 00s")
})

test("maskAccount masks email local part and domain separately", () => {
  expect(maskAccount("mendelan27@gmail.com")).toBe("me••••••27@gm••l.com")
  expect(maskAccount("alice@example.com")).toBe("al•ce@ex••••e.com")
})
