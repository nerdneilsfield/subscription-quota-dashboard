export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"
export type LogFormat = "pretty" | "json"
export type LogFields = Record<string, unknown>

export type Logger = {
  level: LogLevel
  isLevelEnabled(level: Exclude<LogLevel, "silent">): boolean
  child(fields: LogFields): Logger
  debug(event: string, fields?: LogFields, message?: string): void
  info(event: string, fields?: LogFields, message?: string): void
  warn(event: string, fields?: LogFields, message?: string): void
  error(event: string, fields?: LogFields, message?: string): void
}

type LoggerOptions = {
  level?: LogLevel
  format?: LogFormat
  service?: string
  base?: LogFields
  now?: () => Date
  write?: (line: string, level: Exclude<LogLevel, "silent">) => void
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
}

const REDACTED = "[REDACTED]"
const MAX_DEPTH = 8
const MAX_ARRAY_ITEMS = 100

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  return normalized === "authorization"
    || normalized === "cookie"
    || normalized === "authcookie"
    || normalized === "sessioncookie"
    || normalized === "setcookie"
    || normalized === "apikey"
    || normalized === "token"
    || normalized === "accesstoken"
    || normalized === "refreshtoken"
    || normalized === "secret"
    || normalized === "sessionsecret"
    || normalized === "password"
    || normalized === "viewkey"
    || normalized === "managementkey"
}

function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]"
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack !== undefined ? { stack: value.stack } : {}),
      ...(value.cause !== undefined ? { cause: sanitize(value.cause, depth + 1, seen) } : {}),
    }
  }
  if (typeof value !== "object") return String(value)
  if (seen.has(value)) return "[CIRCULAR]"
  seen.add(value)

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1, seen))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} MORE]`)
    return items
  }

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitize(child, depth + 1, seen)
  }
  return out
}

function formatValue(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z0-9._:/@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function formatPretty(record: Record<string, unknown>): string {
  const timestamp = String(record.timestamp)
  const level = String(record.level).toUpperCase().padEnd(5)
  const event = String(record.event)
  const message = typeof record.message === "string" ? ` ${record.message}` : ""
  const fields = Object.entries(record)
    .filter(([key]) => !["timestamp", "level", "event", "message"].includes(key))
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ")
  return `${timestamp} ${level} ${event}${message}${fields ? ` ${fields}` : ""}`
}

function defaultWrite(line: string, level: Exclude<LogLevel, "silent">): void {
  if (level === "warn" || level === "error") console.error(line)
  else console.log(line)
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  const normalized = value?.trim().toLowerCase()
  return normalized === "debug" || normalized === "info" || normalized === "warn"
    || normalized === "error" || normalized === "silent"
    ? normalized
    : fallback
}

export function parseLogFormat(value: string | undefined, fallback: LogFormat): LogFormat {
  const normalized = value?.trim().toLowerCase()
  return normalized === "json" || normalized === "pretty" ? normalized : fallback
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info"
  const format = options.format ?? "pretty"
  const now = options.now ?? (() => new Date())
  const write = options.write ?? defaultWrite
  const base = sanitize({ service: options.service ?? "subscription-quota-dashboard", ...(options.base ?? {}) }) as LogFields

  function enabled(candidate: Exclude<LogLevel, "silent">): boolean {
    return LEVEL_WEIGHT[candidate] >= LEVEL_WEIGHT[level]
  }

  function emit(candidate: Exclude<LogLevel, "silent">, event: string, fields: LogFields = {}, message?: string): void {
    if (!enabled(candidate)) return
    const record = sanitize({
      timestamp: now().toISOString(),
      level: candidate,
      event,
      ...base,
      ...fields,
      ...(message !== undefined ? { message } : {}),
    }) as Record<string, unknown>
    write(format === "json" ? JSON.stringify(record) : formatPretty(record), candidate)
  }

  return {
    level,
    isLevelEnabled: enabled,
    child(fields) {
      return createLogger({ ...options, level, format, now, write, base: { ...base, ...fields } })
    },
    debug: (event, fields, message) => emit("debug", event, fields, message),
    info: (event, fields, message) => emit("info", event, fields, message),
    warn: (event, fields, message) => emit("warn", event, fields, message),
    error: (event, fields, message) => emit("error", event, fields, message),
  }
}

export const silentLogger: Logger = createLogger({ level: "silent" })
