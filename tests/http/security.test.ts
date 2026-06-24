import { describe, expect, test } from "bun:test"
import {
  apiNoStoreHeaders,
  appSecurityHeaders,
  devCorsAllowedOrigins,
  devCorsHeaders,
  isAllowedDevCorsOrigin,
  redactForLog,
} from "../../src/server/http/security"

describe("apiNoStoreHeaders", () => {
  test("sets Cache-Control: no-store", () => {
    expect(apiNoStoreHeaders()["Cache-Control"]).toBe("no-store")
  })
})

describe("appSecurityHeaders", () => {
  test("sets Referrer-Policy: no-referrer", () => {
    expect(appSecurityHeaders()["Referrer-Policy"]).toBe("no-referrer")
  })
})

describe("dev CORS allow-list", () => {
  test("exposes exactly the two dev origins", () => {
    expect(devCorsAllowedOrigins).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ])
  })

  test("isAllowedDevCorsOrigin accepts the two dev origins", () => {
    expect(isAllowedDevCorsOrigin("http://localhost:5173")).toBe(true)
    expect(isAllowedDevCorsOrigin("http://127.0.0.1:5173")).toBe(true)
  })

  test("isAllowedDevCorsOrigin rejects other origins", () => {
    expect(isAllowedDevCorsOrigin("http://evil.example")).toBe(false)
    expect(isAllowedDevCorsOrigin("https://localhost:5173")).toBe(false)
    expect(isAllowedDevCorsOrigin("http://localhost:5174")).toBe(false)
    expect(isAllowedDevCorsOrigin("http://127.0.0.1:5174")).toBe(false)
    expect(isAllowedDevCorsOrigin("")).toBe(false)
  })

  test("devCorsHeaders builds allow-origin, credentials, methods GET+POST, headers Content-Type+Authorization", () => {
    const h = devCorsHeaders("http://localhost:5173")
    expect(h).not.toBeNull()
    expect(h!["Access-Control-Allow-Origin"]).toBe("http://localhost:5173")
    expect(h!["Access-Control-Allow-Credentials"]).toBe("true")
    expect(h!["Access-Control-Allow-Methods"]).toBe("GET, POST")
    expect(h!["Access-Control-Allow-Headers"]).toBe("Content-Type, Authorization")
  })

  test("devCorsHeaders returns null for disallowed origin", () => {
    expect(devCorsHeaders("http://evil.example")).toBeNull()
  })
})

describe("redactForLog", () => {
  test("redacts Authorization, Cookie, Set-Cookie headers but keeps others", () => {
    const input = {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer secret-value",
        "Cookie": "sqd_session_self=abc",
        "Set-Cookie": "sqd_session_self=xyz",
      },
    }
    const out = redactForLog(input) as {
      method: string
      headers: Record<string, string>
    }
    expect(out.method).toBe("GET")
    expect(out.headers["Content-Type"]).toBe("application/json")
    expect(out.headers["Authorization"]).toBe("[redacted]")
    expect(out.headers["Cookie"]).toBe("[redacted]")
    expect(out.headers["Set-Cookie"]).toBe("[redacted]")
  })

  test("redacts JSON fields viewKey, apiKey, password", () => {
    const input = { viewKey: "k", apiKey: "a", password: "p", keep: "v" }
    const out = redactForLog(input) as Record<string, string>
    expect(out.viewKey).toBe("[redacted]")
    expect(out.apiKey).toBe("[redacted]")
    expect(out.password).toBe("[redacted]")
    expect(out.keep).toBe("v")
  })

  test("redacts nested objects and arrays", () => {
    const input = {
      body: { user: { name: "n", password: "p" }, list: [{ apiKey: "x" }, { ok: 1 }] },
    }
    const out = redactForLog(input) as {
      body: { user: { name: string; password: string }; list: Array<Record<string, unknown>> }
    }
    expect(out.body.user.name).toBe("n")
    expect(out.body.user.password).toBe("[redacted]")
    expect(out.body.list[0]!["apiKey"]).toBe("[redacted]")
    expect(out.body.list[1]!["ok"]).toBe(1)
  })

  test("does not mutate input", () => {
    const input = { password: "p", nested: { apiKey: "k" } }
    redactForLog(input)
    expect(input.password).toBe("p")
    expect(input.nested.apiKey).toBe("k")
  })

  test("handles primitives and null without throwing", () => {
    expect(redactForLog(null)).toBe(null)
    expect(redactForLog("str")).toBe("str")
    expect(redactForLog(42)).toBe(42)
  })
})
