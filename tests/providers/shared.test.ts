import { expect, test } from "bun:test"
import { parseNumber, isRetryableStatus, authError, parseResetTime } from "../../src/server/providers/shared"

test("parseNumber accepts numbers", () => {
  expect(parseNumber(42)).toBe(42)
  expect(parseNumber(3.14)).toBe(3.14)
  expect(parseNumber(0)).toBe(0)
})

test("parseNumber accepts numeric strings", () => {
  expect(parseNumber("42")).toBe(42)
  expect(parseNumber("3.14")).toBe(3.14)
})

test("parseNumber rejects non-numeric", () => {
  expect(parseNumber("abc")).toBeUndefined()
  expect(parseNumber(null)).toBeUndefined()
  expect(parseNumber(undefined)).toBeUndefined()
  expect(parseNumber({})).toBeUndefined()
  expect(parseNumber(NaN)).toBeUndefined()
  expect(parseNumber(Infinity)).toBeUndefined()
  expect(parseNumber("")).toBeUndefined()
})

test("isRetryableStatus: 5xx and 429 are retryable", () => {
  expect(isRetryableStatus(500)).toBe(true)
  expect(isRetryableStatus(502)).toBe(true)
  expect(isRetryableStatus(503)).toBe(true)
  expect(isRetryableStatus(429)).toBe(true)
})

test("isRetryableStatus: 2xx and 4xx (non-429) are not retryable", () => {
  expect(isRetryableStatus(200)).toBe(false)
  expect(isRetryableStatus(400)).toBe(false)
  expect(isRetryableStatus(401)).toBe(false)
  expect(isRetryableStatus(403)).toBe(false)
  expect(isRetryableStatus(404)).toBe(false)
})

test("authError produces non-retryable error", () => {
  const err = authError("DeepSeek authentication failed")
  expect(err.retryable).toBe(false)
  expect(err.message).toBe("DeepSeek authentication failed")
})

test("parseResetTime accepts ISO string", () => {
  expect(parseResetTime("2026-07-01T00:00:00Z")).toBe("2026-07-01T00:00:00Z")
})

test("parseResetTime converts milliseconds", () => {
  // 1751328000000 ms = 2025-07-01T00:00:00Z
  expect(parseResetTime(1751328000000)).toBe("2025-07-01T00:00:00.000Z")
})

test("parseResetTime converts seconds", () => {
  // 1751328000 s = 2025-07-01T00:00:00Z
  expect(parseResetTime(1751328000)).toBe("2025-07-01T00:00:00.000Z")
})

test("parseResetTime rejects zero and negative", () => {
  expect(parseResetTime(0)).toBeUndefined()
  expect(parseResetTime(-1)).toBeUndefined()
})

test("parseResetTime rejects non-numeric non-string", () => {
  expect(parseResetTime(null)).toBeUndefined()
  expect(parseResetTime(undefined)).toBeUndefined()
})
