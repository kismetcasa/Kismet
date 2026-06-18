import { inprocessUrl } from './inprocess'

// Reader for the public In•Process /transfers feed. We pull type=payment (paid
// sales; free airdrops are a separate type). Only the fields we consume are
// typed. Docs: https://docs.inprocess.world/api-reference/transfers
export interface TransferItem {
  value?: number | null // amount paid (human units); null for airdrops
  currency?: string | null // currency contract; null = native ETH
  quantity?: number
  moment?: {
    fee_recipients?: { artist_address?: string; percent_allocation?: number }[]
    // Creator: the schema returns collection.artist.{address}; the doc example
    // returns a bare collection.creator string. accumulate() handles both.
    collection?: { artist?: { address?: string }; creator?: string }
  }
}

interface TransfersPage {
  transfers: TransferItem[]
  pagination: { total_pages: number }
}

// One page (100) of paid transfers, or null on any failure — so the rebuild can
// abort instead of overwriting good totals with a partial scan.
export async function fetchTransfersPage(page: number): Promise<TransfersPage | null> {
  try {
    const res = await fetch(
      inprocessUrl('/transfers', { type: 'payment', chainId: 8453, page, limit: 100 }),
      { headers: { Accept: 'application/json' }, cache: 'no-store' },
    )
    if (!res.ok) return null
    const data = (await res.json()) as Partial<TransfersPage>
    return {
      transfers: Array.isArray(data.transfers) ? data.transfers : [],
      pagination: { total_pages: data.pagination?.total_pages ?? 0 },
    }
  } catch {
    return null
  }
}
