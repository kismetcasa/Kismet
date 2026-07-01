import { redis } from './redis'
import { getEthUsd } from './ethPrice'
import { fetchTransfersPage } from './inprocessTransfers'
import { expandToEarningsWallets } from './addressUnion'
import { getMomentMetaBatch } from './notifications'
import { getStoredSplits } from './splits'
import { creatorRewardRecipient } from './royaltyAudit'
import { getSmartWalletOwners } from './smartWalletCache'
import { USDC_BASE } from './zoraMint'
import {
  accumulateTransfer,
  newAccumulateCounters,
  remapEntries,
  transferDedupKey,
  transferMomentRef,
} from './statsMath'
import type { EarningsAmounts } from './earningsFormat'

// Per-artist primary-sale stats, rebuilt from the In•Process /transfers feed
// (the canonical, complete, historical record — see rebuildStats). Native ETH
// and USDC totals are the stable truth (one sorted set each, keyed by artist);
// USD is derived at read time. Paid mints live in a third set; free mints are
// excluded upstream (type=payment) and here.
const MINTS_KEY = 'kismetart:stats:mints'
const ETH_KEY = 'kismetart:stats:earned:eth'
const USDC_KEY = 'kismetart:stats:earned:usdc'

// Per-artist SECONDARY-sale royalty earnings (creator royalty on Seaport resales),
// in human units keyed by artist. SEPARATE from the earned:* sets above on
// purpose: those are rebuilt with absolute writes from /transfers (rebuildStats),
// which would wipe any royalties merged in. Royalties are event-driven instead —
// credited once per fill from the on-chain-verified PATCH handler
// (creditListingRoyalty) — so they accrue forward. Every credit is also
// journaled into ROYALTY_LEDGER_KEY (an HSET keyed by listingId), giving a
// durable per-fill record a future reconcile/rebuild pass can replay; the live
// zsets remain the read path.
const ROYALTY_ETH_KEY = 'kismetart:stats:royalty:eth'
const ROYALTY_USDC_KEY = 'kismetart:stats:royalty:usdc'
const ROYALTY_LEDGER_KEY = 'kismetart:stats:royalty-ledger'
// One-time idempotency claim per filled listing so a retried/concurrent fill
// credits exactly once. Committed ATOMICALLY with the credit (see the Lua
// script below) — claiming first and crediting after left a swallowed credit
// failure permanently claimed-but-uncredited, with no rebuild to repair it.
const royaltyCreditedKey = (listingId: string) => `kismetart:royalty-credited:${listingId}`

export interface ArtistEarnings {
  address: string
  // Totals = primary (mints) + secondary (listing royalties).
  eth: number
  usdc: number
  usd: number
  mints: number
  // Source split of the totals, so the card can show "mints vs resales".
  primary: EarningsAmounts
  secondary: EarningsAmounts
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

// 100k transfers. Past this the scan ABORTS (loudly) rather than writing a
// truncated overwrite: with an absolute rewrite, whichever cohort falls outside
// the window would freeze or zero. If this fires, the feed has outgrown the
// full-scan design — move to an incremental sync (cursor + ZINCRBY deltas).
const MAX_PAGES = 1000

// Refuse to overwrite when the new scan finds dramatically fewer artists than
// the sets currently hold. Lifetime totals only grow, so a big shrink means a
// malfunctioning scan (upstream data loss, silent filtering), not reality.
// Floor of 20 artists keeps the guard out of the way while the platform is
// small. Self-healing: an aborted write is retried by the next cron run.
const MIN_ARTIST_RETENTION = 0.8
const GUARD_FLOOR = 20

export interface RebuildResult {
  artists: number
  transfers: number
  pages: number
  /** Rows skipped as duplicates via a stable feed identifier. */
  duplicates: number
  /** Rows skipped entirely: unrecognized ERC20 currency. */
  unknownCurrency: number
  /** Editions whose mint credit was dropped — no creator resolvable at all. */
  droppedMints: number
  /** Rows attributed via the KV MomentMeta creator override. */
  kvCreatorOverrides: number
  /** Rows whose creator was recovered from the dominant fee recipient. */
  recoveredCreators: number
  /** Members whose scores were folded onto their owner EOA (smart wallets). */
  remappedWallets: number
}

// Absolute swap of all three sets in ONE MULTI/EXEC: DEL + chunked ZADDs.
// Previously each key was written independently (and per-chunk) in a
// background after() callback — a mid-write suspend left mints from scan N
// beside earnings from scan N-1. A transaction commits the whole snapshot or
// none of it. The DEL also drops stale members: without it, an artist absent
// from the current scan kept their old score forever (scores could only ever
// stick high, never correct downward).
async function writeStatsAtomically(
  mints: Map<string, number>,
  eth: Map<string, number>,
  usdc: Map<string, number>,
): Promise<void> {
  const tx = redis.multi()
  for (const [key, m] of [
    [MINTS_KEY, mints],
    [ETH_KEY, eth],
    [USDC_KEY, usdc],
  ] as const) {
    tx.del(key)
    const entries = [...m]
      .filter(([, v]) => v > 0)
      .map(([member, score]) => ({ score, member }))
    for (let i = 0; i < entries.length; i += 1000) {
      const chunk = entries.slice(i, i + 1000)
      if (chunk.length) tx.zadd(key, chunk[0], ...chunk.slice(1))
    }
  }
  await tx.exec()
}

// Rebuild all stats from /transfers. Idempotent, self-healing, backfills history.
// Aborts (throws) on a fetch failure, a wrong-shaped 200, an over-window feed,
// or an implausible artist shrink — so a bad scan never overwrites good totals.
// Drive from the cron route, or call once to backfill.
export async function rebuildStats(): Promise<RebuildResult> {
  const mints = new Map<string, number>()
  const eth = new Map<string, number>()
  const usdc = new Map<string, number>()
  const counters = newAccumulateCounters()
  // Dedup across page reads: the live feed is offset-paged, so rows shift
  // across page boundaries as new sales land mid-scan; a row with a stable
  // identifier is folded at most once. Rows without one pass through (no
  // synthetic keys — see transferDedupKey).
  const seen = new Set<string>()
  let duplicates = 0
  let page = 1
  let totalPages = 1

  do {
    const res = await fetchTransfersPage(page)
    if (!res) throw new Error(`transfers fetch failed at page ${page}`)
    // Snapshot the page count from the FIRST response only. Re-reading it
    // every page let a feed that grows mid-scan extend the scan window,
    // widening the offset-drift race for no coverage gain (new rows are
    // picked up by the next hourly run anyway).
    if (page === 1) totalPages = res.pagination.total_pages || 1

    // Per-moment creator override: when the feed exposes a (collection,
    // tokenId), prefer the minter EOA mint-proxy persisted at mint time — the
    // SAME override /api/timeline stitches. Without it, a delegated mint into
    // a curated collection credits the collection owner, not the artist.
    // One MGET per page; absent refs/metas degrade to feed attribution.
    const refs = res.transfers.map(transferMomentRef)
    const metas = await getMomentMetaBatch(
      refs.map((r) => ({ address: r?.collection, tokenId: r?.tokenId })),
    )

    res.transfers.forEach((t, i) => {
      const dedupKey = transferDedupKey(t)
      if (dedupKey) {
        if (seen.has(dedupKey)) {
          duplicates++
          return
        }
        seen.add(dedupKey)
      }
      accumulateTransfer(
        t,
        { usdcAddress: USDC_BASE, kvCreator: metas[i]?.creator ?? null },
        mints,
        eth,
        usdc,
        counters,
      )
    })
    page++
  } while (page <= totalPages && page <= MAX_PAGES)

  if (totalPages > MAX_PAGES) {
    throw new Error(
      `transfers feed exceeds the scan window (${totalPages} pages > ${MAX_PAGES}) — ` +
        'refusing a truncated overwrite; move rebuildStats to an incremental sync',
    )
  }

  // Fold smart-wallet-credited scores onto the owning EOA so profile reads
  // (which union FC-verified wallets + known smart wallets) see them under
  // the artist. One MGET over the unique members; unknown members pass through.
  const members = [...new Set([...mints.keys(), ...eth.keys(), ...usdc.keys()])]
  const remap = await getSmartWalletOwners(members)
  const [mintsFinal, ethFinal, usdcFinal] = [
    remapEntries(mints, remap),
    remapEntries(eth, remap),
    remapEntries(usdc, remap),
  ]

  // Sanity guard before the destructive swap: lifetime artist counts only
  // grow. A scan that "succeeds" but loses a fifth of the artists is a
  // malfunction (upstream truncation this code failed to classify) — keep the
  // last good totals and let the next run retry.
  const prevArtists = await redis.zcard(MINTS_KEY).catch(() => 0)
  if (
    prevArtists >= GUARD_FLOOR &&
    mintsFinal.size < prevArtists * MIN_ARTIST_RETENTION
  ) {
    throw new Error(
      `rebuild produced ${mintsFinal.size} artists vs ${prevArtists} existing — ` +
        'implausible shrink, refusing to overwrite',
    )
  }

  await writeStatsAtomically(mintsFinal, ethFinal, usdcFinal)
  return {
    artists: new Set([...mintsFinal.keys(), ...ethFinal.keys(), ...usdcFinal.keys()]).size,
    transfers: counters.counted,
    pages: page - 1,
    duplicates,
    unknownCurrency: counters.unknownCurrency,
    droppedMints: counters.droppedMints,
    kvCreatorOverrides: counters.kvCreatorOverrides,
    recoveredCreators: counters.recoveredCreators,
    remappedWallets: remap.size,
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

// Single-artist earnings for the profile card. Unioned across the artist's
// earnings wallets (expandToEarningsWallets): the FC sibling set the timeline
// uses for their mints/collects, PLUS each sibling's inprocess smart wallet —
// the address the feed actually attributes Kismet mints to. Without the union
// an FC artist who minted from one wallet but whose profile resolves to
// another reads 0 and the card vanishes despite real sales. A non-FC artist
// resolves to [self, smart wallet?], so this stays ~one zscore per key for
// them. Pass `wallets` to reuse a set the caller already resolved (e.g.
// /api/stats shares one resolution across this and the pending roll-up).
// Returns primary (mint) and secondary (listing-royalty) earnings both
// separately and summed into the total. Visibility gating is applied by the
// callers, not here — this is the raw read.
export async function getArtistEarnings(artist: string, wallets?: string[]): Promise<ArtistEarnings> {
  const lower = artist.toLowerCase()
  try {
    const ws = wallets ?? (await expandToEarningsWallets(lower))
    if (ws.length === 0) {
      // ZMSCORE requires ≥1 member; with no wallets there are no earnings.
      return {
        address: lower, eth: 0, usdc: 0, usd: 0, mints: 0,
        primary: { eth: 0, usdc: 0, usd: 0 }, secondary: { eth: 0, usdc: 0, usd: 0 },
      }
    }
    // One ZMSCORE per key (5 commands total) instead of one ZSCORE per wallet
    // (5 × N). Auto-pipelining only collapses round-trips, not billed command
    // count, so for multi-wallet (FC sibling) artists this is a real per-call
    // saving; for the common N=1 case it's identical. Primary (mints) and
    // secondary (royalties) are summed separately so the card can break them
    // out, then added for the total.
    const [pEth, pUsdc, mints, rEth, rUsdc, ethUsd] = await Promise.all([
      redis.zmscore(ETH_KEY, ws),
      redis.zmscore(USDC_KEY, ws),
      redis.zmscore(MINTS_KEY, ws),
      redis.zmscore(ROYALTY_ETH_KEY, ws),
      redis.zmscore(ROYALTY_USDC_KEY, ws),
      getEthUsd(),
    ])
    // zmscore returns number[] | null (null only if the key is missing); a
    // missing key means no earnings, so coalesce to [] → sum 0.
    const sum = (xs: (number | null)[] | null) =>
      (xs ?? []).reduce<number>((acc, x) => acc + Number(x ?? 0), 0)
    const primEth = sum(pEth)
    const primUsdc = sum(pUsdc)
    const royEth = sum(rEth)
    const royUsdc = sum(rUsdc)
    const eth = primEth + royEth
    const usdc = primUsdc + royUsdc
    // USD is honest, not partial: when the ETH/USD price is unavailable and
    // the figure has an ETH leg, USD is 0 (the card's `usd > 0` gates then
    // hide the USD denomination and fall back to ETH/USDC) rather than a
    // silently-USDC-only number that reads as a crash in earnings. A figure
    // with no ETH leg needs no price and stays exact.
    const usdOf = (e: number, u: number) =>
      ethUsd == null && e > 0 ? 0 : e * (ethUsd ?? 0) + u
    return {
      address: lower,
      eth,
      usdc,
      usd: usdOf(eth, usdc),
      mints: sum(mints),
      primary: { eth: primEth, usdc: primUsdc, usd: usdOf(primEth, primUsdc) },
      secondary: { eth: royEth, usdc: royUsdc, usd: usdOf(royEth, royUsdc) },
    }
  } catch {
    const zero = (): EarningsAmounts => ({ eth: 0, usdc: 0, usd: 0 })
    return { address: lower, eth: 0, usdc: 0, usd: 0, mints: 0, primary: zero(), secondary: zero() }
  }
}

// ── Secondary-royalty credit ─────────────────────────────────────────────────

// Atomic claim + ledger + credit. SET NX takes the per-listing claim; only
// when it wins do the ledger HSET and the per-member ZINCRBYs run — all inside
// one Lua execution, so a transient failure leaves NOTHING (retryable) and a
// success leaves everything. ARGV: [ledgerField, ledgerJson, member, amount,
// member, amount, ...]. Returns 1 when credited, 0 when already claimed.
const CREDIT_ROYALTY_LUA = `
if not redis.call('SET', KEYS[1], '1', 'NX') then return 0 end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[2])
for i = 3, #ARGV, 2 do
  redis.call('ZINCRBY', KEYS[2], ARGV[i + 1], ARGV[i])
end
return 1
`

// Credit a secondary-sale creator royalty to the artist(s) who earned it.
// Called once per fill from the on-chain-verified listings PATCH handler with
// the royalty amount actually settled on-chain (human units).
//
// Royalties are configured COLLECTION-WIDE — one EIP-2981 receiver per
// contract, set at deploy. When that receiver is a plain wallet, the whole
// amount is credited to it (it surfaces on the owner's card via the earnings-
// wallet union). When it is the moment's 0xSplits payout split — the default
// for split mints — crediting the contract address stranded the royalty where
// no artist's read could see it (lib/royaltyAudit.ts documents the gap), so:
// if the receiver matches the token's on-chain creator-reward recipient AND we
// hold that split's recipient list, the amount is decomposed pro-rata and each
// member wallet credited directly. Falls back to the single-receiver credit
// whenever the membership can't be established (never guesses).
//
// Idempotent per listing via the NX claim, committed atomically with the
// credit and a ledger entry (see CREDIT_ROYALTY_LUA). Best-effort — never
// fails the sale.
export async function creditListingRoyalty(args: {
  listingId: string
  currency: 'eth' | 'usdc'
  amount: number
  receiver: string
  /** Listed token, for split decomposition. Optional: absent = wallet credit. */
  collection?: string
  tokenId?: string
}): Promise<void> {
  const { listingId, currency, amount, receiver, collection, tokenId } = args
  if (!Number.isFinite(amount) || amount <= 0) return
  const member = receiver.toLowerCase()
  if (!member) return
  try {
    // Default: the receiver takes the whole amount.
    let credits: Array<{ member: string; amount: number }> = [{ member, amount }]

    if (collection && tokenId) {
      // Stored-splits first (Redis, cheap); only a membership hit pays the
      // on-chain receiver-verification read. Mirror royaltyAudit's precondition:
      // the listed token's split, else the cover token #1's (collection-wide
      // royalty receivers are usually configured from the cover's split).
      const decomposed = await resolveRoyaltySplitCredits(
        collection,
        tokenId,
        member,
        amount,
      )
      if (decomposed) credits = decomposed
    }

    const ledgerEntry = JSON.stringify({
      at: Date.now(),
      listingId,
      currency,
      amount,
      receiver: member,
      credits,
      ...(collection ? { collection: collection.toLowerCase(), tokenId } : {}),
    })
    const zsetKey = currency === 'usdc' ? ROYALTY_USDC_KEY : ROYALTY_ETH_KEY
    await redis.eval(
      CREDIT_ROYALTY_LUA,
      [royaltyCreditedKey(listingId), zsetKey, ROYALTY_LEDGER_KEY],
      [listingId, ledgerEntry, ...credits.flatMap((c) => [c.member, String(c.amount)])],
    )
  } catch {
    // Swallow — royalty stats are best-effort and must never fail the sale.
  }
}

// The per-member decomposition for a split-contract royalty receiver, or null
// when membership can't be established (wallet receiver, unstored split,
// mismatched addresses, RPC failure). Members with a zero share are dropped.
async function resolveRoyaltySplitCredits(
  collection: string,
  tokenId: string,
  receiver: string,
  amount: number,
): Promise<Array<{ member: string; amount: number }> | null> {
  try {
    for (const tid of tokenId === '1' ? ['1'] : [tokenId, '1']) {
      const stored = await getStoredSplits(collection, tid)
      if (!stored.recipients.length) continue
      const onchain = await creatorRewardRecipient(collection, tid)
      if (!onchain || onchain !== receiver) continue
      const credits = stored.recipients
        .map((r) => ({
          member: r.address.toLowerCase(),
          amount: (amount * r.percentAllocation) / 100,
        }))
        .filter((c) => c.amount > 0)
      return credits.length ? credits : null
    }
    return null
  } catch {
    return null
  }
}
