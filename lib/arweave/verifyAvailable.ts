import { resolveUri } from '@/lib/inprocess'

// First entry is 0 so the immediate try doesn't pay a sleep.
const BACKOFF_MS = [0, 1000, 2000, 3000, 5000, 8000, 8000, 8000, 8000]

/**
 * Poll an `ar://` (or HTTPS) URI until a HEAD returns 200 or the budget
 * is exhausted. Used pre-mint to verify Turbo upload propagation: a 404
 * here means the gateway hasn't yet seen the bundle, and committing a
 * mint that references it produces a moment with empty/stale metadata.
 *
 * Returns true on first 200, false if the budget runs out. Network
 * errors are treated as transient — keep polling rather than fail fast.
 */
export async function verifyArweaveAvailable(
  uri: string,
  budgetMs: number = 45_000,
): Promise<boolean> {
  const url = resolveUri(uri)
  const start = Date.now()
  for (const delay of BACKOFF_MS) {
    if (Date.now() - start + delay >= budgetMs) return false
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      if (res.ok) return true
    } catch { /* transient — keep polling */ }
  }
  return false
}
