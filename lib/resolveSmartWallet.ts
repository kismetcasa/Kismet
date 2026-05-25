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
 * Resolves an artist's inprocess smart wallet address from their EOA via
 * `GET /api/smartwallet`. Centralizes the defensive shape parsing —
 * inprocess's documented response is `{ address }` but real responses
 * have historically used `smartWallet` / `smart_wallet` / `smartAccount`
 * or a raw address string. Accepting all known shapes here ensures every
 * call site sees the same lenient parsing.
 *
 * Returns the lowercased address on success, or null on any failure
 * (invalid input, network, non-200, unparseable response). Callers
 * surface their own errors (HTTP 502, "skipped" log, etc.).
 */
export async function resolveSmartWallet(
  artistWallet: string,
  options: { revalidate?: number } = {},
): Promise<string | null> {
  if (!isAddress(artistWallet)) return null
  const key = artistWallet.toLowerCase()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value

  const revalidate = options.revalidate ?? 3600

  let res: Response
  try {
    const url = inprocessUrl('/smartwallet', { artist_wallet: artistWallet })
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    return null
  }

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

  if (typeof candidate !== 'string' || !isAddress(candidate)) return null

  const resolved = candidate.toLowerCase()
  cache.set(key, { value: resolved, expiresAt: Date.now() + TTL_MS })
  return resolved
}
