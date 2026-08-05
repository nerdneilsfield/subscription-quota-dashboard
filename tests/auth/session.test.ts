import { describe, expect, test } from "bun:test"
import type { ProfileConfig } from "../../src/shared/domain"
import {
  clearSessionCookie,
  createSessionCookie,
  resolveSessionSecret,
  sessionCookieName,
  verifySessionCookie,
  verifyViewKey,
} from "../../src/server/auth/session"

const SECRET = "test-session-secret-very-long-0123456789"
const KEY_A = "view-key-aaaaaaaa"
const KEY_B = "view-key-bbbbbbbb"

function profile(id: string, viewKey: string): ProfileConfig {
  return { id, name: id, viewKey, subscriptionIds: [] }
}

describe("verifyViewKey", () => {
  test("accepts exact key", () => {
    expect(verifyViewKey(profile("self", KEY_A), KEY_A)).toBe(true)
  })

  test("rejects wrong key", () => {
    expect(verifyViewKey(profile("self", KEY_A), KEY_B)).toBe(false)
  })

  test("rejects empty candidate", () => {
    expect(verifyViewKey(profile("self", KEY_A), "")).toBe(false)
  })

  test("rejects undefined profile viewKey", () => {
    expect(verifyViewKey({ ...profile("self", KEY_A), viewKey: undefined }, KEY_A)).toBe(false)
  })
})

describe("sessionCookieName", () => {
  test("is sqd_session_self for profile self", () => {
    expect(sessionCookieName("self")).toBe("sqd_session_self")
  })

  test("encodes slash in nested profile id", () => {
    expect(sessionCookieName("team/main")).toBe("sqd_session_team%2Fmain")
  })
})

test("clearSessionCookie expires only the selected profile cookie", () => {
  const cookie = clearSessionCookie("team/main", true)
  expect(cookie).toStartWith("sqd_session_team%2Fmain=;")
  expect(cookie).toContain("Max-Age=0")
  expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
  expect(cookie).toContain("HttpOnly")
  expect(cookie).toContain("Secure")
})

describe("createSessionCookie + verifySessionCookie", () => {
  const now = 1_700_000_000_000

  test("cookie verifies with same secret", () => {
    const p = profile("self", KEY_A)
    const cookie = createSessionCookie("self", KEY_A, SECRET, now, 86400)
    expect(verifySessionCookie(cookie, p, SECRET, now)).toBe(true)
  })

  test("cookie fails after viewKey rotation", () => {
    const cookie = createSessionCookie("self", KEY_A, SECRET, now, 86400)
    const rotated = profile("self", KEY_B)
    expect(verifySessionCookie(cookie, rotated, SECRET, now)).toBe(false)
  })

  test("cookie fails with different session secret", () => {
    const cookie = createSessionCookie("self", KEY_A, SECRET, now, 86400)
    expect(verifySessionCookie(cookie, profile("self", KEY_A), "other-secret-also-long", now)).toBe(false)
  })

  test("payload profile id must match route profile id", () => {
    const cookie = createSessionCookie("self", KEY_A, SECRET, now, 86400)
    expect(verifySessionCookie(cookie, profile("other", KEY_A), SECRET, now)).toBe(false)
  })

  test("fails after Max-Age=86400 expiry using injected now", () => {
    const cookie = createSessionCookie("self", KEY_A, SECRET, now, 86400)
    const p = profile("self", KEY_A)
    expect(verifySessionCookie(cookie, p, SECRET, now + 86400 * 1000)).toBe(true)
    expect(verifySessionCookie(cookie, p, SECRET, now + 86400 * 1000 + 1)).toBe(false)
  })

  test("malformed cookie fails closed without throwing", () => {
    const p = profile("self", KEY_A)
    const cases = [
      "",
      "not-a-cookie",
      "sqd_session_self",
      "sqd_session_self=",
      "sqd_session_self=garbage",
      "sqd_session_self=aaa.bbb",
      "sqd_session_self=aaa.bbb.ccc",
      "sqd_session_self=" + "x".repeat(200),
    ]
    for (const c of cases) {
      expect(verifySessionCookie(c, p, SECRET, now)).toBe(false)
    }
  })

  test("cookie includes HttpOnly, SameSite=Lax, Path=/, Max-Age=86400 and no Secure by default", () => {
    const cookie = createSessionCookie("self", KEY_A, SECRET, now, 86400)
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("Max-Age=86400")
    expect(cookie).not.toContain("Secure")
  })

  test("cookie includes Secure when secure=true passed", () => {
    const cookie = createSessionCookie("self", KEY_A, SECRET, now, 86400, true)
    expect(cookie).toContain("Secure")
  })

  test("embedded cookie name is encoded for nested profile", () => {
    const cookie = createSessionCookie("team/main", KEY_A, SECRET, now, 86400)
    expect(cookie.startsWith("sqd_session_team%2Fmain=")).toBe(true)
  })
})

describe("resolveSessionSecret", () => {
  test("uses SESSION_SECRET when present and does not generate", () => {
    const r = resolveSessionSecret({ SESSION_SECRET: "provided-secret", NODE_ENV: "production" })
    expect(r.secret).toBe("provided-secret")
    expect(r.generated).toBe(false)
  })

  test("throws when missing in production", () => {
    expect(() =>
      resolveSessionSecret({ SESSION_SECRET: undefined, NODE_ENV: "production" }),
    ).toThrow()
  })

  test("generates a random dev secret and warns when missing in non-production", () => {
    const r = resolveSessionSecret({ SESSION_SECRET: undefined, NODE_ENV: "development" })
    expect(r.generated).toBe(true)
    expect(typeof r.secret).toBe("string")
    expect(r.secret.length).toBeGreaterThan(0)
  })
})
