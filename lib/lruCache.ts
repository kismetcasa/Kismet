/**
 * Tiny LRU cache built on Map insertion order. `get` bumps the key to
 * most-recently-used; `set` evicts the least-recently-used at capacity.
 * Used by the browser-side caches in lib/momentCache, lib/textCache,
 * lib/profileCache, lib/collectionCache — bare `new Map()` versions
 * leaked memory in long sessions — and by the server-side
 * lib/resolveSmartWallet cache, where the same unbounded-Map leak applies
 * to the long-lived Node process.
 */
export class LRUCache<K, V> {
  private store = new Map<K, V>()
  // Assigned explicitly (not a constructor parameter property) so the module
  // loads under Node's strip-only TypeScript mode — the verify scripts
  // (scripts/verify-img-range.ts) import server modules that use this cache.
  private readonly max: number
  constructor(max: number) {
    this.max = max
  }

  get(key: K): V | undefined {
    const value = this.store.get(key)
    if (value === undefined) return undefined
    this.store.delete(key)
    this.store.set(key, value)
    return value
  }

  has(key: K): boolean {
    return this.store.has(key)
  }

  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.max) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, value)
  }
}
