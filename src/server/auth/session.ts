import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { ProfileConfig } from "../../shared/domain"

const COOKIE_PREFIX = "sqd_session_"

export type ResolvedSecret = { secret: string; generated: boolean }

type SessionPayload = {
  pid: string
  khash: string
  iat: number
  exp: number
}

function hmac(message: string, secret: string): string {
  return createHmac("sha256", secret).update(message).digest("hex")
}

function safeEqualStrings(a: string, b: string): boolean {
  const aHash = createHash("sha256").update(a).digest()
  const bHash = createHash("sha256").update(b).digest()
  if (aHash.length !== bHash.length) return false
  return timingSafeEqual(aHash, bHash)
}

function b64url(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64url")
}

function fromB64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf-8")
}

export function sessionCookieName(profileId: string): string {
  return `${COOKIE_PREFIX}${encodeURIComponent(profileId)}`
}

export function verifyViewKey(profile: ProfileConfig, candidate: string): boolean {
  const expected = profile.viewKey
  if (expected === undefined || expected === "") return false
  if (typeof candidate !== "string" || candidate === "") return false
  return safeEqualStrings(expected, candidate)
}

export function createSessionCookie(
  profileId: string,
  viewKey: string,
  secret: string,
  now: number,
  maxAgeSeconds: number,
  secure: boolean = false,
): string {
  const iat = now
  const exp = now + maxAgeSeconds * 1000
  const payload: SessionPayload = {
    pid: profileId,
    khash: hmac(viewKey, secret),
    iat,
    exp,
  }
  const payloadB64 = b64url(JSON.stringify(payload))
  const signature = hmac(payloadB64, secret)
  const value = `${payloadB64}.${signature}`
  const attributes = ["HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSeconds}`]
  if (secure) attributes.push("Secure")
  return `${sessionCookieName(profileId)}=${value}; ${attributes.join("; ")}`
}

export function verifySessionCookie(
  cookie: string,
  profile: ProfileConfig,
  secret: string,
  now: number,
): boolean {
  try {
    if (typeof cookie !== "string" || cookie.length === 0) return false
    const nameEnd = cookie.indexOf("=")
    if (nameEnd < 0) return false
    const name = cookie.slice(0, nameEnd)
    if (name !== sessionCookieName(profile.id)) return false

    const rest = cookie.slice(nameEnd + 1)
    const semi = rest.indexOf(";")
    const value = semi >= 0 ? rest.slice(0, semi) : rest

    const dot = value.lastIndexOf(".")
    if (dot <= 0 || dot === value.length - 1) return false
    const payloadB64 = value.slice(0, dot)
    const signature = value.slice(dot + 1)

    const expectedSignature = hmac(payloadB64, secret)
    if (!safeEqualStrings(signature, expectedSignature)) return false

    const payload = JSON.parse(fromB64url(payloadB64)) as Partial<SessionPayload>
    if (
      typeof payload.pid !== "string" ||
      typeof payload.khash !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number"
    ) {
      return false
    }
    if (payload.pid !== profile.id) return false
    if (payload.exp < now) return false

    const expected = profile.viewKey
    if (expected === undefined || expected === "") return false
    const currentKhash = hmac(expected, secret)
    if (!safeEqualStrings(payload.khash, currentKhash)) return false

    return true
  } catch {
    return false
  }
}

export function resolveSessionSecret(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = console.warn,
): ResolvedSecret {
  const provided = env["SESSION_SECRET"]
  if (provided !== undefined && provided !== "") {
    return { secret: provided, generated: false }
  }
  if (env["NODE_ENV"] === "production") {
    throw new Error("SESSION_SECRET must be set when NODE_ENV=production")
  }
  const generated = randomBytes(32).toString("hex")
  warn(
    "[auth] SESSION_SECRET is not set; generated an ephemeral dev secret. " +
      "This MUST NOT happen in production.",
  )
  return { secret: generated, generated: true }
}
