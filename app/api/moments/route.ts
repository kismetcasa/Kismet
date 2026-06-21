import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { inprocessUrl, type MomentSaleConfig } from '@/lib/inprocess'
import { resolveOnchainSale } from '@/lib/saleConfig'
import { serverBaseClient } from '@/lib/rpc'
import { USDC_BASE } from '@/lib/zoraMint'

// Lean batch sibling of /api/moment for the feed's price badges. A feed card
// needs ONLY saleConfig (price + currency) — not the hidden/creator stitch
// /api/moment layers on — so this skips every KV read and returns just an
// id → saleConfig map. The client coalesces its dwell-gated per-card requests
// into one call here (see hooks/useMomentSale), turning N per-card fetches
// into one per visible page. Each upstream /moment read reuses the same
// per-pod fetch cache (revalidate: 60) /api/moment uses, so overlapping
// batches hit warm data instead of re-fanning-out to inprocess.

// Bound the fan-out so a single request can't make us hammer inprocess with an
// unbounded id list. The client batches at the same ceiling.
const MAX_IDS = 50
// Per-upstream timeout so one slow /moment can't pin the whole batch — the
// timeout the single /api/moment route is missing (SCALING_AUDIT §6a).
const UPSTREAM_TIMEOUT_MS = 8000
const CHAIN_ID = '8453'
// Bound the on-chain price fallback (Phase 2) so a crafted batch of
// saleConfig-less ids can't amplify one request into MAX_IDS × 2 RPC reads.
// Feed gaps are the exception, so a small cap covers the real case; the rest
// degrade to a loading state (collect still reads its own authoritative price).
const MAX_ONCHAIN_FALLBACK = 12

// Map resolveOnchainSale's {pricePerToken, currency} to the MomentSaleConfig the
// feed would have returned, so display consumers (useMomentSale → MomentCard)
// stay agnostic to whether the price came from inprocess or chain. saleStart/End
// are intentionally omitted — resolveOnchainSale only returns a LIVE sale, and
// MomentCard treats an absent window as "active" (saleEnd 0 → not ended).
function synthesizeSaleConfig(sale: {
  pricePerToken: bigint
  currency: 'eth' | 'usdc'
}): MomentSaleConfig {
  return {
    type: sale.currency === 'usdc' ? 'erc20Mint' : 'fixedPrice',
    pricePerToken: sale.pricePerToken.toString(),
    ...(sale.currency === 'usdc' ? { currency: USDC_BASE } : {}),
  }
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('ids')
  if (!raw) return NextResponse.json({ sales: {} })

  // Parse + validate + dedupe `address:tokenId` pairs. Drop anything malformed
  // rather than 400-ing the whole batch — one bad id shouldn't sink a visible
  // page's prices.
  const seen = new Set<string>()
  const ids: { key: string; address: string; tokenId: string }[] = []
  for (const part of raw.split(',')) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    const address = part.slice(0, idx)
    const tokenId = part.slice(idx + 1)
    if (!isAddress(address) || !isValidTokenId(tokenId)) continue
    const key = `${address.toLowerCase()}:${tokenId}`
    if (seen.has(key)) continue
    seen.add(key)
    ids.push({ key, address, tokenId })
    if (ids.length >= MAX_IDS) break
  }

  // Phase 1: the feed (inprocess /moment) — the fast path for the price badge.
  const results = await Promise.all(
    ids.map(
      async ({
        key,
        address,
        tokenId,
      }): Promise<{
        key: string
        address: string
        tokenId: string
        config: MomentSaleConfig | null
      }> => {
        try {
          const url = inprocessUrl('/moment', {
            collectionAddress: address,
            tokenId,
            chainId: CHAIN_ID,
          })
          const r = await fetch(url, {
            headers: { Accept: 'application/json' },
            next: { revalidate: 60 },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          })
          if (!r.ok) return { key, address, tokenId, config: null }
          const data = (await r.json()) as { saleConfig?: MomentSaleConfig }
          return { key, address, tokenId, config: data.saleConfig ?? null }
        } catch {
          // Upstream error / timeout / malformed JSON — degrade this one id to
          // null; Phase 2 (or a later mount) can still fill it.
          return { key, address, tokenId, config: null }
        }
      },
    ),
  )

  // Phase 2: for moments the feed didn't price (writing moments / fresh mints
  // during an indexer gap), fall back to the authoritative on-chain sale — the
  // same source the collect action reads — so the badge isn't blank while the
  // sale is genuinely live. Bounded + best-effort; a still-null id just shows
  // its loading state.
  const gaps = results.filter((e) => e.config === null).slice(0, MAX_ONCHAIN_FALLBACK)
  if (gaps.length) {
    const client = serverBaseClient()
    await Promise.all(
      gaps.map(async (e) => {
        const sale = await resolveOnchainSale(
          client,
          e.address as Address,
          BigInt(e.tokenId),
        ).catch(() => null)
        if (sale) e.config = synthesizeSaleConfig(sale)
      }),
    )
  }

  return NextResponse.json(
    { sales: Object.fromEntries(results.map((e) => [e.key, e.config])) },
    {
      // Sale config is viewer-independent (same for everyone), so a short
      // shared-cache window is safe; it also bounds how often the Phase-2
      // on-chain fallback runs for the same batch (once per s-maxage window).
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    },
  )
}
