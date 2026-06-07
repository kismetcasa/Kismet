'use client'

/**
 * Scout candidate discovery (Mode A, client-side) — "watch artists".
 *
 * We pull each watched artist's recent moments via the timeline's SINGULAR
 * `creator=` query, which (unlike the plural `creators=` roster) is FID-expanded
 * server-side — so it catches the artist's drops from ALL their verified wallets,
 * not just the one address the user typed. Each candidate's `creator` is then
 * RELABELED to the watched artist, so a sibling-wallet drop still satisfies the
 * engine's creator-allowlist (which holds the user-entered addresses). Prices +
 * currency come in one batch from `/api/moments` (the canonical sale-config
 * path); they're re-resolved on-chain at execution by prepare-collect-batch, so
 * any staleness here is bounded by the Spend Permission cap, not trusted.
 */

import type { Candidate, Currency } from './engine'
import { USDC_BASE } from '@/lib/zoraMint'

const PER_ARTIST_LIMIT = 30

/** Mirror of lib/inprocess.inferCollectCurrency (kept inline so this client
 *  module doesn't pull server code): type wins, else the USDC currency-address
 *  fallback for type-less sales, else ETH. */
function inferCurrency(sale: { type?: string; currency?: string }): Currency {
  if (sale.type === 'erc20Mint') return 'usdc'
  if (sale.type === 'fixedPrice') return 'eth'
  if (sale.currency && sale.currency.toLowerCase() === USDC_BASE.toLowerCase()) return 'usdc'
  return 'eth'
}

interface TimelineMoment {
  address?: string
  token_id?: string
}

interface SaleConfig {
  type?: 'fixedPrice' | 'erc20Mint'
  pricePerToken?: string
  currency?: string
}

export async function discoverCandidates(creators: readonly string[]): Promise<Candidate[]> {
  if (creators.length === 0) return []

  // 1. Each watched artist's recent moments via the FID-expanded SINGULAR query,
  //    tagged with the watched artist so a sibling-wallet drop is attributed to
  //    the artist the user chose. Parallel; newest-first per artist.
  const lists = await Promise.all(
    creators.map(async (artist) => {
      const watched = artist.toLowerCase()
      try {
        const r = await fetch(`/api/timeline?creator=${watched}&limit=${PER_ARTIST_LIMIT}`)
        if (!r.ok) return [] as Array<{ m: TimelineMoment; watched: string }>
        const d = (await r.json()) as { moments?: TimelineMoment[] }
        return (Array.isArray(d.moments) ? d.moments : []).map((m) => ({ m, watched }))
      } catch {
        return [] as Array<{ m: TimelineMoment; watched: string }>
      }
    }),
  )

  // Dedupe across artists (a collab can surface under two), preserving first-seen.
  const order: Array<{ m: TimelineMoment; watched: string }> = []
  const seen = new Set<string>()
  for (const e of lists.flat()) {
    if (!e.m?.address || !e.m?.token_id) continue
    const k = `${e.m.address.toLowerCase()}:${e.m.token_id}`
    if (seen.has(k)) continue
    seen.add(k)
    order.push(e)
  }
  if (order.length === 0) return []

  // 2. Resolve price + currency in one batch.
  const ids = order.map((e) => `${e.m.address}:${e.m.token_id}`).join(',')
  let sales: Record<string, SaleConfig | null> = {}
  try {
    const r = await fetch(`/api/moments?ids=${encodeURIComponent(ids)}`)
    if (r.ok) sales = ((await r.json()) as { sales?: Record<string, SaleConfig | null> }).sales ?? {}
  } catch {
    // No prices → no candidates this run (fail-closed; never plan blind spends).
    return []
  }

  // 3. Only items with a resolvable active sale become candidates. `creator` is
  //    the WATCHED artist (relabeled) so the engine's creator-allowlist accepts
  //    drops minted from the artist's other verified wallets.
  const candidates: Candidate[] = []
  for (const { m, watched } of order) {
    const sale = sales[`${m.address!.toLowerCase()}:${m.token_id}`]
    if (!sale?.pricePerToken) continue
    candidates.push({
      collection: m.address!,
      tokenId: m.token_id!,
      creator: watched,
      currency: inferCurrency(sale),
      pricePerToken: sale.pricePerToken,
    })
  }
  return candidates
}
