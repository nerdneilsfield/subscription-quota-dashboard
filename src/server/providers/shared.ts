// Shared helpers for provider adapters. Extracted from cc-switch's repeated
// patterns (parse_f64, extract_reset_time, error classification).

export type ProviderError = { message: string; retryable: boolean }

/// Parse a JSON value as a number, accepting both JSON numbers and numeric
/// strings. Mirrors cc-switch's `parse_f64` (balance.rs:415-420,
/// coding_plan.rs:81-85). Real provider APIs sometimes return numbers as
/// strings; strict Number() would throw.
export function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    if (value.trim() === "") return undefined
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/// HTTP status >= 500 or 429 -> retryable. Shared by all adapters.
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

/// Helper for 401/403 auth errors. Always non-retryable.
export function authError(message: string): ProviderError {
  return { message, retryable: false }
}

/// Parse a reset-time field that may be an ISO string, seconds, or
/// milliseconds. Mirrors cc-switch's `extract_reset_time`
/// (coding_plan.rs:64-78). Zero/negative -> undefined (no reset).
export function parseResetTime(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (typeof value === "number") {
    if (value <= 0) return undefined
    // < 1e12 -> seconds; >= 1e12 -> milliseconds
    const ms = value < 1_000_000_000_000 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  return undefined
}
