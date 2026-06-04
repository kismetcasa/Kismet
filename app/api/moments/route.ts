import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { inprocessUrl, type MomentSaleConfig } from '@/lib/inprocess'

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

  const entries = await Promise.all(
    ids.map(async ({ key, address, tokenId }): Promise<[string, MomentSaleConfig | null]> => {
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
        if (!r.ok) return [key, null]
        const data = (await r.json()) as { saleConfig?: MomentSaleConfig }
        return [key, data.saleConfig ?? null]
      } catch {
        // Upstream error / timeout / malformed JSON — degrade this one id to
        // null; the card shows its loading state and a later mount retries.
        return [key, null]
      }
    }),
  )

  return NextResponse.json(
    { sales: Object.fromEntries(entries) },
    {
      // Sale config is viewer-independent (same for everyone), so a short
      // shared-cache window is safe; the real dedupe is the per-/moment
      // revalidate:60 fetch cache above.
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    },
  )
}
