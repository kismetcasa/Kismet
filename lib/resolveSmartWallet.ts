import { isAddress } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'

// Per-EOA cache. Smart-wallet ↔ EOA is deterministic per inprocess's
// derivation, so once resolved it doesn't change. 24h TTL bounds the
// drift if the algorithm ever migrates. Only successful resolutions are
// cached — nulls (network/parse failures) retry on the next call.
const cache = new Map<string, { value: string; expiresAt: number }>()
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
  options: { revalidate?: number } = {},
): Promise<SmartWalletResult> {
  if (!isAddress(artistWallet)) return { notFound: true }
  const key = artistWallet.toLowerCase()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return { address: hit.value }

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
    const headers: Record<string, string> = { Accept: 'application/json' }
    const apiKey = process.env.INPROCESS_API_KEY
    if (apiKey) headers['x-api-key'] = apiKey
    res = await fetch(url, {
      headers,
      next: { revalidate },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    // Network error or timeout — transient.
    return null
  }

  // 404 means inprocess has no account for this EOA — permanent, not transient.
  if (res.status === 404) return { notFound: true }
  if (!res.ok) {
    // Log the upstream error body so an API-contract drift (e.g. a renamed
    // query param returning 400 "Invalid input") is visible in logs at once,
    // instead of silently degrading to a null/skipped-grant. Bounded slice.
    const detail = await res.text().catch(() => '')
    console.error(`[resolveSmartWallet] upstream ${res.status} for ${key}: ${detail.slice(0, 300)}`)
    return null
  }

  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Some responses come back as a bare address string.
    parsed = text.trim()
  }

  const candidate =
    typeof parsed === 'string'
      ? parsed
      : parsed && typeof parsed === 'object'
        ? ((parsed as Record<string, unknown>).address
            ?? (parsed as Record<string, unknown>).smartWallet
            ?? (parsed as Record<string, unknown>).smart_wallet
            ?? (parsed as Record<string, unknown>).smartAccount)
        : undefined

  // Parseable response but no valid address — treat as not found rather than transient.
  if (typeof candidate !== 'string' || !isAddress(candidate)) return { notFound: true }

  const resolved = candidate.toLowerCase()
  cache.set(key, { value: resolved, expiresAt: Date.now() + TTL_MS })
  return { address: resolved }
}
