import { gatewayUrls } from './gateways'

// Backoff schedule between probe rounds. First entry is 0 so the immediate
// try doesn't pay a sleep; once the schedule is exhausted the LAST entry
// repeats until `budgetMs` runs out — the budget, not this array, bounds the
// polling. (An earlier version iterated the array exactly once, which
// silently capped every call at ~43s of polling and made wider budgets —
// like the mint flow's 90s media budget — unreachable dead config.)
const BACKOFF_MS = [0, 1000, 2000, 3000, 5000, 8000]

// Per-probe timeout. Without it, a gateway whose socket hangs (never
// resolves or rejects) makes Promise.any below never settle — it only
// rejects once ALL probes reject — so a single stuck gateway strands the
// whole call past budgetMs. Bounding each probe lets a hung gateway reject
// so the round can settle and the backoff loop advances.
const PROBE_TIMEOUT_MS = 8000

/**
 * Poll the gateway pool for `uri` until any HEAD returns 200 or `budgetMs`
 * is exhausted. Used pre-mint to verify Turbo upload propagation: a 404 from
 * every gateway means the bundle hasn't propagated, and committing a mint
 * that references it produces a moment with empty/stale metadata. Probing
 * the pool in parallel is robust to single-edge stale 404s during the
 * propagation window.
 *
 * Returns true on the first 200 from any gateway, false once the budget is
 * spent (checked before each round so we never sleep past it). Per-gateway
 * network errors are treated as transient.
 */
export async function verifyArweaveAvailable(
  uri: string,
  budgetMs: number = 45_000,
): Promise<boolean> {
  const urls = gatewayUrls(uri)
  if (urls.length === 0) return false
  const start = Date.now()
  for (let round = 0; ; round++) {
    const delay = BACKOFF_MS[Math.min(round, BACKOFF_MS.length - 1)]
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
}
