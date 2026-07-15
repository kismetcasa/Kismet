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
// `quantity`/`moment.collection` are known-present today; the identifier,
// buyer, and per-moment fields are speculative reads — the upstream docs are
// thin, so we accept several plausible spellings and use whichever the feed
// actually sends. Absent fields degrade to the pre-existing behavior, and the
// rebuild counters make the coverage measurable (see RebuildResult in
// lib/stats.ts).
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
  // Best-effort buyer (paying collector) fields, in preference order — the
  // inprocess /payments feed exposes `buyer: { address }`, so its transfer
  // sibling plausibly carries one of these. `from` is deliberately NOT read:
  // on a primary mint the ERC-1155 `from` is the zero address (or a relayer),
  // so treating it as the buyer would fabricate collectors.
  buyer?: { address?: string } | string | null
  buyer_address?: string | null
  collector?: { address?: string } | string | null
  recipient?: { address?: string } | string | null
  recipient_address?: string | null
  to_address?: string | null
  to?: string | null
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

// Corruption backstops, NOT business rules — generous enough that no real
// Kismet sale approaches them, tight enough that a garbage feed row (NaN,
// Infinity, 1e30, a billion editions) can't poison an artist's total until
// the next scan. A single paid transfer above these is definitionally corrupt.
const MAX_SANE_VALUE = 1e9 // human units; real ETH/USDC sales are << this
const MAX_SANE_QTY = 1_000_000 // editions in ONE transfer
// A fee-recipient percentage. Real values are ≤ 100 (the divisor scales a
// legitimate >100 SUM down); this ceiling exists only to reject non-finite /
// astronomically-overflowing garbage (Infinity, NaN, 1e308) that would make
// the divisor Infinity → NaN credit, poisoning — and, at write time, DELETING
// — an artist's real total. Same fail-closed stance as MAX_SANE_VALUE/QTY.
const MAX_SANE_PCT = 1_000_000

// Shared empty exclude set for the pass-artist credit path when a caller
// doesn't pass platformAddresses — allocated once, never mutated.
const EMPTY_ADDRESS_SET: ReadonlySet<string> = new Set()

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

// Lowercased 40-hex address, or null. Strict shape check so a feed that puts
// a username / ENS / empty string in a buyer field can't pollute the
// collector set with non-wallet garbage.
const asWalletAddress = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const lower = v.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(lower)) return null
  if (lower === ZERO_ADDRESS) return null
  return lower
}

/**
 * The wallet that PAID for this transfer, when the feed exposes one — the
 * platform "unique collectors" key. Accepts the plausible spellings on
 * StatsTransfer in preference order (most explicit first) and returns a
 * validated lowercase wallet address, or null when no field yields one (the
 * row is then counted in PlatformTotals.buyerMissing so coverage stays
 * measurable, mirroring how droppedMints exposes attribution gaps).
 */
export function transferBuyer(t: StatsTransfer): string | null {
  const candidates: unknown[] = [
    typeof t.buyer === 'string' ? t.buyer : t.buyer?.address,
    t.buyer_address,
    typeof t.collector === 'string' ? t.collector : t.collector?.address,
    typeof t.recipient === 'string' ? t.recipient : t.recipient?.address,
    t.recipient_address,
    t.to_address,
    t.to,
  ]
  for (const c of candidates) {
    const addr = asWalletAddress(c)
    if (addr) return addr
  }
  return null
}

/**
 * Which universe a transfer belongs to for the PLATFORM roll-up. The
 * In•Process /transfers feed is network-wide (every client app's sales on the
 * chain), while "the platform's" totals must mean KISMET's tracked
 * collections — without this gate the roll-up reported the whole network's
 * volume as Kismet's (~6× the real editions figure when first measured).
 *   'in'      — the moment's collection is in Kismet's tracked registry: fold
 *               into BOTH the platform art roll-up and the per-artist maps.
 *   'pass'    — the Patron/Mint-Pass collection: NOT counted in the platform
 *               ART figures (editions/collectors/artistsWithSales) — it folds
 *               into the separate `passes` sub-totals — but IS credited to the
 *               real artists' per-artist cards (see accumulateTransfer), since
 *               a pass sale is a sale of that artist's artwork.
 *   'out'     — resolvable collection, not tracked: exclude, count outOfScope.
 *   'unknown' — no collection ref resolvable on the row: exclude, count
 *               scopeUnknown. FAIL-CLOSED — a money figure must never include
 *               a row we can't place, and the counter keeps the gap visible.
 * The PER-ARTIST maps are credited for 'in' AND 'pass' (see accumulateTransfer's
 * creditArtist): a platform decision (2026-07-14) — every displayed number on
 * kismet.art means KISMET activity, no surface shows network-wide In•Process
 * figures, and a Patron artist sees their split earnings on their own card
 * (attributed to the real artist in the split, never the platform treasury).
 * A pass artist's card can therefore exceed the platform ART totals; the
 * `passes` block accounts for the difference.
 */
export type PlatformScope = 'in' | 'pass' | 'out' | 'unknown'

/**
 * Platform-wide roll-up accumulated alongside the per-artist maps — one pass
 * over the same gated rows, so the platform totals and every artist's card
 * are computed from the identical row set and can never disagree about what
 * counts as a sale.
 *
 * `eth`/`usdc` are GROSS sale value (what buyers paid), not the Σ of artist
 * credits: a sub-100 fee_recipients split credits artists less than the sale
 * value (the unlisted platform cut), and the platform figure must not shrink
 * with it. `editions` includes rows whose creator is unresolvable — the sale
 * still happened platform-wide even when no artist can be credited.
 *
 * Invariant: transactions + passes.transactions + outOfScope + scopeUnknown
 * === counters.counted.
 */
export interface PlatformTotals {
  /** Paid IN-SCOPE transfers folded. */
  transactions: number
  /** Editions sold across those transfers (Σ quantity, unknown → 1). */
  editions: number
  /** Gross ETH paid across eth-currency rows. */
  eth: number
  /** Gross USDC paid across usdc-currency rows. */
  usdc: number
  /** Unique buyer wallets (pre smart-wallet→EOA fold — lib/stats.ts remaps). */
  buyers: Set<string>
  /** Counted in-scope rows exposing no recognizable buyer field. */
  buyerMissing: number
  /** Unique credited creators on in-scope rows (pre smart-wallet fold). */
  artists: Set<string>
  /** In-scope editions whose creator was unresolvable (still in `editions`). */
  droppedMints: number
  /** In-scope rows whose value was skipped (unrecognized ERC20). */
  unknownCurrency: number
  /** Counted rows excluded: collection resolvable but not Kismet-tracked. */
  outOfScope: number
  /** Counted rows excluded: no collection ref resolvable on the row. */
  scopeUnknown: number
  /** Paid Patron/Mint-Pass sales — Kismet revenue, kept out of the art
   *  figures. Same gates and currency rules as the art buckets. */
  passes: { transactions: number; editions: number; eth: number; usdc: number }
}

export const newPlatformTotals = (): PlatformTotals => ({
  transactions: 0,
  editions: 0,
  eth: 0,
  usdc: 0,
  buyers: new Set<string>(),
  buyerMissing: 0,
  artists: new Set<string>(),
  droppedMints: 0,
  unknownCurrency: 0,
  outOfScope: 0,
  scopeUnknown: 0,
  passes: { transactions: 0, editions: 0, eth: 0, usdc: 0 },
})

export interface AccumulateCounters {
  /** Paid transfers folded into the maps (mints and/or earnings). */
  counted: number
  /** Skipped: value missing/zero (free rows that leaked into type=payment). */
  skippedFree: number
  /** Skipped: corrupt value (NaN/Infinity or beyond the sanity ceiling) — a
   *  garbage feed row that would otherwise poison a total. */
  skippedInvalid: number
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
  skippedInvalid: 0,
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
 * The highest-allocation recipient NOT in `exclude` (lowercased), or null when
 * every recipient is excluded. Credits a PASS sale's COUNT to the primary real
 * artist named in the split: the Patron moment's `creator` resolves to a
 * platform payout wallet, so `exclude` drops the known platform addresses (the
 * same set the Patron page's deriveArtistsFromRecipients uses) and the artist —
 * holding the dominant share of an artwork they made — wins even if a minor
 * platform payee isn't in `exclude`. Ties break first-seen (strict >).
 */
export function dominantRecipientExcluding(
  recipients: { artist_address: string; percent_allocation: number }[],
  exclude: ReadonlySet<string>,
): string | null {
  let best: string | null = null
  let bestPct = -1
  for (const r of recipients) {
    const addr = r.artist_address.toLowerCase()
    if (exclude.has(addr)) continue
    if (r.percent_allocation > bestPct) {
      bestPct = r.percent_allocation
      best = addr
    }
  }
  return best
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
 *
 * `platform` (optional) receives the platform-wide roll-up for the SAME row,
 * behind the same free/invalid gates: transactions, editions, and the buyer
 * fold are currency-independent (an unknown-ERC20 sale still happened); the
 * gross value lands in the eth/usdc buckets only when the currency is
 * recognized — the identical fail-closed rule the artist buckets follow.
 * `platformScope` gates WHICH rows fold (see PlatformScope): 'in' credits the
 * per-artist maps AND the platform art roll-up; 'pass' credits the passes
 * sub-totals AND the real split artists' per-artist maps (never the platform
 * art roll-up); 'out'/'unknown' credit NOTHING and only bump their exclusion
 * counter (after the free/invalid gates, so a free or corrupt row is never
 * double-classified). counters.counted stays network-wide across all scopes —
 * the shrink-guard's feed-completeness signal.
 */
export function accumulateTransfer(
  t: StatsTransfer,
  opts: {
    usdcAddress: string
    kvCreator?: string | null
    /** Platform payout wallets excluded when attributing a PASS sale to its
     *  real artist(s) — treasury / referral / residencies / operator, the same
     *  known-platform set the Patron page excludes. Only consulted for 'pass'
     *  rows; absent = no exclusion (the dominant-share pick still favours the
     *  artist). */
    platformAddresses?: ReadonlySet<string>
  },
  mints: Map<string, number>,
  eth: Map<string, number>,
  usdc: Map<string, number>,
  counters: AccumulateCounters,
  platform?: PlatformTotals,
  platformScope: PlatformScope = 'in',
): void {
  const value = typeof t.value === 'number' ? t.value : 0
  // Corrupt value (NaN/Infinity — both pass `typeof === 'number'` — or an
  // absurd magnitude) is dropped and counted separately from a legitimate
  // free/zero row, so one bad feed row can't inject garbage into a total.
  if (!Number.isFinite(value) || value > MAX_SANE_VALUE) {
    counters.skippedInvalid++
    return
  }
  if (value <= 0) {
    counters.skippedFree++
    return
  }
  // An absent, non-finite, or absurd quantity falls back to 1 (the same
  // "unknown quantity → assume one edition" default), so it can't inflate the
  // mint count while still crediting the sale.
  const qty =
    typeof t.quantity === 'number' &&
    Number.isFinite(t.quantity) &&
    t.quantity > 0 &&
    t.quantity <= MAX_SANE_QTY
      ? Math.floor(t.quantity)
      : 1

  const feedCreatorRaw = t.moment?.creator
  const feedCreator =
    typeof feedCreatorRaw === 'string' ? feedCreatorRaw : feedCreatorRaw?.address

  const recipients = (t.moment?.fee_recipients ?? []).filter(
    (r): r is { artist_address: string; percent_allocation: number } =>
      typeof r.artist_address === 'string' &&
      r.artist_address.length > 0 &&
      typeof r.percent_allocation === 'number' &&
      // Finite + bounded, mirroring the value/quantity guards: an Infinity/NaN
      // (or 1e308-overflowing) percentage would drive divisor→Infinity and
      // credit→NaN, which the write-time `v > 0` filter then reads as false and
      // DELETES the artist's real score. Reject it here instead.
      Number.isFinite(r.percent_allocation) &&
      r.percent_allocation > 0 &&
      r.percent_allocation <= MAX_SANE_PCT,
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

  // Per-artist attribution — the maps behind every earnings card. Credits 'in'
  // (Kismet art) AND 'pass' (Patron/Mint-Pass) rows; 'out'/'unknown' fold
  // nothing (no surface shows network-wide In•Process figures).
  //   'in'   — SALE COUNT to the resolved moment creator; EARNINGS split across
  //            fee_recipients (or whole value to the creator when unsplit).
  //   'pass' — the moment creator resolves to a PLATFORM payout wallet, so the
  //            SALE COUNT goes to the primary REAL artist in the split
  //            (dominantRecipientExcluding over opts.platformAddresses) and
  //            EARNINGS go to the non-platform recipients by their real share —
  //            crediting the artist who made the pass artwork, never the
  //            treasury. Pass rows ALSO feed the platform passes block above;
  //            the per-artist credit is a separate VIEW, not a double-count.
  // NOTE: counters.counted (below) stays network-wide — the shrink-guard signal.
  const creditArtist = platformScope === 'in' || platformScope === 'pass'
  const isPass = platformScope === 'pass'
  const passExclude = opts.platformAddresses ?? EMPTY_ADDRESS_SET
  if (creditArtist) {
    if (isPass) {
      const primary = dominantRecipientExcluding(recipients, passExclude)
      if (primary) bump(mints, primary, qty)
      else counters.droppedMints += qty
    } else {
      if (resolved.source === 'kv') counters.kvCreatorOverrides++
      if (resolved.source === 'collection') counters.collectionFallbacks++
      if (resolved.source === 'recipient') counters.recoveredCreators++
      if (creator) bump(mints, creator, qty)
      else counters.droppedMints += qty
    }
  }

  // Platform roll-up for every counted IN-SCOPE row — including creator-
  // unresolvable and unknown-currency rows, whose SALE is real even when the
  // artist credit or the value bucket must be skipped. Rows outside Kismet's
  // scope bump only their exclusion counter (post-gates, so free/corrupt rows
  // stay classified by the gate that dropped them, never as scope exclusions).
  // Pass-collection rows fold into the passes sub-totals instead of the art
  // figures — same gates, same fail-closed currency rule.
  const p = platform && platformScope === 'in' ? platform : undefined
  if (platform && !p) {
    if (platformScope === 'pass') {
      platform.passes.transactions++
      platform.passes.editions += qty
      const currency = classifyTransferCurrency(t.currency, opts.usdcAddress)
      if (currency === 'usdc') platform.passes.usdc += value
      else if (currency === 'eth') platform.passes.eth += value
    } else if (platformScope === 'out') platform.outOfScope++
    else platform.scopeUnknown++
  }
  if (p) {
    p.transactions++
    p.editions += qty
    const buyer = transferBuyer(t)
    if (buyer) p.buyers.add(buyer)
    else p.buyerMissing++
    if (creator) p.artists.add(creator)
    else p.droppedMints += qty
  }

  const currency = classifyTransferCurrency(t.currency, opts.usdcAddress)
  if (currency === 'unknown') {
    counters.unknownCurrency++
    if (p) p.unknownCurrency++
    counters.counted++
    return
  }
  if (p) {
    if (currency === 'usdc') p.usdc += value
    else p.eth += value
  }
  // Per-artist earnings credit — scoped to Kismet activity like the mint
  // credit above (creditArtist). counters.counted still increments for every
  // in-feed row regardless of scope (the shrink-guard signal).
  if (creditArtist) {
    const earned = currency === 'usdc' ? usdc : eth
    if (recipients.length) {
      // Divide by max(100, Σpct) so the credited shares can never sum to MORE
      // than the sale value: a corrupt feed row whose percentages exceed 100
      // is scaled down instead of over-reporting earnings, while a legitimate
      // sub-100 split (e.g. an unlisted platform cut) still credits exactly the
      // listed percentages (divisor stays 100). Over-crediting a money figure
      // is the worst failure class, so this fails toward under-report.
      const totalPct = recipients.reduce((s, r) => s + r.percent_allocation, 0)
      const divisor = Math.max(100, totalPct)
      for (const r of recipients) {
        const addr = r.artist_address.toLowerCase()
        // Pass earnings skip platform payout wallets so only the real artists'
        // shares land on a card. The divisor stays over ALL recipients, so each
        // artist still gets EXACTLY their on-chain proportional share (not an
        // inflated one) — the platform cut is simply not credited to any card.
        if (isPass && passExclude.has(addr)) continue
        bump(earned, addr, (value * r.percent_allocation) / divisor)
      }
    } else if (creator && !isPass) {
      // Whole value to the resolved creator when there is no split — 'in' only.
      // Never for a pass: its unsplit creator is the treasury, not an artist.
      bump(earned, creator, value)
    }
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
