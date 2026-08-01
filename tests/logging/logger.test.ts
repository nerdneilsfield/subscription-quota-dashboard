import { describe, expect, test } from "bun:test"
import { createLogger, parseLogFormat, parseLogLevel } from "../../src/server/logging/logger"
import { createLoggedFetch } from "../../src/server/logging/fetch"
import { runWithLogger } from "../../src/server/logging/context"

describe("structured logger", () => {
  test("filters records below configured level", () => {
    const lines: string[] = []
    const logger = createLogger({
      level: "info",
      format: "json",
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      write: (line) => lines.push(line),
    })

    logger.debug("debug.hidden", { value: 1 })
    logger.info("info.visible", { value: 2 })

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      timestamp: "2026-08-02T00:00:00.000Z",
      level: "info",
      event: "info.visible",
      value: 2,
    })
  })

  test("redacts sensitive fields recursively", () => {
    const lines: string[] = []
    const logger = createLogger({ level: "debug", format: "json", write: (line) => lines.push(line) })

    logger.info("security.test", {
      authorization: "Bearer secret",
      nested: {
        apiKey: "provider-secret",
        view_key: "login-secret",
        password: "password",
        safe: "visible",
      },
    })

    const record = JSON.parse(lines[0]!)
    expect(record.authorization).toBe("[REDACTED]")
    expect(record.nested).toEqual({
      apiKey: "[REDACTED]",
      view_key: "[REDACTED]",
      password: "[REDACTED]",
      safe: "visible",
    })
  })

  test("child logger preserves correlation context", () => {
    const lines: string[] = []
    const logger = createLogger({ level: "debug", format: "json", write: (line) => lines.push(line) })
      .child({ component: "http", requestId: "req-123" })
      .child({ providerAccountId: "cliproxy-main" })

    logger.debug("provider.started")

    expect(JSON.parse(lines[0]!)).toMatchObject({
      component: "http",
      requestId: "req-123",
      providerAccountId: "cliproxy-main",
      event: "provider.started",
    })
  })

  test("serializes errors and circular values safely", () => {
    const lines: string[] = []
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const logger = createLogger({ level: "debug", format: "json", write: (line) => lines.push(line) })

    logger.error("failure", { error: new Error("boom"), circular })

    const record = JSON.parse(lines[0]!)
    expect(record.error).toMatchObject({ name: "Error", message: "boom" })
    expect(record.circular.self).toBe("[CIRCULAR]")
  })

  test("parses environment settings with safe fallbacks", () => {
    expect(parseLogLevel("DEBUG", "info")).toBe("debug")
    expect(parseLogLevel("verbose", "info")).toBe("info")
    expect(parseLogFormat("JSON", "pretty")).toBe("json")
    expect(parseLogFormat("xml", "pretty")).toBe("pretty")
  })

  test("logged fetch correlates through async context without logging query values", async () => {
    const lines: string[] = []
    const base = createLogger({ level: "debug", format: "json", write: (line) => lines.push(line) })
    const requestLogger = base.child({ requestId: "req-fetch" })
    const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch
    const loggedFetch = createLoggedFetch(base, fakeFetch)

    await runWithLogger(requestLogger, () => loggedFetch("https://example.com/quota?apiKey=secret&range=24h"))

    const records = lines.map((line) => JSON.parse(line))
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      event: "upstream.request.started",
      requestId: "req-fetch",
      targetOrigin: "https://example.com",
      targetPath: "/quota",
      queryKeys: ["apiKey", "range"],
    })
    expect(lines.join("\n")).not.toContain("secret")
  })
})
