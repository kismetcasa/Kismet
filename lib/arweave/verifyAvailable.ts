import { resolveUri } from '@/lib/inprocess'

// Capped exponential backoff in ms. The cumulative wall clock through
// the full schedule is 38s; the budgetMs check stops earlier if needed.
const BACKOFF_MS = [1000, 2000, 3000, 5000, 8000, 8000, 8000, 8000]

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

  // Try once immediately so an already-propagated upload doesn't pay
  // the first sleep.
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    if (res.ok) return true
  } catch { /* network blip — fall through to retry loop */ }

  for (const delay of BACKOFF_MS) {
    if (Date.now() - start + delay >= budgetMs) return false
    await new Promise((r) => setTimeout(r, delay))
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      if (res.ok) return true
    } catch { /* keep trying */ }
  }
  return false
}
