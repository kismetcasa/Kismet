import { isAddress as viemIsAddress } from 'viem'

// Server-side address check that mirrors lib/address.isAddress (strict:false):
// inprocess returns lowercased, non-checksummed addresses, so EIP-55 strict
// validation would wrongly reject them. Kept import-clean (viem only) so the
// parser below is unit-testable under --experimental-strip-types.
const isHexAddress = (v: unknown): v is string =>
  typeof v === 'string' && viemIsAddress(v, { strict: false })

/**
 * Normalize an inprocess `GET /smartwallet` response body to a lowercased
 * address, or null if it carries none.
 *
 * WHY THIS IS ITS OWN FUNCTION: the documented shape is `{ address }`, but real
 * responses have come back as `{ smartWallet }` / `{ smart_wallet }` /
 * `{ smartAccount }` / a raw address string. Narrowing this back to
 * `.address`-only silently turns every non-canonical shape into "no address" →
 * `{ notFound }` → a doomed mint that reverts at gas estimation. That exact
 * regression recurred repeatedly (param-resilient parser, discriminated-return
 * break), so the accepted-shape set is pinned by scripts/verify-smartwallet.ts.
 *
 * Precedence is `address` → `smartWallet` → `smart_wallet` → `smartAccount`, so
 * a documented field always wins when more than one is present.
 */
export function parseSmartWalletAddress(parsed: unknown): string | null {
  const candidate =
    typeof parsed === 'string'
      ? parsed
      : parsed && typeof parsed === 'object'
        ? ((parsed as Record<string, unknown>).address ??
          (parsed as Record<string, unknown>).smartWallet ??
          (parsed as Record<string, unknown>).smart_wallet ??
          (parsed as Record<string, unknown>).smartAccount)
        : undefined
  if (!isHexAddress(candidate)) return null
  return candidate.toLowerCase()
}
