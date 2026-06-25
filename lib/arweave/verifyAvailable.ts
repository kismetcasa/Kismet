import { gatewayUrls } from './gateways'

// Backoff schedule between probe rounds. First entry is 0 so the immediate
// try doesn't pay a sleep; once the schedule is exhausted the LAST entry
// repeats until `budgetMs` runs out — the budget, not this array, bounds the
// polling. (An earlier version iterated the array exactly once, which
// silently capped every call at ~43s of polling and made wider budgets
// unreachable dead config — so callers' budgets are now honored exactly.)
const BACKOFF_MS = [0, 1000, 2000, 3000, 5000, 8000]

// Per-probe timeout. Without it, a gateway whose socket hangs (never
// resolves or rejects) makes Promise.any below never settle — it only
// rejects once ALL probes reject — so a single stuck gateway strands the
// whole call past budgetMs. Bounding each probe lets a hung gateway reject
// so the round can settle and the backoff loop advances. 12s (was 8s) gives
// the apex→sandbox redirect + TLS + range request room; an 8s ceiling was
// firing mid-redirect (ERR_ABORTED) on slower gateways.
const PROBE_TIMEOUT_MS = 12000

/**
 * Poll the gateway pool for `uri` until any gateway serves it (200/206) or
 * `budgetMs` is exhausted. Used pre-mint as a BEST-EFFORT propagation wait —
 * callers no longer hard-block on the result (Turbo guarantees durability
 * once it returns an id; inprocess's own flow mints without this check), they
 * just wait briefly to avoid a momentarily-broken display. Probing the pool
 * in parallel is robust to single-edge stale 404s during the propagation
 * window. (That fallback currently applies to ipfs:// and to any AR.IO gateway
 * re-added to the pool; the Arweave side is a single host today.)
 *
 * Returns true on the first success from any gateway, false once the budget is
 * spent (checked before each round so we never sleep past it). Per-gateway
 * network errors (incl. TLS failures on a down gateway) are treated as
 * transient.
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
        // GET one byte, not HEAD. AR.IO gateways 302 /:id to a per-item
        // sandbox subdomain and serve freshly-uploaded (optimistically cached)
        // data reliably on GET range requests, while HEAD on that redirect was
        // observed returning ERR_ABORTED/404 even when the bytes were
        // retrievable. Range: bytes=0-0 keeps it to a single byte; we cancel
        // the body so a gateway that ignores Range can't stream the whole file.
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        cache: 'no-store',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }).then((r) => {
        r.body?.cancel?.()
        return r.ok ? Promise.resolve() : Promise.reject(new Error(`${r.status}`))
      }),
    )
    try {
      await Promise.any(probes)
      return true
    } catch {
      // every gateway 404'd or errored — keep polling
    }
  }
}
