/**
 * Scout candidate discovery — "watch artists". Runtime-agnostic: pass an empty
 * baseUrl on the client (relative URLs) or the absolute origin on the server
 * (the Phase 2 autonomous run loop). Replaces the old `'use client'`
 * discoverCandidates.
 *
 * Each watched artist's recent moments come from the timeline's SINGULAR
 * `creator=` query, which (unlike the plural `creators=` roster) is FID-expanded
 * server-side — so it catches the artist's drops from ALL their verified wallets.
 * Each candidate's `creator` is RELABELED to the watched artist so a
 * sibling-wallet drop still satisfies the engine's creator-allowlist. Prices +
 * currency are a hint here (one batch from `/api/moments`); the executor
 * RE-RESOLVES the price on-chain before spending, so staleness never costs money.
 */

import type { Candidate, Currency } from './engine'
import { USDC_BASE } from '@/lib/zoraMint'

const PER_ARTIST_LIMIT = 30

/** Mirror of lib/inprocess.inferCollectCurrency: type wins, else the USDC
 *  currency-address fallback for type-less sales, else ETH. */
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

export async function discoverCore(creators: readonly string[], baseUrl = ''): Promise<Candidate[]> {
  if (creators.length === 0) return []

  // 1. Each watched artist's recent moments via the FID-expanded SINGULAR query,
  //    tagged with the watched artist. Parallel; newest-first per artist.
  const lists = await Promise.all(
    creators.map(async (artist) => {
      const watched = artist.toLowerCase()
      try {
        const r = await fetch(`${baseUrl}/api/timeline?creator=${watched}&limit=${PER_ARTIST_LIMIT}`, {
          signal: AbortSignal.timeout(8_000),
        })
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
  // Cap the batch at /api/moments' MAX_IDS (50): that route processes only the
  // first 50 ids and ignores the rest, so requesting more just builds a longer
  // URL whose tail is silently dropped. Candidates are newest-first and the agent
  // collects only a few per run (<= maxItemsPerPeriod), so the newest 50 cover it.
  const batch = order.slice(0, 50)

  // 2. Resolve price + currency in one batch (a hint; re-resolved on-chain at execution).
  const ids = batch.map((e) => `${e.m.address}:${e.m.token_id}`).join(',')
  let sales: Record<string, SaleConfig | null> = {}
  try {
    const r = await fetch(`${baseUrl}/api/moments?ids=${encodeURIComponent(ids)}`, {
      signal: AbortSignal.timeout(8_000),
    })
    if (r.ok) sales = ((await r.json()) as { sales?: Record<string, SaleConfig | null> }).sales ?? {}
  } catch {
    return [] // no prices → no candidates this run (fail-closed)
  }

  // 3. Only items with a resolvable active sale become candidates. `creator` is
  //    the WATCHED artist (relabeled) so the engine's creator-allowlist accepts
  //    drops minted from the artist's other verified wallets.
  const candidates: Candidate[] = []
  for (const { m, watched } of batch) {
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
