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
  // at capacity after eviction, unseen keys fall back to a shared "overflow"
  // bucket. Existing keys ALWAYS use their own bucket (no cross-contamination).
  const OVERFLOW_KEY = "__overflow__"
  function resolveKey(key: string, t: number): string {
    // Existing keys always use their own bucket.
    if (buckets.has(key)) return key
    // New key: check capacity.
    if (buckets.size < maxKeys) return key
    // At capacity: try evicting expired keys first.
    for (const [k, times] of buckets) {
      const pruned = prune(times, t)
      if (pruned.length === 0) {
        buckets.delete(k)
      } else {
        buckets.set(k, pruned)
      }
    }
    if (buckets.size < maxKeys) return key
    // Still full: route unseen key to shared overflow bucket.
    return OVERFLOW_KEY
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
      times.push(t)
      buckets.set(effectiveKey, times)
      return true
    },
    reset(key: string): void {
      // Only delete the key's own bucket. Don't touch overflow - it's shared.
      buckets.delete(key)
    },
    count(key: string): number {
      const t = now()
      return prune(buckets.get(key) ?? [], t).length
    },
  }
}
