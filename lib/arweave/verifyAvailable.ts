import { gatewayUrls } from './gateways'

// First entry is 0 so the immediate try doesn't pay a sleep.
const BACKOFF_MS = [0, 1000, 2000, 3000, 5000, 8000, 8000, 8000, 8000]

// Per-probe timeout. Without it, a gateway whose socket hangs (never
// resolves or rejects) makes Promise.any below never settle — it only
// rejects once ALL probes reject — so a single stuck gateway strands the
// whole call past budgetMs. Bounding each probe lets a hung gateway reject
// so the round can settle and the backoff loop advances.
const PROBE_TIMEOUT_MS = 8000

/**
 * Poll the gateway pool for `uri` until any HEAD returns 200 or the budget
 * runs out. Used pre-mint to verify Turbo upload propagation: a 404 from
 * every gateway means the bundle hasn't propagated, and committing a mint
 * that references it produces a moment with empty/stale metadata. Probing
 * the pool in parallel is robust to single-edge stale 404s during the
 * propagation window.
 *
 * Returns true on the first 200 from any gateway, false if every poll
 * exhausts. Per-gateway network errors are treated as transient.
 */
export async function verifyArweaveAvailable(
  uri: string,
  budgetMs: number = 45_000,
): Promise<boolean> {
  const urls = gatewayUrls(uri)
  if (urls.length === 0) return false
  const start = Date.now()
  for (const delay of BACKOFF_MS) {
    if (Date.now() - start + delay >= budgetMs) return false
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    const probes = urls.map((u) =>
      fetch(u, {
        method: 'HEAD',
        cache: 'no-store',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }).then((r) =>
        r.ok ? Promise.resolve() : Promise.reject(new Error(`${r.status}`)),
      ),
    )
    try {
      await Promise.any(probes)
      return true
    } catch {
      // every gateway 404'd or errored — keep polling
    }
  }
  return false
}
