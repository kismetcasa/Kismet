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
 * Resolves an artist's inprocess smart wallet address from their EOA via
 * `GET /api/smartwallet`. Centralizes the defensive shape parsing —
 * inprocess's documented response is `{ address }` but real responses
 * have historically used `smartWallet` / `smart_wallet` / `smartAccount`
 * or a raw address string. Accepting all known shapes here ensures every
 * call site sees the same lenient parsing.
 *
 * Returns `{ address }` on success, `{ notFound: true }` when the EOA has
 * no inprocess account, or null on transient failure (network/5xx/timeout).
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
    // Param-name resilience. inprocess's published docs (smartwallet/get)
    // document `artist_wallet`, but commit b9097dc moved us to `walletAddress`
    // "per inprocess API change" — and the two sources still disagree on
    // `main`. Guessing wrong is catastrophic and SILENT: the upstream returns
    // notFound for every artist, which drops the deploy-time ADMIN grant for
    // the relay smart wallet and makes every subsequent relayed mint revert at
    // gas estimation (the exact regression this resolver underpins). We can't
    // reach the upstream from CI to settle it, so we stop guessing: send BOTH
    // names with the same value. Unknown query params are ignored, so the
    // lookup resolves whichever name the live deployment reads.
    const url = inprocessUrl('/smartwallet', {
      artist_wallet: artistWallet,
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
  if (!res.ok) return null

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
