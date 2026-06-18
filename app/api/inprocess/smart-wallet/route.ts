import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { resolveSmartWallet } from '@/lib/resolveSmartWallet'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Returns the inprocess platform smart wallet address bound to a given
 * artist EOA. Each artist (each EOA) has their own ERC-4337 smart account
 * on inprocess; that smart account is the one that needs ADMIN on a
 * collection for the artist's mints to land. Used by:
 *
 *   - CreateCollectionForm at deploy time (lookup the deployer's smart
 *     wallet and grant it ADMIN as a setupAction)
 *   - CollectionView for the retroactive authorize flow (lookup the
 *     creator's smart wallet, check if it already has ADMIN, surface a
 *     one-click banner if not)
 *
 * Per inprocess docs (GET /api/smartwallet) the lookup is keyed off
 * `artist_wallet` and requires no API key — it's a public read. We
 * proxy through our server so we can normalize the response (multiple
 * historical shape variants — see lib/resolveSmartWallet.ts) and
 * cache via Next.js's fetch deduplication (1h; the address is per-EOA
 * and effectively immutable).
 *
 * Defensive parsing lives in lib/resolveSmartWallet.ts so the
 * server-side audit endpoint and this proxy can never drift on which
 * upstream response shapes they accept.
 */
export const revalidate = 3600

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artistWallet = searchParams.get('artist_wallet')
  if (!artistWallet || !isAddress(artistWallet)) {
    return errorResponse(400, 'artist_wallet required')
  }

  const result = await resolveSmartWallet(artistWallet)
  if (!result) {
    // Transient failure (network, timeout, 5xx from inprocess).
    console.error(
      `[inprocess/smart-wallet] transient failure resolving smart wallet for artist=${artistWallet}`,
    )
    return errorResponse(502, 'could not resolve smart wallet')
  }
  if ('notFound' in result) {
    // The EOA has no inprocess account — permanent, not transient.
    return errorResponse(404, 'no inprocess account for this wallet')
  }
  return NextResponse.json({ address: result.address })
}
