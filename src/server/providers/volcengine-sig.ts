import { createHash, createHmac } from "node:crypto"

// Volcengine SigV4 signing utility.
// Implements the Volcengine variant of AWS SigV4 (NOT standard SigV4).
// Three critical deviations from AWS SigV4 (per cc-switch coding_plan.rs:791-796):
//   1. Fixed header order (NOT alphabetical): host;x-date;x-content-sha256;content-type
//   2. Algorithm "HMAC-SHA256" (no "AWS4" prefix); credential scope ends with "request"
//      (not "aws4_request"); signing key kDate=HMAC(SK, date) (SK has no "AWS4" prefix)
//   3. Canonical query IS alphabetical (standard SigV4)
// Source: cc-switch coding_plan.rs:788-891

const VOLCENGINE_SERVICE = "ark"
const VOLCENGINE_CONTENT_TYPE = "application/json; charset=utf-8"
const VOLCENGINE_SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type"
const VOLCENGINE_OPENAPI_HOST = "open.volcengineapi.com"
const VOLCENGINE_API_VERSION = "2024-01-01"

// SHA-256 of empty string (body is always empty for Volcengine OpenAPI calls)
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

export type SignedVolcengineRequest = {
  url: string
  headers: Headers
}

export function signVolcengineRequest(input: {
  ak: string
  sk: string
  region: string
  action: string
  now: Date
}): SignedVolcengineRequest {
  const { ak, sk, region, action, now } = input
  const xDate = formatXDate(now)
  const shortDate = xDate.slice(0, 8)
  const canonicalQuery = buildCanonicalQuery(action, region)
  const canonicalHeaders = `host:${VOLCENGINE_OPENAPI_HOST}\nx-date:${xDate}\nx-content-sha256:${EMPTY_BODY_SHA256}\ncontent-type:${VOLCENGINE_CONTENT_TYPE}\n`
  const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${VOLCENGINE_SIGNED_HEADERS}\n${EMPTY_BODY_SHA256}`
  const credentialScope = `${shortDate}/${region}/${VOLCENGINE_SERVICE}/request`
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`
  // Signing key derivation (SK has NO "AWS4" prefix)
  const kDate = hmacSha256(sk, shortDate)
  const kRegion = hmacSha256Bytes(kDate, region)
  const kService = hmacSha256Bytes(kRegion, VOLCENGINE_SERVICE)
  const kSigning = hmacSha256Bytes(kService, "request")
  const signature = bytesToHex(hmacSha256Bytes(kSigning, stringToSign))
  const authorization = `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${VOLCENGINE_SIGNED_HEADERS}, Signature=${signature}`
  const url = `https://${VOLCENGINE_OPENAPI_HOST}/?${canonicalQuery}`
  const headers = new Headers()
  headers.set("Host", VOLCENGINE_OPENAPI_HOST)
  headers.set("X-Date", xDate)
  headers.set("X-Content-Sha256", EMPTY_BODY_SHA256)
  headers.set("Content-Type", VOLCENGINE_CONTENT_TYPE)
  headers.set("Authorization", authorization)
  return { url, headers }
}

function formatXDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}

function buildCanonicalQuery(action: string, region: string): string {
  const pairs: Array<[string, string]> = [
    ["Action", action],
    ["Region", region],
    ["Version", VOLCENGINE_API_VERSION],
  ]
  pairs.sort((a, b) => a[0].localeCompare(b[0]))
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&")
}

function uriEncode(s: string): string {
  let out = ""
  for (const byte of new TextEncoder().encode(s)) {
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x5f ||
      byte === 0x2e ||
      byte === 0x7e
    ) {
      out += String.fromCharCode(byte)
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex")
}

function hmacSha256(key: string, data: string): Uint8Array {
  return hmacSha256Bytes(new TextEncoder().encode(key), data)
}

function hmacSha256Bytes(key: Uint8Array, data: string): Uint8Array {
  return Uint8Array.from(createHmac("sha256", key).update(data).digest())
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}
