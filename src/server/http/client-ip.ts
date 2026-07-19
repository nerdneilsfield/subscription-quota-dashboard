// Resolve the client IP for rate-limiting, honoring X-Forwarded-For ONLY when
// the request arrived from a trusted proxy. This prevents spoofing: a client
// connecting directly cannot poison another client's rate-limit bucket by
// setting XFF, because their socket IP is not in `trustedProxies`.
//
// Trust chain: when behind multiple proxies (e.g. CDN -> nginx -> app),
// the XFF header contains a comma-separated list: "client, proxy1, proxy2".
// Nginx appends the real client IP, so the RIGHTMOST entry is the most recent
// trusted hop. We walk from right-to-left, skipping trusted proxy IPs, and
// take the first untrusted entry as the real client IP.
export function resolveClientIp(
  socketIp: string | undefined,
  xff: string | undefined,
  trustedProxies: ReadonlySet<string>,
): string {
  const direct = normalizeIp(socketIp ?? "") ?? "unknown"

  // If the direct connection is NOT from a trusted proxy, the socket IP IS
  // the client. No XFF processing.
  if (!trustedProxies.has(direct)) {
    return direct
  }

  // The direct connection is from a trusted proxy. Parse the XFF chain.
  // XFF format: "client, proxy1, proxy2" (left-to-right = oldest to newest).
  // Walk right-to-left, skipping trusted hops.
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    for (let i = parts.length - 1; i >= 0; i--) {
      const ip = normalizeIp(parts[i]!)
      if (ip === undefined) continue // skip malformed entries
      if (!trustedProxies.has(ip)) {
        return ip // first untrusted entry = real client
      }
    }
  }

  // All XFF entries were trusted proxies (or XFF absent) - fall back to direct.
  return direct
}

// Normalize IPv4/IPv6 addresses for consistent comparison.
// Strips IPv6 brackets and maps IPv4-mapped IPv6 (::ffff:1.2.3.4 -> 1.2.3.4).
function normalizeIp(ip: string): string | undefined {
  let normalized = ip.trim()
  // Strip brackets from IPv6 (e.g. [::1] -> ::1)
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1)
  }
  // Map IPv4-mapped IPv6 to plain IPv4 (::ffff:1.2.3.4 -> 1.2.3.4)
  const v4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Mapped) {
    normalized = v4Mapped[1]!
  }
  // Validate basic structure
  if (normalized.length === 0) return undefined
  return normalized
}

export function parseTrustedProxies(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => normalizeIp(s))
    .filter((s): s is string => s !== undefined && s.length > 0)
}
