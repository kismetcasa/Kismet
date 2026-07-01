// Pure per-transfer accumulation logic for the artist stats rebuild: currency
// classification, dedup keying, per-moment attribution (with the KV creator
// override), and the smart-wallet→EOA remap fold. Extracted from lib/stats.ts
// so the attribution rules — the part of the pipeline artists' totals actually
// hinge on — can be unit-verified (scripts/verify-stats.ts) and reviewed
// without the Redis/RPC plumbing. IMPORT-FREE on purpose — it must load under
// `node --experimental-strip-types` in CI, so it pulls in no redis/viem deps
// (the USDC address is passed in rather than imported).
//
// THE BUGS THIS GUARDS (each has a verify case):
//   - mints keyed on the COLLECTION-level creator mis-credit delegated /
//     curated-collection mints to the collection owner; the KV creator
//     override (same one /api/timeline stitches) must win when present.
//   - an unknown ERC20 currency silently summed into the ETH bucket (and then
//     priced as ETH in USD) — unknown currencies must be SKIPPED, not defaulted.
//   - a transfer returned twice by the live offset-paged feed counted twice —
//     rows with a stable identifier must dedup.

export interface StatsFeeRecipient {
  artist_address?: string
  percent_allocation?: number
}

// Structural superset of the /transfers row. Only `value`/`currency`/
// `quantity`/`moment.collection` are known-present today; the identifier and
// per-moment fields are speculative reads — the upstream docs are thin, so we
// accept several plausible spellings and use whichever the feed actually
// sends. Absent fields degrade to the pre-existing behavior, and the rebuild
// counters make the coverage measurable (see RebuildResult in lib/stats.ts).
export interface StatsTransfer {
  value?: number | null // amount paid (human units); null for airdrops
  currency?: string | null // currency contract; null = native ETH
  quantity?: number
  // Best-effort unique identifiers for dedup, in preference order.
  id?: string | number | null
  transfer_id?: string | number | null
  transaction_hash?: string | null
  tx_hash?: string | null
  log_index?: number | null
  moment?: {
    id?: string | number | null
    token_id?: string | number | null
    address?: string | null
    contract_address?: string | null
    // Per-moment creator: schema-style object or bare string, when exposed.
    creator?: { address?: string } | string | null
    fee_recipients?: StatsFeeRecipient[]
    collection?: {
      address?: string | null
      artist?: { address?: string } | null
      creator?: string | null
    } | null
  } | null
}

export type StatsCurrency = 'eth' | 'usdc' | 'unknown'

/**
 * Bucket a transfer's payment currency. Unlike inferCollectCurrency (which
 * safe-defaults to ETH for UI display), the stats path must FAIL CLOSED: an
 * unrecognized ERC20 summed into the ETH bucket would later be multiplied by
 * the ETH/USD price, fabricating earnings. null/absent currency = native ETH.
 */
export function classifyTransferCurrency(
  currency: string | null | undefined,
  usdcAddress: string,
): StatsCurrency {
  if (currency == null || currency === '') return 'eth'
  return currency.toLowerCase() === usdcAddress.toLowerCase() ? 'usdc' : 'unknown'
}

/**
 * Stable dedup key for a transfer, or null when the feed exposes no reliable
 * identifier. Only REAL identifiers are used — synthesizing a key from
 * (token, buyer, value) would collapse two genuinely distinct identical sales.
 */
export function transferDedupKey(t: StatsTransfer): string | null {
  if (t.id != null && t.id !== '') return `id:${t.id}`
  if (t.transfer_id != null && t.transfer_id !== '') return `tid:${t.transfer_id}`
  const tx = t.transaction_hash ?? t.tx_hash
  // A tx hash alone is not unique (one tx can carry several transfers); it is
  // only usable when paired with a log index.
  if (tx && typeof t.log_index === 'number') return `tx:${tx.toLowerCase()}:${t.log_index}`
  return null
}

/**
 * The (collection, tokenId) the transfer paid into, when the feed exposes
 * both — the join key for the KV MomentMeta creator override. null otherwise.
 */
export function transferMomentRef(
  t: StatsTransfer,
): { collection: string; tokenId: string } | null {
  const collection =
    t.moment?.address ?? t.moment?.contract_address ?? t.moment?.collection?.address
  const tokenId = t.moment?.token_id
  if (!collection || tokenId == null || tokenId === '') return null
  return { collection: String(collection).toLowerCase(), tokenId: String(tokenId) }
}

export interface AccumulateCounters {
  /** Paid transfers folded into the maps. */
  counted: number
  /** Skipped: value missing/zero (free rows that leaked into type=payment). */
  skippedFree: number
  /** Skipped entirely: unrecognized ERC20 currency (would corrupt ETH bucket). */
  unknownCurrency: number
  /** Editions whose mint credit was dropped — no creator resolvable at all. */
  droppedMints: number
  /** Rows whose creator came from the KV MomentMeta override. */
  kvCreatorOverrides: number
  /** Rows whose creator was recovered from the dominant fee recipient. */
  recoveredCreators: number
}

export const newAccumulateCounters = (): AccumulateCounters => ({
  counted: 0,
  skippedFree: 0,
  unknownCurrency: 0,
  droppedMints: 0,
  kvCreatorOverrides: 0,
  recoveredCreators: 0,
})

const bump = (m: Map<string, number>, k: string, by: number) =>
  m.set(k, (m.get(k) ?? 0) + by)

/**
 * Fold one paid transfer into the aggregates.
 *
 * Mint-credit key precedence (most-specific attribution wins):
 *   1. kvCreator — the minter EOA mint-proxy persisted at mint time. The same
 *      override /api/timeline stitches; without it, delegated mints into a
 *      curated collection credit the collection OWNER, not the artist.
 *   2. moment.creator — per-moment feed field (object or bare-string shape).
 *   3. collection.artist.address ?? collection.creator — legacy collection-
 *      level fallback (correct only for single-artist collections).
 *   4. The highest-percent fee recipient — a paid sale always paid someone;
 *      for a solo artist that payee IS the artist. Heuristic, counted
 *      separately so its share of attribution stays observable.
 *
 * Earnings: split across fee_recipients by percent; else 100% to the resolved
 * creator. Same rules as before, minus the unknown-currency leak.
 */
export function accumulateTransfer(
  t: StatsTransfer,
  opts: { usdcAddress: string; kvCreator?: string | null },
  mints: Map<string, number>,
  eth: Map<string, number>,
  usdc: Map<string, number>,
  counters: AccumulateCounters,
): void {
  const value = typeof t.value === 'number' ? t.value : 0
  if (value <= 0) {
    counters.skippedFree++
    return
  }
  const currency = classifyTransferCurrency(t.currency, opts.usdcAddress)
  if (currency === 'unknown') {
    counters.unknownCurrency++
    return
  }
  const earned = currency === 'usdc' ? usdc : eth
  const qty = typeof t.quantity === 'number' && t.quantity > 0 ? Math.floor(t.quantity) : 1

  const feedCreatorRaw = t.moment?.creator
  const feedCreator =
    typeof feedCreatorRaw === 'string' ? feedCreatorRaw : feedCreatorRaw?.address
  const collectionCreator =
    t.moment?.collection?.artist?.address ?? t.moment?.collection?.creator ?? undefined

  const recipients = (t.moment?.fee_recipients ?? []).filter(
    (r): r is { artist_address: string; percent_allocation: number } =>
      typeof r.artist_address === 'string' &&
      r.artist_address.length > 0 &&
      typeof r.percent_allocation === 'number' &&
      r.percent_allocation > 0,
  )

  let creator = (opts.kvCreator ?? feedCreator ?? collectionCreator)?.toLowerCase()
  if (opts.kvCreator) counters.kvCreatorOverrides++
  if (!creator && recipients.length) {
    // Recover from the dominant payee rather than silently dropping the mint.
    creator = [...recipients]
      .sort((a, b) => b.percent_allocation - a.percent_allocation)[0]
      .artist_address.toLowerCase()
    counters.recoveredCreators++
  }

  if (creator) bump(mints, creator, qty)
  else counters.droppedMints += qty

  if (recipients.length) {
    for (const r of recipients) {
      bump(earned, r.artist_address.toLowerCase(), (value * r.percent_allocation) / 100)
    }
  } else if (creator) {
    bump(earned, creator, value)
  }
  counters.counted++
}

/**
 * Fold scores credited to mapped aliases (inprocess per-creator smart wallets)
 * into their owner's key. `remap` maps alias→owner, both lowercase. Entries
 * with no mapping pass through unchanged; an owner that also holds direct
 * credit has the alias's score merged in, not overwritten.
 */
export function remapEntries(
  m: Map<string, number>,
  remap: Map<string, string>,
): Map<string, number> {
  if (remap.size === 0) return m
  const out = new Map<string, number>()
  for (const [member, score] of m) {
    bump(out, remap.get(member) ?? member, score)
  }
  return out
}
