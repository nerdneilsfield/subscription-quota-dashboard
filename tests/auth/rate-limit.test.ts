import { describe, expect, test } from "bun:test"
import { createRateLimiter } from "../../src/server/auth/rate-limit"

describe("createRateLimiter", () => {
  test("blocks the 11th failed auth attempt in a 5-minute window", () => {
    let t = 1_000
    const limiter = createRateLimiter({ now: () => t, windowMs: 5 * 60 * 1000, maxAttempts: 10 })
    for (let i = 0; i < 10; i++) {
      expect(limiter.check("ip:self")).toBe(true)
    }
    expect(limiter.check("ip:self")).toBe(false)
  })

  test("defaults windowMs to five minutes and maxAttempts to 10", () => {
    let t = 0
    const limiter = createRateLimiter({ now: () => t })
    for (let i = 0; i < 10; i++) limiter.check("k")
    expect(limiter.check("k")).toBe(false)
    t += 5 * 60 * 1000 + 1
    expect(limiter.check("k")).toBe(true)
  })

  test("unblocks after the window passes", () => {
    let t = 5_000
    const limiter = createRateLimiter({ now: () => t, windowMs: 60_000 })
    for (let i = 0; i < 10; i++) limiter.check("k")
    expect(limiter.check("k")).toBe(false)
    t += 60_001
    expect(limiter.check("k")).toBe(true)
  })

  test("keys are isolated", () => {
    let t = 0
    const limiter = createRateLimiter({ now: () => t })
    for (let i = 0; i < 10; i++) limiter.check("a")
    expect(limiter.check("a")).toBe(false)
    expect(limiter.check("b")).toBe(true)
  })

  test("reset clears failures for a key", () => {
    let t = 0
    const limiter = createRateLimiter({ now: () => t })
    for (let i = 0; i < 10; i++) limiter.check("a")
    expect(limiter.check("a")).toBe(false)
    limiter.reset("a")
    expect(limiter.check("a")).toBe(true)
  })
})
