/**
 * Process-local TTL cache with single-flight coalescing.
 *
 * Wraps a fetcher so that:
 *   - concurrent callers during a refresh share one upstream call
 *     (no thundering herd to Upstash when the cache expires)
 *   - subsequent calls within the TTL hit the in-memory copy
 *   - `.invalidate()` drops the cache, forcing the next call to refetch
 *
 * Errors are intentionally NOT cached — a transient Upstash failure
 * shouldn't lock us into a broken state for the TTL window. The next
 * call after a rejection refetches.
 *
 * Designed for hot getters (e.g. `getTrackedCollections`) that hit
 * Upstash on every read but read data that changes rarely. Cross-pod
 * staleness is bounded by `ttlMs`; own-pod consistency is achieved by
 * calling `.invalidate()` on the write paths.
 */
export interface Memoized<T> {
  (): Promise<T>
  invalidate(): void
}

export function memoize<T>(fn: () => Promise<T>, ttlMs: number): Memoized<T> {
  let cache: { value: T; expiresAt: number } | null = null
  let inFlight: Promise<T> | null = null
  // Monotonic counter bumped on every invalidate(). An in-flight fetch
  // captures the counter at start time; its .then guard refuses to
  // populate the cache if the counter has moved on. Closes the race
  // where a fetch starts before a write but resolves after, which would
  // otherwise pin the pre-write value into cache for the full TTL.
  let generation = 0

  const wrapped = async (): Promise<T> => {
    const now = Date.now()
    if (cache && cache.expiresAt > now) return cache.value
    if (inFlight) return inFlight
    const myGen = ++generation
    inFlight = fn()
      .then((value) => {
        if (myGen === generation) {
          cache = { value, expiresAt: Date.now() + ttlMs }
        }
        return value
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  wrapped.invalidate = () => {
    cache = null
    // Drop the in-flight reference too so a caller arriving after
    // invalidate() starts a fresh fetch rather than awaiting the stale
    // one. The orphaned promise still runs but its .then no-ops thanks
    // to the generation check above.
    inFlight = null
    generation++
  }

  return wrapped as Memoized<T>
}
