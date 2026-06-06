'use client'

/**
 * Scout candidate discovery (Mode A, client-side) — "watch artists".
 *
 * We pull the watched artists' recent moments in ONE request via the timeline's
 * plural roster filter (`/api/timeline?creators=a,b,c`) — a single server-side
 * fan-out filtered to the set, instead of N per-artist calls — then resolve
 * authoritative price + currency in one batch via `/api/moments` (the canonical
 * sale-config path). The result is the ordered Candidate[] the pure engine plans
 * against. Prices are re-resolved on-chain again at execution time by
 * prepare-collect-batch, so any staleness here is bounded by the Spend
 * Permission cap, not trusted.
 */

import type { Candidate, Currency } from './engine'

const FEED_LIMIT = 50

interface TimelineMoment {
  address?: string
  token_id?: string
  creator?: { address?: string }
}

interface SaleConfig {
  type?: 'fixedPrice' | 'erc20Mint'
  pricePerToken?: string
  currency?: string
}

export async function discoverCandidates(creators: readonly string[]): Promise<Candidate[]> {
  if (creators.length === 0) return []

  // 1. All watched artists' recent moments in a single timeline fan-out,
  //    filtered to the roster (newest-first; the engine's greedy plan respects
  //    that order).
  let moments: TimelineMoment[] = []
  try {
    const roster = creators.map((c) => c.toLowerCase()).join(',')
    const r = await fetch(`/api/timeline?creators=${roster}&limit=${FEED_LIMIT}`)
    if (r.ok) {
      const d = (await r.json()) as { moments?: TimelineMoment[] }
      moments = Array.isArray(d.moments) ? d.moments : []
    }
  } catch {
    return []
  }

  // Dedupe (a collab can surface twice), preserving first-seen feed order.
  const order: TimelineMoment[] = []
  const seen = new Set<string>()
  for (const m of moments) {
    if (!m?.address || !m?.token_id) continue
    const k = `${m.address.toLowerCase()}:${m.token_id}`
    if (seen.has(k)) continue
    seen.add(k)
    order.push(m)
  }
  if (order.length === 0) return []

  // 2. Resolve price + currency in one batch.
  const ids = order.map((m) => `${m.address}:${m.token_id}`).join(',')
  let sales: Record<string, SaleConfig | null> = {}
  try {
    const r = await fetch(`/api/moments?ids=${encodeURIComponent(ids)}`)
    if (r.ok) sales = ((await r.json()) as { sales?: Record<string, SaleConfig | null> }).sales ?? {}
  } catch {
    // No prices → no candidates this run (fail-closed; never plan blind spends).
    return []
  }

  // 3. Only items with a resolvable active sale become candidates.
  const candidates: Candidate[] = []
  for (const m of order) {
    const sale = sales[`${m.address!.toLowerCase()}:${m.token_id}`]
    if (!sale?.pricePerToken) continue
    const currency: Currency = sale.type === 'erc20Mint' ? 'usdc' : 'eth'
    candidates.push({
      collection: m.address!,
      tokenId: m.token_id!,
      creator: m.creator?.address,
      currency,
      pricePerToken: sale.pricePerToken,
    })
  }
  return candidates
}
