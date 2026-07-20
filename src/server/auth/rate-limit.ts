// Rate limiter with a fail-overflow strategy.
//
// Design goals:
// 1. Existing keys always use their own bucket (no cross-contamination).
// 2. When at capacity, unseen keys route to a shared __overflow__ bucket.
// 3. The overflow bucket ONLY accumulates failures (via recordFailure).
//    Successful logins call `reset` on the original key, which doesn't
//    touch overflow. This prevents overflow from being permanently locked
//    by a few successful requests.
// 4. Eviction is amortized via an `earliestExpiry` timestamp: when full,
//    we only scan if the earliest known expiry has passed. Otherwise we
//    go straight to overflow, avoiding O(maxKeys) work per unseen request.
//
// Usage:
//   - `check(key)` is a shorthand for login flows: it records an attempt
//     against the resolved bucket (own or overflow) and returns whether
//     the caller is allowed. On success, call `reset(key)`.
//   - For flows where success/failure is known separately, use `peek(key)`
//     to check (read-only), then `recordFailure(key)` or `reset(key)`.
export type RateLimiterOptions = {
  maxAttempts?: number
  windowMs?: number
  now?: () => number
  maxKeys?: number
}

export type RateLimiter = {
  /** Records an attempt and returns true if allowed (not rate-limited).
   *  On success, call reset(key). */
  check(key: string): boolean
  /** Read-only: returns true if the key is NOT rate-limited. Does not record. */
  peek(key: string): boolean
  /** Records a failure attempt against the resolved bucket. */
  recordFailure(key: string): void
  /** Records a successful outcome and clears the key's own bucket. */
  reset(key: string): void
  /** Returns the current failure count for a key. */
  count(key: string): number
}

const DEFAULT_MAX_ATTEMPTS = 10
const DEFAULT_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_MAX_KEYS = 10_000
const OVERFLOW_KEY = "__overflow__"

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
  const now = options.now ?? (() => Date.now())
  const buckets = new Map<string, number[]>()
  // Earliest expiry across all buckets. -Infinity means "unknown / needs scan".
  let earliestExpiry = -Infinity

  function prune(times: number[], t: number): number[] {
    const cutoff = t - windowMs
    let i = 0
    while (i < times.length && (times[i] as number) <= cutoff) i++
    return i === 0 ? times : times.slice(i)
  }

  function resolveKey(key: string, t: number): string {
    // Existing keys always use their own bucket.
    if (buckets.has(key)) return key
    // New key: check capacity.
    if (buckets.size < maxKeys) return key
    // At capacity: only try eviction if the earliest expiry has passed.
    // This amortizes the O(maxKeys) scan to once per window, not per request.
    if (t < earliestExpiry) return OVERFLOW_KEY
    // Scan and evict expired keys.
    let nextEarliest = Infinity
    let evicted = false
    for (const [k, times] of buckets) {
      const pruned = prune(times, t)
      if (pruned.length === 0) {
        buckets.delete(k)
        evicted = true
      } else {
        buckets.set(k, pruned)
        // The earliest entry in this bucket is the expiry candidate.
        const expiry = (pruned[0] as number) + windowMs
        if (expiry < nextEarliest) nextEarliest = expiry
      }
    }
    if (evicted && buckets.size < maxKeys) {
      earliestExpiry = nextEarliest
      return key
    }
    // Still full: route unseen key to shared overflow bucket.
    earliestExpiry = nextEarliest === Infinity ? -Infinity : nextEarliest
    return OVERFLOW_KEY
  }

  function recordAttempt(effectiveKey: string, t: number): void {
    const times = prune(buckets.get(effectiveKey) ?? [], t)
    times.push(t)
    // Update earliestExpiry if this bucket's earliest entry is sooner.
    const expiry = (times[0] as number) + windowMs
    if (expiry < earliestExpiry || earliestExpiry === -Infinity) {
      earliestExpiry = expiry
    }
    buckets.set(effectiveKey, times)
  }

  return {
    check(key: string): boolean {
      const t = now()
      const effectiveKey = resolveKey(key, t)
      const times = prune(buckets.get(effectiveKey) ?? [], t)
      if (times.length >= maxAttempts) {
        buckets.set(effectiveKey, times)
        return false
      }
      recordAttempt(effectiveKey, t)
      return true
    },
    peek(key: string): boolean {
      const t = now()
      const effectiveKey = resolveKey(key, t)
      const times = prune(buckets.get(effectiveKey) ?? [], t)
      return times.length < maxAttempts
    },
    recordFailure(key: string): void {
      const t = now()
      const effectiveKey = resolveKey(key, t)
      recordAttempt(effectiveKey, t)
    },
    reset(key: string): void {
      // Only delete the key's own bucket. Don't touch overflow - it's shared
      // and only records failures, so a success on one key can't clear it.
      buckets.delete(key)
    },
    count(key: string): number {
      const t = now()
      return prune(buckets.get(key) ?? [], t).length
    },
  }
}

