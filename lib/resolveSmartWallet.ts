import { isAddress } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'
import { getCachedSmartWallet, setCachedSmartWallet } from '@/lib/smartWalletCache'
import { parseSmartWalletAddress } from '@/lib/smartWalletShape'
import { LRUCache } from '@/lib/lruCache'

// Two-layer per-EOA cache. Smart-wallet ↔ EOA is deterministic per inprocess's
// derivation, so once resolved it doesn't change.
//   1. In-memory (this Map): 24h TTL, per server instance, zero-latency hot path.
//   2. Durable (Redis, lib/smartWalletCache): survives restarts/deploys and is
//      shared across instances. Written on every successful live resolution and
//      read as a FALLBACK when the live /smartwallet lookup transiently fails —
//      so the deploy grant, mint preflight, and authorize banner all keep
//      working through an inprocess outage for any EOA resolved at least once
//      before. Only successful resolutions are cached; a definitive 404 (no
//      account) is never masked by the durable layer.
// Bounded LRU, not a bare Map: an unbounded module-level Map with lazy-only
// TTL expiry grows for the life of the process (one entry per creator EOA
// ever resolved). The TTL check on read still governs freshness; the LRU cap
// governs memory.
const cache = new LRUCache<string, { value: string; expiresAt: number }>(2000)
const TTL_MS = 24 * 60 * 60 * 1000

// Bound the upstream call so a stalled inprocess endpoint can't hang the
// request indefinitely. Callers treat the resulting null as "could not
// resolve" (HTTP 502) and surface a retryable error instead of spinning.
const UPSTREAM_TIMEOUT_MS = 10_000

/**
 * Result of a smart wallet lookup.
 * - `{ address }`: resolved successfully.
 * - `{ notFound: true }`: the EOA has no inprocess account (404 or the
 *   response contained no parseable address). Permanent — retrying won't help.
 * - `null`: transient failure (network error, timeout, 5xx). Retrying may help.
 */
export type SmartWalletResult = { address: string } | { notFound: true } | null

/**
 * Resolves a creator's inprocess SMART WALLET from their EOA via
 * `GET /api/smartwallet`.
 *
 * WHY THIS IS LOAD-BEARING (confirmed on-chain, 2026): this per-creator smart
 * wallet is the account inprocess EXECUTES `/moment/create` as. It holds ADMIN
 * at tokenId 0 on Kismet-minted collections; the platform OPERATOR wallet does
 * NOT (verified on a live collection: permissions(0, operator)=0,
 * permissions(0, perCreatorSmartWallet)=2). So this lookup is the linchpin of
 * BOTH deploy-time relay authorization and the mint preflight — if it returns
 * the wrong address (or nothing), the deploy skips the relay's ADMIN grant and
 * mints later revert at gas estimation. The OPERATOR wallet is a *separate*
 * concern (the airdrop / admin-write path); do not conflate the two.
 *
 * Centralizes the defensive shape parsing — the documented response is
 * `{ address }`, but real responses have used `smartWallet` / `smart_wallet`
 * / `smartAccount` / a raw string. Returns `{ address }` on success,
 * `{ notFound: true }` when the EOA has no inprocess account, or null on
 * transient failure (network/5xx/timeout).
 */
export async function resolveSmartWallet(
  artistWallet: string,
  options: { revalidate?: number; skipCache?: boolean } = {},
): Promise<SmartWalletResult> {
  if (!isAddress(artistWallet)) return { notFound: true }
  const key = artistWallet.toLowerCase()
  // skipCache is for the boot drift-detector (lib/healthcheck): it must hit the
  // LIVE endpoint and treat a 5xx as a real failure — not be short-circuited by a
  // warm in-memory hit, nor rescued by the durable fallback below. Otherwise a
  // systemic /smartwallet outage is masked by the last-known wallet and the probe
  // reports a false all-clear (the exact kind of systemic /smartwallet outage it exists to catch).
  if (!options.skipCache) {
    const hit = cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return { address: hit.value }
  }

  // Durable fallback for TRANSIENT live-lookup failures only (network/timeout/
  // 5xx/4xx-drift — NOT a definitive 404). Serving the last-known smart wallet
  // from Redis is what keeps the deploy grant / preflight / banner working
  // through an inprocess /smartwallet outage instead of silently skipping the
  // ADMIN grant. Promotes the hit back into the in-memory cache.
  const fromDurableCache = async (): Promise<SmartWalletResult> => {
    // The drift-detector (skipCache) wants live truth, never the cached fallback,
    // so a live 5xx surfaces as the real failure it exists to alarm on.
    if (options.skipCache) return null
    const cached = await getCachedSmartWallet(key)
    if (cached && isAddress(cached)) {
      const resolved = cached.toLowerCase()
      cache.set(key, { value: resolved, expiresAt: Date.now() + TTL_MS })
      return { address: resolved }
    }
    return null
  }

  const revalidate = options.revalidate ?? 3600

  let res: Response
  try {
    // Per the authoritative inprocess OpenAPI spec (confirmed directly by their
    // team, 2026): GET /api/smartwallet takes EXACTLY one of `accountId` (UUID)
    // or `walletAddress` (the creator EOA). `artist_wallet` — a stale name from
    // older docs — is not a recognized param. We only have the EOA, so we send
    // `walletAddress` alone: an unrecognized param is at best ignored, at worst
    // rejected by a strict validator, so it earns no place here. This lookup is
    // load-bearing — a null result surfaces as 502 and silently skips the
    // deploy-time ADMIN grant — so the request must match the spec exactly.
    const url = inprocessUrl('/smartwallet', {
      walletAddress: artistWallet,
    })
    // KEYLESS by design. /smartwallet is a PUBLIC read endpoint, and the last
    // known-working shape of this call sent NO auth header here — only `Accept`.
    // The API key is accepted on the WRITE endpoints (/moment/create,
    // /distribute, /update-uri — which all keep it), but a public read route
    // doesn't need it, so we send the request bare to match the historically-
    // working shape rather than couple reads to the key.
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      // The drift-detector (skipCache) must hit the LIVE endpoint, so bypass
      // Next's fetch Data Cache too — otherwise a stale cached 200 (up to the
      // revalidate window) could mask a live outage and report a false all-clear,
      // partially defeating skipCache's purpose. Normal callers keep the 1h cache.
      ...(options.skipCache ? { cache: 'no-store' as const } : { next: { revalidate } }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    // Network error or timeout — transient. Serve the last-known wallet.
    return fromDurableCache()
  }

  // 404 means inprocess has no account for this EOA — permanent, not transient.
  // Trust it definitively (do NOT fall back to the durable cache): the account
  // genuinely doesn't exist, and the UI guides the creator to create one.
  if (res.status === 404) return { notFound: true }
  if (!res.ok) {
    // Log the upstream error body so an API-contract drift (e.g. a renamed
    // query param returning 400 "Invalid input") is visible in logs at once,
    // instead of silently degrading to a null/skipped-grant. Bounded slice.
    const detail = await res.text().catch(() => '')
    console.error(`[resolveSmartWallet] upstream ${res.status} for ${key}: ${detail.slice(0, 300)}`)
    // Transient 5xx / 4xx-drift — fall back to the durable cache rather than null.
    return fromDurableCache()
  }

  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Some responses come back as a bare address string.
    parsed = text.trim()
  }

  // Defensive shape parsing pinned by scripts/verify-smartwallet.ts — accepts
  // { address } / { smartWallet } / { smart_wallet } / { smartAccount } / a raw
  // string. Parseable response but no valid address → not found, not transient.
  const resolved = parseSmartWalletAddress(parsed)
  if (!resolved) return { notFound: true }
  cache.set(key, { value: resolved, expiresAt: Date.now() + TTL_MS })
  // Persist for cross-instance / cross-deploy resilience so a later lookup can
  // fall back to this when inprocess is unreachable. Awaited (a fast Redis
  // write; setCachedSmartWallet never throws) so the write isn't dropped when a
  // serverless function freezes after returning.
  await setCachedSmartWallet(key, resolved)
  return { address: resolved }
}
