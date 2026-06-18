import { inprocessUrl } from './inprocess'

// Typed client for the In•Process /transfers feed — the canonical, complete,
// historical record of moment transfers. Public (no API key).
// Docs: https://docs.inprocess.world/api-reference/transfers
//
// We read `type=payment` (paid sales; free airdrops are a separate type and are
// excluded upstream). Each row carries everything the stats system needs:
// `value` + `currency` (earnings), `quantity` (mints), the moment creator
// (`moment.collection.artist`), and `fee_recipients` (the artist split).

export interface TransferFeeRecipient {
  artist_address?: string
  /** Defensive alias — some payloads key the recipient as `address`. */
  address?: string
  /** Percentage (0–100) of `value` allocated to this artist. */
  percent_allocation?: number
}

export interface TransferItem {
  id?: string
  transferred_at?: string
  quantity?: number
  /** Amount paid (human-denominated, e.g. 0.1 / 5). null for airdrops. */
  value?: number | null
  /** Currency contract address. null = native ETH; USDC address = USDC. */
  currency?: string | null
  transaction_hash?: string
  collector?: { address?: string; username?: string | null }
  moment?: {
    token_id?: number
    /** Artists sharing the payment. Present only for paid transfers. */
    fee_recipients?: TransferFeeRecipient[]
    collection?: {
      address?: string
      chain_id?: number
      protocol?: string
      /** Creator of the collection. The schema returns an object; some
       *  responses (and the doc's own example) instead return the address as a
       *  string under `creator`. Both are handled in accumulateTransfer. */
      artist?: { address?: string; username?: string | null }
      creator?: string
    }
  }
}

export interface TransfersPage {
  transfers: TransferItem[]
  pagination: { total_count: number; page: number; limit: number; total_pages: number }
}

export interface FetchTransfersParams {
  type?: 'payment' | 'airdrop'
  chainId?: number
  page?: number
  limit?: number
}

const EMPTY: TransfersPage = {
  transfers: [],
  pagination: { total_count: 0, page: 1, limit: 0, total_pages: 0 },
}

/**
 * Fetch one page of transfers. Returns an empty page on any failure (non-2xx,
 * network, malformed JSON) so the rebuild loop degrades gracefully — a single
 * bad page ends the scan rather than throwing.
 */
export async function fetchTransfersPage(params: FetchTransfersParams): Promise<TransfersPage> {
  const url = inprocessUrl('/transfers', {
    type: params.type,
    chainId: params.chainId ?? 8453,
    page: params.page ?? 1,
    limit: params.limit ?? 100,
  })
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
    if (!res.ok) return EMPTY
    const data = (await res.json()) as Partial<TransfersPage>
    return {
      transfers: Array.isArray(data.transfers) ? data.transfers : [],
      pagination: {
        total_count: data.pagination?.total_count ?? 0,
        page: data.pagination?.page ?? params.page ?? 1,
        limit: data.pagination?.limit ?? params.limit ?? 100,
        total_pages: data.pagination?.total_pages ?? 0,
      },
    }
  } catch {
    return EMPTY
  }
}
