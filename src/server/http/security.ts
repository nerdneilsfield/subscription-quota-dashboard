const DEV_CORS_ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]

export const devCorsAllowedOrigins: readonly string[] = DEV_CORS_ALLOWED_ORIGINS

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "viewkey",
  "apikey",
  "password",
])

export function apiNoStoreHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" }
}

export function appSecurityHeaders(): Record<string, string> {
  return { "Referrer-Policy": "no-referrer" }
}

export function isAllowedDevCorsOrigin(origin: string): boolean {
  return DEV_CORS_ALLOWED_ORIGINS.indexOf(origin) >= 0
}

export function devCorsHeaders(origin: string): Record<string, string> | null {
  if (!isAllowedDevCorsOrigin(origin)) return null
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  }
}

export function redactForLog<T>(value: T): T {
  return redact(value) as T
}

function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(redact)
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = "[redacted]"
    } else {
      out[key] = redact(source[key])
    }
  }
  return out
}
