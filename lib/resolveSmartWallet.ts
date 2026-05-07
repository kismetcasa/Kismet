import { isAddress } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'

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
  const revalidate = options.revalidate ?? 3600

  let res: Response
  try {
    const url = new URL(`${INPROCESS_API}/smartwallet`)
    url.searchParams.set('artist_wallet', artistWallet)
    res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate },
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

  return candidate.toLowerCase()
}
