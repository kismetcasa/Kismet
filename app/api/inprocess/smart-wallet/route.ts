import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'

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
 * still proxy through our server so we can normalize the response and
 * cache via Next.js's fetch deduplication (1h; the address is per-EOA
 * and effectively immutable).
 */
export const revalidate = 3600

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artistWallet = searchParams.get('artist_wallet')
  if (!artistWallet || !isAddress(artistWallet)) {
    return NextResponse.json({ error: 'artist_wallet required' }, { status: 400 })
  }

  let upstream: Response
  try {
    const url = new URL(`${INPROCESS_API}/smartwallet`)
    url.searchParams.set('artist_wallet', artistWallet)
    upstream = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 3600 },
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: 'upstream unreachable',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    )
  }

  const text = await upstream.text()
  if (!upstream.ok) {
    console.error(
      `[inprocess/smart-wallet] upstream ${upstream.status} for artist=${artistWallet}: ${text.slice(0, 500)}`,
    )
    return NextResponse.json(
      { error: 'upstream error', status: upstream.status, detail: text.slice(0, 200) },
      { status: 502 },
    )
  }

  // Documented shape is `{ address: "0x..." }`. Be defensive about a few
  // common alternates and a raw address string in case the docs drift.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
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

  if (typeof candidate !== 'string' || !isAddress(candidate)) {
    console.error(
      `[inprocess/smart-wallet] could not extract address for artist=${artistWallet}: ${text.slice(0, 500)}`,
    )
    return NextResponse.json({ error: 'invalid upstream response' }, { status: 502 })
  }

  // Lowercase for stable comparison/storage; viem accepts any casing.
  return NextResponse.json({ address: candidate.toLowerCase() })
}
