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
//     priced as ETH in USD) — unknown currencies must skip the VALUE. The
//     MINT count is currency-independent and must still be credited (dropping
//     it erased whole artists on the next absolute overwrite).
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

// Common on-chain sentinel for "native currency" — some feeds report native
// sales with the zero address instead of a null currency field.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Bucket a transfer's payment currency. Unlike inferCollectCurrency (which
 * safe-defaults to ETH for UI display), the stats path must FAIL CLOSED: an
 * unrecognized ERC20 summed into the ETH bucket would later be multiplied by
 * the ETH/USD price, fabricating earnings. null/absent/zero-address currency
 * = native ETH.
 */
export function classifyTransferCurrency(
  currency: string | null | undefined,
  usdcAddress: string,
): StatsCurrency {
  if (currency == null || currency === '') return 'eth'
  const lower = currency.toLowerCase()
  if (lower === ZERO_ADDRESS) return 'eth'
  return lower === usdcAddress.toLowerCase() ? 'usdc' : 'unknown'
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
  /** Paid transfers folded into the maps (mints and/or earnings). */
  counted: number
  /** Skipped: value missing/zero (free rows that leaked into type=payment). */
  skippedFree: number
  /** Rows whose VALUE was skipped: unrecognized ERC20 currency (would corrupt
   *  the ETH bucket). Their mint count is still credited — it is
   *  currency-independent. */
  unknownCurrency: number
  /** Editions whose mint credit was dropped — no creator resolvable at all. */
  droppedMints: number
  /** Rows where the KV MomentMeta creator CHANGED the attribution (a KV
   *  value agreeing with the feed reports source 'feed' and is not counted —
   *  see resolveMomentCreator). */
  kvCreatorOverrides: number
  /** Rows attributed at the COLLECTION tier (no KV meta, no per-moment feed
   *  creator) — the residual delegated-mint misattribution risk: correct for
   *  single-artist collections, wrong for curated ones. Counted so the
   *  rebuild log directly exposes how much attribution still rides the
   *  least-specific tier. */
  collectionFallbacks: number
  /** Rows whose creator was recovered from the dominant fee recipient. */
  recoveredCreators: number
}

export const newAccumulateCounters = (): AccumulateCounters => ({
  counted: 0,
  skippedFree: 0,
  unknownCurrency: 0,
  droppedMints: 0,
  kvCreatorOverrides: 0,
  collectionFallbacks: 0,
  recoveredCreators: 0,
})

const bump = (m: Map<string, number>, k: string, by: number) =>
  m.set(k, (m.get(k) ?? 0) + by)

export type MomentCreatorSource = 'kv' | 'feed' | 'collection' | 'recipient'

/**
 * THE creator-resolution precedence, shared by every surface that attributes
 * a moment to its maker — the stats rebuild (accumulateTransfer below), the
 * /api/timeline stitch, and MomentDetailView's display chain — so "what you
 * see" and "what you're paid" can never disagree on who made a moment:
 *
 *   1. kv         — the minter EOA mint-proxy persisted at mint time.
 *                   Authoritative for Kismet-minted moments; inprocess often
 *                   reports the platform smart wallet / collection
 *                   defaultAdmin / factory instead. Wins only when it CHANGES
 *                   the answer (differs case-insensitively from the feed
 *                   value) — callers that rewrite on 'kv' (the timeline
 *                   clobbers username to null) must not churn equal values.
 *   2. feed       — the per-moment creator the upstream feed reports.
 *   3. collection — the collection-level artist/creator (correct only for
 *                   single-artist collections; last-resort feed data).
 *   4. recipient  — the dominant fee recipient: a paid sale always paid
 *                   someone, and for a solo artist that payee IS the artist.
 *
 * Returns the chosen input VERBATIM (no lowercasing — display callers keep
 * their casing; the stats path lowercases the result itself) plus which tier
 * won, so callers can act on overrides ('kv') or count heuristics
 * ('recipient') without re-deriving the order.
 */
export function resolveMomentCreator(inputs: {
  kvCreator?: string | null
  feedCreator?: string | null
  collectionCreator?: string | null
  dominantFeeRecipient?: string | null
}): { address: string | null; source: MomentCreatorSource | null } {
  const { kvCreator, feedCreator, collectionCreator, dominantFeeRecipient } = inputs
  if (kvCreator) {
    if (!feedCreator || feedCreator.toLowerCase() !== kvCreator.toLowerCase()) {
      return { address: kvCreator, source: 'kv' }
    }
    // KV agrees with the feed — report 'feed' so rewrite-on-override callers
    // treat it as a no-op.
    return { address: feedCreator, source: 'feed' }
  }
  if (feedCreator) return { address: feedCreator, source: 'feed' }
  if (collectionCreator) return { address: collectionCreator, source: 'collection' }
  if (dominantFeeRecipient) return { address: dominantFeeRecipient, source: 'recipient' }
  return { address: null, source: null }
}

/**
 * Fold one paid transfer into the aggregates.
 *
 * The mint-credit key comes from resolveMomentCreator above — ONE precedence
 * order shared with the timeline stitch and the detail view, so the profile's
 * earnings figure and its feed can't attribute the same moment to different
 * people. The 'kv' and 'recipient' tiers are counted so their share of
 * attribution stays observable in the rebuild log.
 *
 * Earnings: split across fee_recipients by percent; else 100% to the resolved
 * creator. An unknown ERC20 currency skips ONLY the value — pricing a foreign
 * token as ETH would fabricate earnings — while the mint count (currency-
 * independent) is still credited, as the pre-statsMath code always did.
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
  const qty = typeof t.quantity === 'number' && t.quantity > 0 ? Math.floor(t.quantity) : 1

  const feedCreatorRaw = t.moment?.creator
  const feedCreator =
    typeof feedCreatorRaw === 'string' ? feedCreatorRaw : feedCreatorRaw?.address

  const recipients = (t.moment?.fee_recipients ?? []).filter(
    (r): r is { artist_address: string; percent_allocation: number } =>
      typeof r.artist_address === 'string' &&
      r.artist_address.length > 0 &&
      typeof r.percent_allocation === 'number' &&
      r.percent_allocation > 0,
  )

  const resolved = resolveMomentCreator({
    kvCreator: opts.kvCreator,
    feedCreator,
    collectionCreator:
      t.moment?.collection?.artist?.address ?? t.moment?.collection?.creator,
    dominantFeeRecipient: recipients.length
      ? [...recipients].sort((a, b) => b.percent_allocation - a.percent_allocation)[0]
          .artist_address
      : null,
  })
  const creator = resolved.address?.toLowerCase()
  if (resolved.source === 'kv') counters.kvCreatorOverrides++
  if (resolved.source === 'collection') counters.collectionFallbacks++
  if (resolved.source === 'recipient') counters.recoveredCreators++

  if (creator) bump(mints, creator, qty)
  else counters.droppedMints += qty

  const currency = classifyTransferCurrency(t.currency, opts.usdcAddress)
  if (currency === 'unknown') {
    counters.unknownCurrency++
    counters.counted++
    return
  }
  const earned = currency === 'usdc' ? usdc : eth
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
