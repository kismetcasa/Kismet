import type { Moment } from './inprocess'
import { MAX_COLLECT_ALL_BATCH } from './zoraMint'
import { classifyOnchainSaleWindow, classifyTokenSupply } from './saleConfig'
import { rankSweepCandidates, type RankableSweepItem } from './sweepRank'

// Sweep index — the pure half (no Redis, no RPC). lib/sweepIndex.ts does the
// chain reads and persistence; this module owns the record shape, the
// per-token admission rule, the ranking adapter, the pool cut, the serve-time
// selection, and the Moment projection /api/sweep enriches — every rule
// scripts/verify-sweep.ts pins. Scope (SWEEP_IMPLEMENTATION.md §0): ETH-priced
// FixedPriceSaleStrategy sales on Base ONLY. ERC20Minter (USDC) rows are never
// read, so a USDC-priced artwork is invisible to the sweep by design.

/** Basket ceiling — the collect-all cap, for the same reason (wallet-preview
 *  readability; /api/collect's per-IP budget is sized for it). */
export const SWEEP_MAX_N = MAX_COLLECT_ALL_BATCH
export const SWEEP_DEFAULT_N = 10
/** Cheapest-N kept in the blob: 6 × the cap, so click-time verification can
 *  drop sold-out / owned rows and still fill a 20-basket from the reserve. */
export const SWEEP_POOL_SIZE = 120
/** /api/sweep returns max(3n, this) rows so the client has a reserve. */
export const SWEEP_SERVE_MIN = 30
/**
 * A pool older than this is not served (the button hides). Click-time
 * verification keeps a stale pool SAFE; this cutoff keeps it HONEST: a day of
 * missed hourly builds means the cron is broken, and "the cheapest ETH mints"
 * would then omit everything minted since. The ops threshold
 * (lib/statsHealth STATS_STALE_MS, 3 h) pages long before this trips; this one
 * only decides what the public sees.
 */
export const SWEEP_INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface SweepIndexItem {
  /** Collection, lowercased. */
  address: string
  /** Decimal, BigInt-canonical (no leading zeros) — the /api/collect member form. */
  tokenId: string
  /** FixedPriceSaleStrategy pricePerToken, wei. Always > 0 (free mints are never indexed). */
  priceWei: string
  /** The collection's mintFee(), wei — read at build time, within the sanity bound. */
  feeWei: string
  /** priceWei + feeWei — the sort key the pool was ranked on. */
  outlayWei: string
  /** Resolved creator (KV override over the feed), lowercased — the DISPLAY identity. */
  creator: string | null
  /** `creator` folded to the owning EOA — the DIVERSITY identity. */
  artist: string | null
  /** First-seen mint instant (KV pin over the feed's created_at), ISO-8601. */
  createdAt: string | null
  // Preview fields, carried so the sheet needs no per-row fetch. Identity
  // (the username) is stitched at serve time by
  // enrichMomentsWithKismetMeta, exactly as the feeds do it.
  name?: string
  image?: string
  thumbhash?: string
}

export interface SweepIndex {
  updatedAt: number
  /** Live, paid, ETH-priced, visible candidates found (before the pool cut). */
  eligible: number
  /** The cheapest SWEEP_POOL_SIZE, in rank order. */
  items: SweepIndexItem[]
}

/** One catalog row the builder considers (from lib/catalogCensus ResolvedCatalog). */
export interface SweepCandidate {
  address: string
  tokenId: string
  creator: string | null
  artist: string | null
  createdAt: string | null
  name?: string
  image?: string
  thumbhash?: string
}

/** FixedPriceSaleStrategy.sale() row (the fundsRecipient is irrelevant here). */
export interface SweepSaleRow {
  saleStart: bigint
  saleEnd: bigint
  maxTokensPerAddress: bigint
  pricePerToken: bigint
}

/** getTokenInfo() row (the uri is irrelevant here). */
export interface SweepSupplyRow {
  maxSupply: bigint
  totalMinted: bigint
}

export const sweepKey = (address: string, tokenId: string): string =>
  `${address.toLowerCase()}:${tokenId}`

/** Pass-1 admission: the row is INSIDE its window (the shared window rule) AND
 *  priced. Price 0 is a free mint — excluded by product decision, even though
 *  it still carries the protocol fee. */
export function isLivePaidSale(sale: SweepSaleRow | null | undefined, now: bigint): sale is SweepSaleRow {
  if (!sale) return false
  if (classifyOnchainSaleWindow(sale, now) !== 'live') return false
  return sale.pricePerToken > 0n
}

/**
 * Assemble one index item, or null when the token must not be swept: not a
 * live paid sale, sold out (shared supply rule), or the collection's mint fee
 * is unknown / out of bounds (`fee` undefined — fail closed per collection,
 * see readMintFeesWithBound). An unreadable supply row (`supply` null) is
 * treated as open, as every other mintability read does.
 */
export function buildSweepItem(
  c: SweepCandidate,
  sale: SweepSaleRow | null | undefined,
  supply: SweepSupplyRow | null | undefined,
  fee: bigint | undefined,
  now: bigint,
): SweepIndexItem | null {
  if (!isLivePaidSale(sale, now)) return null
  if (fee === undefined) return null
  if (classifyTokenSupply(supply).soldOut) return null
  return {
    address: c.address.toLowerCase(),
    tokenId: c.tokenId,
    priceWei: sale.pricePerToken.toString(),
    feeWei: fee.toString(),
    outlayWei: (sale.pricePerToken + fee).toString(),
    creator: c.creator,
    artist: c.artist,
    createdAt: c.createdAt,
    ...(c.name ? { name: c.name } : {}),
    ...(c.image ? { image: c.image } : {}),
    ...(c.thumbhash ? { thumbhash: c.thumbhash } : {}),
  }
}

function toRankable(it: SweepIndexItem): RankableSweepItem & { item: SweepIndexItem } {
  const t = it.createdAt ? Date.parse(it.createdAt) : Number.NaN
  return {
    address: it.address,
    tokenId: it.tokenId,
    outlayWei: BigInt(it.outlayWei),
    artist: it.artist,
    createdAtMs: Number.isFinite(t) ? t : null,
    item: it,
  }
}

/** Rank persisted items (string wei → bigint adapter over lib/sweepRank). */
function rankIndexItems(items: readonly SweepIndexItem[]): SweepIndexItem[] {
  return rankSweepCandidates(items.map(toRankable)).map((r) => r.item)
}

/** Rank + pool cut. `eligible` counts everything that ranked (before the cut). */
export function finalizeSweepIndex(items: readonly SweepIndexItem[], updatedAt: number): SweepIndex {
  const ranked = rankIndexItems(items)
  return { updatedAt, eligible: ranked.length, items: ranked.slice(0, SWEEP_POOL_SIZE) }
}

/** True when the pool is too old to serve (see SWEEP_INDEX_MAX_AGE_MS). A
 *  non-numeric or non-finite `updatedAt` is stale; a timestamp slightly in the
 *  future (clock skew between builder and server) is fresh. */
export function isSweepIndexStale(index: Pick<SweepIndex, 'updatedAt'>, now: number = Date.now()): boolean {
  if (typeof index.updatedAt !== 'number' || !Number.isFinite(index.updatedAt)) return true
  return now - index.updatedAt > SWEEP_INDEX_MAX_AGE_MS
}

/** Parse `?n=` — default SWEEP_DEFAULT_N, clamped to [1, SWEEP_MAX_N]. */
export function clampSweepN(raw: string | null | undefined): number {
  if (raw == null || raw === '') return SWEEP_DEFAULT_N
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n)) return SWEEP_DEFAULT_N
  return Math.min(SWEEP_MAX_N, Math.max(1, n))
}

/** Rows to serve for a basket of `n`: 3n, floored at SWEEP_SERVE_MIN. */
export function serveCount(n: number): number {
  return Math.max(3 * n, SWEEP_SERVE_MIN)
}

/**
 * Serve-time selection: the pool is re-filtered against the LIVE hide sets
 * (memoized 15 min) so a piece hidden after the hourly build disappears in
 * minutes, not an hour. Both creator identities are checked against the
 * admin-hidden users — the display creator (what the census's hidden verdict
 * uses) and the folded artist. Order is preserved; the prefix is bounded by
 * serveCount(n).
 */
export function selectSweepItems(
  index: SweepIndex,
  opts: {
    n: number
    hiddenMoments: Set<string>
    hiddenCollections: Set<string>
    hiddenUsers: Set<string>
  },
): SweepIndexItem[] {
  const limit = serveCount(opts.n)
  const out: SweepIndexItem[] = []
  for (const it of index.items) {
    if (out.length >= limit) break
    const addr = it.address.toLowerCase()
    if (opts.hiddenMoments.has(sweepKey(addr, it.tokenId))) continue
    if (opts.hiddenCollections.has(addr)) continue
    if (it.creator && opts.hiddenUsers.has(it.creator.toLowerCase())) continue
    if (it.artist && opts.hiddenUsers.has(it.artist.toLowerCase())) continue
    out.push(it)
  }
  return out
}

/**
 * Project an item onto the Moment shape so /api/sweep can run the feeds' own
 * identity enrichment (enrichMomentsWithKismetMeta) unchanged — creator
 * the username and the hidden-identity scrub
 * all come from that one choke point. `uri`/`admins` are required by the type
 * and unused by enrichment.
 */
export function sweepItemToMoment(it: SweepIndexItem): Moment {
  return {
    address: it.address,
    token_id: it.tokenId,
    uri: '',
    creator: { address: it.creator ?? '', hidden: false },
    admins: [],
    created_at: it.createdAt ?? '',
    metadata: {
      ...(it.name ? { name: it.name } : {}),
      ...(it.image ? { image: it.image } : {}),
      ...(it.thumbhash ? { kismet_thumbhash: it.thumbhash } : {}),
    },
  }
}

/**
 * One row as /api/sweep returns it: the index item plus the feeds' identity
 * overlay (enrichMomentsWithKismetMeta), so the sheet needs no per-row fetch.
 */
export interface SweepResponseItem extends SweepIndexItem {
  creatorProfile: { username: string | null }
}

/**
 * The /api/sweep envelope. `enabled: false` is the whole answer while the
 * flag is off (or unreadable); the client renders nothing on it.
 */
export type SweepApiResponse =
  | { enabled: false }
  | {
      enabled: true
      updatedAt: number | null
      eligible: number
      maxN: number
      n: number
      items: SweepResponseItem[]
    }
