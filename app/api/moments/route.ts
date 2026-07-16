import { NextRequest, NextResponse, after } from 'next/server'
import type { Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { inprocessUrl, type MomentSaleConfig } from '@/lib/inprocess'
import { resolveOnchainSalesBatch } from '@/lib/saleConfig'
import { serverBaseClient } from '@/lib/rpc'
import { recordSaleEnds } from '@/lib/saleEnds'
import { bestEffort } from '@/lib/bestEffort'

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
// Per-upstream timeout so one slow /moment can't pin the whole batch. Lowered
// from 8s: this Promise.all resolves only when the SLOWEST inprocess /moment
// does, so it's the head-of-line bound on every visible price. 2.5s comfortably
// covers a warm (revalidate:60) read and a normal cold one; a genuinely
// stalled upstream now drops that one id to Phase 2 / a loading state in 2.5s
// instead of holding the whole page's prices for 8s.
const UPSTREAM_TIMEOUT_MS = 2500
const CHAIN_ID = '8453'
// Bound the on-chain price fallback (Phase 2). Now that the fallback prices
// every gap in ONE multicall (resolveOnchainSalesBatch), the old
// amplification worry (MAX_IDS × 2 SEQUENTIAL RPC reads) is gone — a batch of
// gaps is a single eth_call regardless of count — so this rises to MAX_IDS:
// the whole page's gaps resolve in that one call, no id left on a loading
// state when the sale is genuinely live on chain.
const MAX_ONCHAIN_FALLBACK = MAX_IDS

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
    // ONE multicall prices every gap (both strategies per token), replacing the
    // old per-token fan-out (up to gaps × 2 sequential eth_calls) — a single
    // round trip that a rate-limited RPC tolerates where the fan-out storm did
    // not. Best-effort: a whole-multicall failure leaves the gaps null (their
    // loading state), and the badge is display-only — collect reads its own
    // authoritative price at click time.
    const priced = await resolveOnchainSalesBatch(
      serverBaseClient(),
      gaps.map((e) => ({ collection: e.address as Address, tokenId: BigInt(e.tokenId) })),
    )
    for (const e of gaps) {
      const config = priced.get(`${e.address.toLowerCase()}:${BigInt(e.tokenId).toString()}`)
      if (config) e.config = config
    }
  }

  // Write-through the resolved sale windows into the ending-soon index
  // (lib/saleEnds.ts). This runs whenever a batch is priced at the origin
  // (cache misses + background revalidations), so the index self-backfills
  // from normal browsing — no extra upstream reads, and post-response via
  // after() so it never adds latency to the batch. The member tokenId is
  // BigInt-canonicalized (same normalization /api/collect applies to the
  // trending members): the response stays keyed by the id the client sent,
  // but the index must use the canonical form the timeline's token_id
  // lookup produces — and so a crafted "007"-style id can't plant orphan
  // members that squat the index's 10k cap.
  after(() =>
    recordSaleEnds(
      results.map((e) => ({
        key: `${e.address.toLowerCase()}:${BigInt(e.tokenId).toString()}`,
        config: e.config,
      })),
    ).catch(bestEffort('moments.recordSaleEnds')),
  )

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
