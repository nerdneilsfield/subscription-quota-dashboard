export type RateLimiterOptions = {
  maxAttempts?: number
  windowMs?: number
  now?: () => number
  maxKeys?: number
}

export type RateLimiter = {
  check(key: string): boolean
  reset(key: string): void
  count(key: string): number
}

const DEFAULT_MAX_ATTEMPTS = 10
const DEFAULT_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_MAX_KEYS = 10_000

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS
  const now = options.now ?? (() => Date.now())
  const buckets = new Map<string, number[]>()

  function prune(times: number[], t: number): number[] {
    const cutoff = t - windowMs
    let i = 0
    while (i < times.length && (times[i] as number) <= cutoff) i++
    return i === 0 ? times : times.slice(i)
  }

  // Evict expired keys to prevent unbounded Map growth. If the Map is still
  // at capacity after eviction, fall back to a shared "overflow" bucket so
  // new keys don't increase memory usage (they share the overflow entry).
  const OVERFLOW_KEY = "__overflow__"
  function evictOrOverflow(t: number, key: string): string {
    if (buckets.size < maxKeys) return key
    // Try evicting expired keys first.
    let evicted = 0
    for (const [k, times] of buckets) {
      const pruned = prune(times, t)
      if (pruned.length === 0) {
        buckets.delete(k)
        evicted++
      } else {
        buckets.set(k, pruned)
      }
    }
    if (buckets.size < maxKeys) return key
    // Still full: route to overflow bucket to prevent unbounded growth.
    return OVERFLOW_KEY
  }

  return {
    check(key: string): boolean {
      const t = now()
      const effectiveKey = evictOrOverflow(t, key)
      const times = prune(buckets.get(effectiveKey) ?? [], t)
      if (times.length >= maxAttempts) {
        buckets.set(effectiveKey, times)
        return false
      }
      times.push(t)
      buckets.set(effectiveKey, times)
      return true
    },
    reset(key: string): void {
      buckets.delete(key)
      buckets.delete(OVERFLOW_KEY)
    },
    count(key: string): number {
      const t = now()
      return prune(buckets.get(key) ?? [], t).length
    },
  }
}
