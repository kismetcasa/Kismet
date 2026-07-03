import { inprocessUrl } from './inprocess'
import type { StatsTransfer } from './statsMath'

// Reader for the public In•Process /transfers feed. We pull type=payment (paid
// sales; free airdrops are a separate type). The row shape (including the
// speculative identifier / per-moment fields) is typed in lib/statsMath.ts so
// the pure accumulation logic and this reader share one definition.
// Docs: https://docs.inprocess.world/api-reference/transfers
export type TransferItem = StatsTransfer

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
      {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      },
    )
    if (!res.ok) return null
    const data = (await res.json()) as Partial<TransfersPage>
    // STRICT shape check: a 200 whose body lacks the expected fields (a JSON
    // error envelope served as 200, an empty {}, schema drift) is a FAILURE,
    // not an empty end-of-feed. Coercing it to { transfers: [], total_pages: 0 }
    // — as this reader once did — made the rebuild loop exit cleanly mid-scan
    // and absolutely overwrite every artist's totals with the truncated
    // partial. Returning null instead routes it through the rebuild's existing
    // abort-and-retry-next-cron path, preserving the last good totals.
    if (!Array.isArray(data.transfers) || typeof data.pagination?.total_pages !== 'number') {
      return null
    }
    return {
      transfers: data.transfers,
      pagination: { total_pages: data.pagination.total_pages },
    }
  } catch {
    return null
  }
}
