// Resolve the client IP for rate-limiting, honoring X-Forwarded-For ONLY when
// the request arrived from a trusted proxy. This prevents spoofing: a client
// connecting directly cannot poison another client's rate-limit bucket by
// setting XFF, because their socket IP is not in `trustedProxies`.
export function resolveClientIp(
  socketIp: string | undefined,
  xff: string | undefined,
  trustedProxies: ReadonlySet<string>,
): string {
  const direct = socketIp ?? "unknown"
  // If the direct connection is from a trusted proxy, the first XFF entry is
  // the real client. Otherwise the direct socket IP IS the client.
  if (trustedProxies.has(direct)) {
    const first = xff?.split(",")[0]?.trim()
    if (first && first.length > 0) return first
  }
  return direct
}

export function parseTrustedProxies(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
