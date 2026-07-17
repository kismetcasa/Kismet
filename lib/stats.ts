import { redis, zpairsToMap } from './redis'
import { acquireLock } from './redisLock'
import { getEthUsd } from './ethPrice'
import { fetchTransfersPage } from './inprocessTransfers'
import { expandToEarningsWallets } from './addressUnion'
import { getMomentMetaBatch } from './notifications'
import { getStoredSplits } from './splits'
import { getCachedCreatorRewardRecipient } from './pending'
import { getSmartWalletOwners } from './smartWalletCache'
import { getTrackedCollectionsStrict } from './kv'
import { PATRON_COLLECTION_ADDRESS } from './patronCollection'
import { CREATE_REFERRAL, RESIDENCIES_ADDRESS, OPERATOR_SMART_WALLET } from './config'
import { PLATFORM_FEE_RECIPIENT } from './platformFee'
import { fetchCollectionMoments } from './inprocess'
import { getAirdropsByMoment } from './airdrops'
import { USDC_BASE } from './zoraMint'
import {
  accumulateTransfer,
  exceedsGrowthLimit,
  newAccumulateCounters,
  newPlatformTotals,
  remapEntries,
  transferDedupKey,
  transferMomentRef,
  type PlatformScope,
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
//
// SCOPE LIMIT: only resales filled through Kismet's OWN listings observe this
// path — an off-platform resale (OpenSea/Blur/Zora) pays the artist's EIP-2981
// royalty on-chain but is structurally invisible here (no webhook/indexer
// watches receiver addresses). The card's "resales" figure is therefore
// Kismet-listing royalties, not lifetime secondary income; capturing external
// fills needs an on-chain indexer and a creditExternalRoyalty() writer.
const ROYALTY_ETH_KEY = 'kismetart:stats:royalty:eth'
const ROYALTY_USDC_KEY = 'kismetart:stats:royalty:usdc'
const ROYALTY_LEDGER_KEY = 'kismetart:stats:royalty-ledger'

// Platform-wide SECONDARY (resale) VOLUME — the GROSS buyer payment on each
// Kismet-listing fill, aggregated event-driven (one increment per fill from the
// on-chain-verified listings PATCH) so the platform endpoint never scans the
// listings set. This is the resale companion to the primary `volume` block;
// earnings.secondary captures only the creator-royalty SLICE of these same
// sales, whereas this is the whole sale price. SCOPE LIMIT inherited from the
// royalty credit path: Kismet-listing fills only — off-platform resales
// (OpenSea/Blur/Zora) are structurally invisible here. Idempotent per listing
// via an NX claim committed ATOMICALLY with the increment (same shape as the
// royalty credit's Lua), so a retried/concurrent PATCH counts exactly once.
const SECONDARY_VOLUME_KEY = 'kismetart:stats:secondary'
const secondaryCountedKey = (listingId: string) =>
  `kismetart:stats:secondary-counted:${listingId}`
const RECORD_SECONDARY_LUA = `
if not redis.call('SET', KEYS[1], '1', 'NX') then return 0 end
redis.call('HINCRBYFLOAT', KEYS[2], ARGV[1], ARGV[2])
redis.call('HINCRBY', KEYS[2], 'transactions', 1)
redis.call('HSET', KEYS[2], 'updatedAt', ARGV[3])
return 1
`

// Platform-wide primary-sale roll-up, snapshotted by the SAME rebuild scan
// that writes the per-artist sets (one pass, one row-gating rule — see
// PlatformTotals in lib/statsMath.ts), so /api/stats/platform and the artist
// cards can never disagree about what counted as a sale. Both are
// KISMET-SCOPED: the /transfers feed is In•Process-network-wide (reporting the
// network's volume as Kismet's overstated editions ~6× when first measured),
// so the roll-up folds only rows whose moment lives in a Kismet-tracked
// collection, and — per the 2026-07-14 decision documented on PlatformScope
// (lib/statsMath.ts) — the per-artist sets fold only 'in' + 'pass' rows too:
// every surfaced number on kismet.art means Kismet activity. They differ only
// in WHICH scoped rows they take ('pass' rows credit the real split artists'
// cards but live in the snapshot's passes block, not the art figures).
// Single JSON value, absolute overwrite per successful rebuild; read by
// getPlatformSalesSnapshot.
const PLATFORM_SALES_KEY = 'kismetart:stats:platform:sales'

// Platform payout wallets excluded when a PASS (Patron/Mint-Pass) sale is
// credited to its real artist(s) — the same known-platform set the Patron page
// uses (lib/patronCollection deriveArtistsFromRecipients + CollectionView). The
// per-collection defaultAdmin/payout the UI also excludes is omitted here on
// purpose: the sale-count creditee is the DOMINANT-share recipient, and the
// artist who made the artwork holds the majority, so they win even if a minor
// platform payee slips through — while a slipped payee's earnings share is a
// tiny, un-viewed credit, never the artist's. Empty entries (unset env) are
// filtered so the set never contains ''.
const PASS_PLATFORM_ADDRESSES: ReadonlySet<string> = new Set(
  [PLATFORM_FEE_RECIPIENT, CREATE_REFERRAL, RESIDENCIES_ADDRESS, OPERATOR_SMART_WALLET]
    .filter((a): a is string => typeof a === 'string' && a.length > 0)
    .map((a) => a.toLowerCase()),
)
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

// Refuse to overwrite when the new scan folded dramatically fewer TRANSFERS
// than the last successful run. The feed is an append-only lifetime history,
// so the counted-row total only grows; a big shrink means a malfunctioning
// scan (upstream truncation the shape check couldn't classify), not reality.
// Counted rows — unlike member cardinality — are independent of attribution
// re-keying and the smart-wallet fold, so legitimate re-attribution can never
// wedge the guard; and because the baseline comes from the last SUCCESSFUL
// run (stored below), it protects platforms of any size, including an
// all-artists wipe by an empty-but-shape-valid response. Self-healing: an
// aborted write is retried by the next cron run against the same baseline.
const MIN_COUNT_RETENTION = 0.8
// Value-jump circuit breaker (exceedsGrowthLimit in lib/statsMath.ts): refuse
// the overwrite when a run's in-scope gross value (art + passes, per currency)
// exceeds the last successful run's by more than MAX_VALUE_GROWTH×. This is the
// ONLY detector for upstream UNIT drift — a per-row sanity ceiling can't catch
// it (a base-unit USDC value for a real $1–$1,000 sale, 1e6–1e9, overlaps the
// legitimate human range), but drift multiplies the whole re-scanned total by
// ≥1e6× in one run, which the ratio catches.
//
// Factor 1000 (not 100): drift is ≥1e6×, so 1000 still catches it with wide
// margin, while NO organic hour grows the cumulative lifetime total by 1000× —
// that separation is what lets the floors sit LOW enough to keep the guard
// armed at the platform's real (small) volume without a genuine viral hour
// wedging every future rebuild. The floors only skip a dust-sized baseline
// where a ratio is meaningless; an unset (pre-field) baseline skips entirely.
// If drift ever trips it, the error names the exact key to DEL to override.
const MAX_VALUE_GROWTH = 1000
const VALUE_GUARD_FLOOR_ETH = 0.005
const VALUE_GUARD_FLOOR_USDC = 5
const LAST_REBUILD_KEY = 'kismetart:stats:last-rebuild'
interface LastRebuild {
  counted: number
  // In-scope (Kismet-tracked) paid transactions from the last successful run.
  // The scope gate collapsing to [PLATFORM_COLLECTION] leaves `counted`
  // (network-wide) unchanged, so `counted` cannot detect it — this scoped
  // baseline can. Optional so a pre-field baseline reads undefined and simply
  // skips the scoped guard (like `counted` on the very first run). Both the
  // fail-closed read above and this guard must miss for a wipe to commit.
  inScope?: number
  // In-scope gross value (art + passes, human units) from the last successful
  // run — the value-jump breaker's baseline (see MAX_VALUE_GROWTH). Optional
  // like `inScope`: a pre-field baseline skips the guard.
  eth?: number
  usdc?: number
  at: number
}

// Single-flight lock so overlapping runs (a manual trigger during the hourly
// cron, or — as the feed grows — a scan that runs longer than the cron
// interval) can't interleave writes into the shared :staging keys and commit a
// mix of two scans. TTL > a healthy full scan but short enough that a crashed
// run frees the lock well before the next hourly cron. If a rebuild ever
// exceeds this, the lock lapses mid-run — the same scale threshold that says
// "move to an incremental sync" (see MAX_PAGES).
const REBUILD_LOCK_KEY = 'kismetart:stats:rebuild-lock'
const REBUILD_LOCK_TTL_S = 900

export interface RebuildResult {
  /** True when another rebuild held the single-flight lock and this call was a
   *  no-op — distinct from a completed run so the cron log can tell them apart. */
  skipped: boolean
  artists: number
  transfers: number
  pages: number
  /** Rows skipped as duplicates via a stable feed identifier. */
  duplicates: number
  /** Rows skipped as free (zero/absent value) despite type=payment. */
  skippedFree: number
  /** Rows skipped as corrupt (non-finite / absurd value). */
  skippedInvalid: number
  /** Rows whose VALUE was skipped (unrecognized ERC20); mints still counted. */
  unknownCurrency: number
  /** Editions whose mint credit was dropped — no creator resolvable at all. */
  droppedMints: number
  /** Rows where the KV MomentMeta creator CHANGED the attribution (a KV value
   *  agreeing with the feed is not counted — see resolveMomentCreator). */
  kvCreatorOverrides: number
  /** Rows attributed at the COLLECTION tier — the residual delegated-mint
   *  misattribution risk (correct for single-artist collections only). The
   *  direct read on how much attribution still lacks per-moment data. */
  collectionFallbacks: number
  /** Rows whose creator was recovered from the dominant fee recipient. */
  recoveredCreators: number
  /** Members whose scores were folded onto their owner EOA (smart wallets). */
  remappedWallets: number
  /** Editions sold on Kismet-tracked collections (Σ quantity, in-scope). */
  editionsSold: number
  /** Unique buyer wallets after the smart-wallet→EOA fold (in-scope). */
  collectors: number
  /** In-scope rows with no recognizable buyer field — the direct read on how
   *  much of the collector count the feed's row shape actually supports. */
  buyerMissing: number
  /** Counted rows excluded from the roll-up: other In•Process collections. */
  outOfScope: number
  /** Counted rows excluded from the roll-up: no collection ref resolvable. */
  scopeUnknown: number
  /** Paid Patron/Mint-Pass editions sold (kept out of editionsSold). */
  passEditions: number
  /** Pass editions airdropped as invites (Kismet airdrop records). */
  passInvited: number
  /** Distinct buyers across art + passes (post smart-wallet fold) — the cron
   *  log's combined-collector signal. */
  buyersCombined: number
}

/**
 * The platform-wide primary-sale snapshot the rebuild persists — everything
 * /api/stats/platform serves except the read-time USD derivation and the
 * separately-accrued listing royalties. Coverage counters ride along so the
 * public figures can be qualified (a large buyerMissing means `collectors`
 * undercounts; unknownCurrency/droppedMints qualify the value/edition sums).
 */
export interface PlatformSalesSnapshot {
  updatedAt: number
  /** Paid transfers folded (Kismet-tracked collections only). */
  transactions: number
  /** Editions sold (Σ quantity, incl. creator-unresolvable rows). */
  editions: number
  /** Gross ETH paid (human units). */
  eth: number
  /** Gross USDC paid (human units). */
  usdc: number
  /** Unique buyer wallets (smart wallets folded onto their owner EOA). */
  collectors: number
  /** Artists credited with ≥1 in-scope paid sale (post smart-wallet fold). */
  artists: number
  /** Coverage: in-scope rows with no recognizable buyer field. */
  buyerMissing: number
  /** Coverage: in-scope rows whose value was skipped (unrecognized ERC20). */
  unknownCurrency: number
  /** Coverage: in-scope editions with no resolvable creator (in `editions`). */
  droppedMints: number
  /** Coverage: counted rows excluded — other In•Process apps' collections. */
  outOfScope: number
  /** Coverage: counted rows excluded — no collection ref resolvable. */
  scopeUnknown: number
  /** Unique buyer wallets across art AND passes (smart wallets folded), deduped
   *  so someone who bought both counts once — the honest "total distinct
   *  collectors" figure `collectors` (art-only) can't provide. Optional: absent
   *  on a snapshot written before this field shipped. */
  buyersCombined?: number
  /** Patron/Mint-Pass activity, kept out of the art figures above: paid pass
   *  SALES from the same transfers scan, plus INVITED — editions airdropped
   *  through Kismet's own airdrop records (lib/airdrops.ts), which is where
   *  every pass invite lives (Kismet airdrops bypass the inprocess relay, so
   *  the transfers feed never sees them). */
  passes: {
    transactions: number
    editions: number
    eth: number
    usdc: number
    invited: number
    /** Unique pass-buyer wallets (smart wallets folded). Optional: absent on a
     *  snapshot written before this field shipped. */
    buyers?: number
  }
}

// Absolute swap of all three sets: chunked ZADDs into per-key STAGING keys,
// then one tiny MULTI/EXEC of RENAMEs. Previously each live key was written
// independently (and per-chunk) in a background after() callback — a
// mid-write suspend left mints from scan N beside earnings from scan N-1.
// Staging keeps the bulk writes off the live keys entirely (a crash mid-
// staging leaves live data untouched; orphaned staging keys are DEL'd on the
// next run), and the RENAME transaction commits the whole snapshot or none of
// it while staying tiny — packing every ZADD into one MULTI would make the
// single REST request grow with artist count toward Upstash's max-request
// size. The swap also drops stale members: without it, an artist absent from
// the current scan kept their old score forever (scores could only ever stick
// high, never correct downward). An empty map maps to DEL of the live key
// (RENAME of a nonexistent staging key would error).
async function writeStatsAtomically(
  mints: Map<string, number>,
  eth: Map<string, number>,
  usdc: Map<string, number>,
): Promise<void> {
  const keys = [
    [MINTS_KEY, mints],
    [ETH_KEY, eth],
    [USDC_KEY, usdc],
  ] as const
  const staged: { live: string; staging: string; hasEntries: boolean }[] = []
  for (const [key, m] of keys) {
    const staging = `${key}:staging`
    await redis.del(staging)
    const entries = [...m]
      .filter(([, v]) => v > 0)
      .map(([member, score]) => ({ score, member }))
    for (let i = 0; i < entries.length; i += 1000) {
      const chunk = entries.slice(i, i + 1000)
      await redis.zadd(staging, chunk[0], ...chunk.slice(1))
    }
    staged.push({ live: key, staging, hasEntries: entries.length > 0 })
  }
  const tx = redis.multi()
  for (const s of staged) {
    if (s.hasEntries) tx.rename(s.staging, s.live)
    else tx.del(s.live)
  }
  await tx.exec()
}

// Rebuild all stats from /transfers. Idempotent, self-healing, backfills history.
// Single-flight (a concurrent run returns { skipped: true }). Aborts (throws)
// on a fetch failure, a wrong-shaped 200, an over-window feed, a non-row-unique
// dedup identifier, a zero-row scan over live data, or an implausible
// counted-transfers shrink — so a bad scan never overwrites good totals. Drive
// from the cron route, or call once to backfill.
export async function rebuildStats(): Promise<RebuildResult> {
  const lock = await acquireLock(REBUILD_LOCK_KEY, REBUILD_LOCK_TTL_S)
  if (!lock.acquired) return { ...EMPTY_REBUILD_RESULT, skipped: true }
  try {
    return await runRebuild()
  } finally {
    await lock.release()
  }
}

// The zero-work result shape, reused for the skipped path.
const EMPTY_REBUILD_RESULT: RebuildResult = {
  skipped: false,
  artists: 0,
  transfers: 0,
  pages: 0,
  duplicates: 0,
  skippedFree: 0,
  skippedInvalid: 0,
  unknownCurrency: 0,
  droppedMints: 0,
  kvCreatorOverrides: 0,
  collectionFallbacks: 0,
  recoveredCreators: 0,
  remappedWallets: 0,
  editionsSold: 0,
  collectors: 0,
  buyerMissing: 0,
  outOfScope: 0,
  scopeUnknown: 0,
  passEditions: 0,
  passInvited: 0,
  buyersCombined: 0,
}

// Editions airdropped as pass INVITES, from Kismet's own per-moment airdrop
// records. Token IDs come from the patron collection's timeline (falling back
// to token '1' — the collection is a single-artwork release — so an upstream
// blip can't zero the count entirely); each record row is one recipient with
// an edition `amount`. Records are capped at 500/moment (lib/airdrops.ts),
// far above the pass's 100-edition supply, so the cap can't truncate this.
// Best-effort: a Redis/upstream failure undercounts for one run and the next
// hourly scan heals it.
async function countPatronInvites(): Promise<number> {
  try {
    const moments = await fetchCollectionMoments(PATRON_COLLECTION_ADDRESS, {
      limit: 200,
      timeoutMs: 8_000,
    })
    const tokenIds = new Set<string>(['1'])
    for (const m of moments) {
      if (m.token_id != null) tokenIds.add(String(m.token_id))
    }
    const perToken = await Promise.all(
      [...tokenIds].map((tid) =>
        getAirdropsByMoment(PATRON_COLLECTION_ADDRESS, tid, { limit: 500 }),
      ),
    )
    let invited = 0
    for (const records of perToken) {
      for (const r of records) {
        const amt = typeof r.amount === 'number' && Number.isFinite(r.amount) && r.amount > 0
          ? Math.floor(r.amount)
          : 1
        invited += amt
      }
    }
    return invited
  } catch {
    return 0
  }
}

async function runRebuild(): Promise<RebuildResult> {
  const mints = new Map<string, number>()
  const eth = new Map<string, number>()
  const usdc = new Map<string, number>()
  const counters = newAccumulateCounters()
  const platform = newPlatformTotals()
  // Kismet's tracked-collection registry, read ONCE per scan — the scope gate
  // for BOTH the per-artist maps and the platform roll-up (the feed is
  // network-wide; see PLATFORM_SALES_KEY). Read FAIL-CLOSED: the memoized
  // getTrackedCollections degrades to [PLATFORM_COLLECTION] on a Redis error
  // and caches that success for its full TTL, so a transient blip could pin a
  // one-collection scope long after Redis recovers — and because this rebuild
  // does an absolute destructive overwrite, every other collection would
  // classify out-of-scope and the swap would WIPE those artists' earnings,
  // invisible to the row-count guards (which watch `counted`, not the scoped
  // roll-up). getTrackedCollectionsStrict throws on a Redis failure so the
  // rebuild aborts and retries next cron instead; the scoped-shrink guard below
  // backstops any non-throwing collapse (e.g. an empty-but-successful read).
  const tracked = new Set(
    (await getTrackedCollectionsStrict()).map((c) => c.toLowerCase()),
  )
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
    // A shape-valid but EMPTY page is the end of the feed: offset pagination
    // has no legitimate empty middle pages. Break instead of continuing so a
    // feed that shrank mid-scan (below the page-1 snapshot) ends the walk
    // cleanly rather than throwing on out-of-range pages every run.
    if (res.transfers.length === 0) break

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
      // Scope from the SAME ref the KV-creator lookup used: the Patron/Pass
      // collection routes to the passes sub-totals (checked before the
      // tracked set, which contains it); other tracked collections fold into
      // the art roll-up; resolvable but untracked → another In•Process app's
      // sale; no ref → fail closed.
      const ref = refs[i]
      const scope: PlatformScope = ref
        ? ref.collection === PATRON_COLLECTION_ADDRESS
          ? 'pass'
          : tracked.has(ref.collection)
            ? 'in'
            : 'out'
        : 'unknown'
      accumulateTransfer(
        t,
        {
          usdcAddress: USDC_BASE,
          kvCreator: metas[i]?.creator ?? null,
          platformAddresses: PASS_PLATFORM_ADDRESSES,
        },
        mints,
        eth,
        usdc,
        counters,
        platform,
        scope,
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

  // Circuit breaker on the dedup itself: boundary drift on a live feed
  // produces a handful of duplicates per scan, never a majority. A duplicate
  // count exceeding the rows kept means the "unique" identifier is not
  // row-unique (e.g. the feed's id is a moment id shared by every sale of
  // that moment) — folding would collapse repeat sales platform-wide, so
  // abort rather than write the gutted totals.
  if (duplicates > counters.counted) {
    throw new Error(
      `dedup discarded ${duplicates} rows vs ${counters.counted} kept — ` +
        'feed identifier is not row-unique, refusing to overwrite',
    )
  }

  // Zero-row wipe guard, independent of the baseline: the swap below can DEL
  // live keys (unlike the old ZADD-only writer), and the counted baseline
  // doesn't exist before the FIRST successful run — so an empty-but-shape-
  // valid response on that first run (error envelope served as 200 with the
  // right fields) could otherwise wipe every artist exactly once, unguarded.
  // An empty scan may only proceed when there is nothing live to lose. The
  // zcard deliberately has NO catch: this guard must FAIL CLOSED — treating a
  // failed liveness read as "nothing live" would disarm the wipe backstop
  // during exactly the flapping-Redis incident it exists for, and a thrown
  // read costs nothing (the write phase needs Redis anyway; next cron retries).
  if (counters.counted === 0) {
    const live = await redis.zcard(MINTS_KEY)
    if (live > 0) {
      throw new Error(
        'rebuild folded 0 transfers but live stats exist — refusing wipe',
      )
    }
  }

  // Sanity guard before the destructive swap: the feed is append-only, so the
  // folded-row total from the last SUCCESSFUL run can only grow. A shrink
  // means a malfunctioning scan (upstream truncation the shape check couldn't
  // classify) — keep the last good totals and let the next run retry. Read
  // failures on the baseline fail OPEN (null → no guard) so a Redis blip
  // can't wedge the rebuild; the zero-row guard above still backstops a
  // total wipe.
  const prev = await redis.get<LastRebuild>(LAST_REBUILD_KEY).catch(() => null)
  if (
    typeof prev?.counted === 'number' &&
    prev.counted > 0 &&
    counters.counted < prev.counted * MIN_COUNT_RETENTION
  ) {
    throw new Error(
      `rebuild folded ${counters.counted} transfers vs ${prev.counted} last run — ` +
        'implausible shrink, refusing to overwrite',
    )
  }
  // Scoped-shrink guard: the in-scope (Kismet) paid-transaction total is also
  // append-only and can only grow across runs. A drop means the SCOPE
  // collapsed (tracked-set degradation, an empty read, an attribution bug) —
  // which the `counted` guard above can't see because `counted` stays
  // network-wide. Fail-closed here so a collapse aborts before the destructive
  // swap wipes every non-platform artist's earnings, rather than after. Same
  // baseline-from-last-success + fail-open-on-missing shape as the guard above.
  if (
    typeof prev?.inScope === 'number' &&
    prev.inScope > 0 &&
    platform.transactions < prev.inScope * MIN_COUNT_RETENTION
  ) {
    throw new Error(
      `rebuild folded ${platform.transactions} in-scope transactions vs ${prev.inScope} last run — ` +
        'scope collapse (degraded tracked set?), refusing to overwrite',
    )
  }
  // Value-jump breaker (see MAX_VALUE_GROWTH): combined art+pass gross per
  // currency, so unit drift anywhere the endpoint serves money aborts before
  // the destructive swap rather than publishing a ×1e6 earnings figure.
  const grossEth = platform.eth + platform.passes.eth
  const grossUsdc = platform.usdc + platform.passes.usdc
  for (const [label, prevV, nowV, floor] of [
    ['ETH', prev?.eth, grossEth, VALUE_GUARD_FLOOR_ETH],
    ['USDC', prev?.usdc, grossUsdc, VALUE_GUARD_FLOOR_USDC],
  ] as const) {
    if (exceedsGrowthLimit(prevV, nowV, floor, MAX_VALUE_GROWTH)) {
      throw new Error(
        `rebuild folded ${nowV} gross ${label} vs ${prevV} last run — implausible ` +
          `×${Math.round(nowV / (prevV as number))} jump (feed unit drift?); verify upstream and ` +
          `DEL ${LAST_REBUILD_KEY} to override`,
      )
    }
  }

  // Fold smart-wallet-credited scores onto the owning EOA so profile reads
  // (which union FC-verified wallets + known smart wallets) see them under
  // the artist. One MGET over the unique members; unknown members pass through.
  const members = [...new Set([...mints.keys(), ...eth.keys(), ...usdc.keys()])]
  const remap = await getSmartWalletOwners(members)
  const mintsFinal = remapEntries(mints, remap)
  const ethFinal = remapEntries(eth, remap)
  const usdcFinal = remapEntries(usdc, remap)

  // Same fold for the roll-up's BUYERS and in-scope ARTISTS: a wallet the
  // feed credits via its inprocess smart wallet is the same person as the
  // owning EOA, so counting both would double-count them. One lookup for the
  // union, separate from the score remap above so `remappedWallets` keeps
  // meaning "artist scores folded".
  // Pass invites ride the same run so the snapshot's passes block is one
  // consistent read — the extra work is one bounded timeline fetch + a few
  // small ZRANGEs per hour.
  const passInvited = await countPatronInvites()

  const platRemap = await getSmartWalletOwners([
    ...new Set([...platform.buyers, ...platform.passes.buyers, ...platform.artists]),
  ])
  const collectors = new Set<string>()
  for (const b of platform.buyers) collectors.add(platRemap.get(b) ?? b)
  const passBuyers = new Set<string>()
  for (const b of platform.passes.buyers) passBuyers.add(platRemap.get(b) ?? b)
  // Combined distinct buyers across art + passes — a true union (someone who
  // bought both counts once), which adding the two counts could never give.
  const buyersCombined = new Set<string>([...collectors, ...passBuyers])
  const scopedArtists = new Set<string>()
  for (const a of platform.artists) scopedArtists.add(platRemap.get(a) ?? a)

  await writeStatsAtomically(mintsFinal, ethFinal, usdcFinal)
  // Advance the guard baseline only after the swap committed, so an aborted
  // or crashed write never moves it — and only to a POSITIVE count, so a
  // legitimate pre-launch empty scan can't disarm the shrink guard with a
  // zero baseline.
  if (counters.counted > 0) {
    await redis
      .set(LAST_REBUILD_KEY, {
        counted: counters.counted,
        inScope: platform.transactions,
        eth: grossEth,
        usdc: grossUsdc,
        at: Date.now(),
      } satisfies LastRebuild)
      .catch(() => {})
  }

  const artists = new Set([
    ...mintsFinal.keys(),
    ...ethFinal.keys(),
    ...usdcFinal.keys(),
  ]).size

  // Persist the platform roll-up only after the per-artist swap committed, so
  // the snapshot can never reflect a scan the guards rejected. Best-effort but
  // LOUD on failure: a silently-stale snapshot serves hour-old public totals
  // with no trace, and the next hourly run heals it either way.
  await redis
    .set(PLATFORM_SALES_KEY, {
      updatedAt: Date.now(),
      transactions: platform.transactions,
      editions: platform.editions,
      eth: platform.eth,
      usdc: platform.usdc,
      collectors: collectors.size,
      artists: scopedArtists.size,
      buyerMissing: platform.buyerMissing,
      unknownCurrency: platform.unknownCurrency,
      droppedMints: platform.droppedMints,
      outOfScope: platform.outOfScope,
      scopeUnknown: platform.scopeUnknown,
      buyersCombined: buyersCombined.size,
      // Explicit fields, NOT `...platform.passes` — that would spread the
      // `buyers` Set into the JSON (serializing to `{}`); persist its size.
      passes: {
        transactions: platform.passes.transactions,
        editions: platform.passes.editions,
        eth: platform.passes.eth,
        usdc: platform.passes.usdc,
        invited: passInvited,
        buyers: passBuyers.size,
      },
    } satisfies PlatformSalesSnapshot)
    .catch((err) =>
      console.error('[stats] platform snapshot write failed (stale until next run)', err),
    )

  return {
    skipped: false,
    artists,
    transfers: counters.counted,
    pages: page - 1,
    duplicates,
    skippedFree: counters.skippedFree,
    skippedInvalid: counters.skippedInvalid,
    unknownCurrency: counters.unknownCurrency,
    droppedMints: counters.droppedMints,
    kvCreatorOverrides: counters.kvCreatorOverrides,
    collectionFallbacks: counters.collectionFallbacks,
    recoveredCreators: counters.recoveredCreators,
    remappedWallets: remap.size,
    editionsSold: platform.editions,
    collectors: collectors.size,
    buyerMissing: platform.buyerMissing,
    outOfScope: platform.outOfScope,
    scopeUnknown: platform.scopeUnknown,
    passEditions: platform.passes.editions,
    passInvited,
    buyersCombined: buyersCombined.size,
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

// Single-artist earnings for the profile card. Reads the per-artist zsets the
// rebuild writes — which are now KISMET-SCOPED (rebuildStats folds 'in' art
// rows plus 'pass' rows credited to their real split artists; 'out'/'unknown'
// are excluded — see accumulateTransfer's creditArtist gate), so a card shows
// the artist's Kismet activity (art + any Patron split they earned), not their
// network-wide In•Process earnings. Unioned across the artist's earnings wallets
// (expandToEarningsWallets): the FC sibling set the timeline uses for their
// mints/collects, PLUS each sibling's inprocess smart wallet — the address the
// feed attributes Kismet mints to. Without the union an FC artist who minted
// from one wallet but whose profile resolves to another reads 0 and the card
// vanishes despite real sales. A non-FC artist resolves to [self, smart
// wallet?], so this stays ~one zscore per key for them. Pass `wallets` to
// reuse a set the caller already resolved (e.g. /api/stats shares one
// resolution across this and the pending roll-up). Returns primary (mint) and
// secondary (listing-royalty) earnings both separately and summed into the
// total. Visibility gating is applied by the callers, not here — raw read.
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

// The rebuild-persisted platform roll-up, or null before the first successful
// rebuild (or on a Redis blip) — callers surface "not computed yet" rather
// than a fabricated zero. Accepts both string and auto-parsed object shapes,
// like every other JSON read against the Upstash REST SDK.
export async function getPlatformSalesSnapshot(): Promise<PlatformSalesSnapshot | null> {
  try {
    const raw = await redis.get<PlatformSalesSnapshot | string | null>(PLATFORM_SALES_KEY)
    if (!raw) return null
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as PlatformSalesSnapshot) : raw
    return typeof parsed?.updatedAt === 'number' ? parsed : null
  } catch {
    return null
  }
}

/** Persisted secondary-volume aggregate, or null before the first fill. */
export interface SecondaryVolume {
  /** Kismet-listing fills counted. */
  transactions: number
  /** Gross ETH resale volume (human units). */
  eth: number
  /** Gross USDC resale volume (human units). */
  usdc: number
  updatedAt: number
}

/**
 * Record one Kismet-listing fill's GROSS sale price into the platform
 * secondary-volume aggregate. Called from the on-chain-verified listings PATCH.
 * Idempotent per listing (NX claim, atomic with the increment), so a retried or
 * concurrent fill counts once. Best-effort — returns false on a non-positive
 * price, empty id, or Redis error, and never throws (must never fail the sale).
 * `price` is in HUMAN units (the caller converts from base units).
 */
export async function recordSecondaryVolume(args: {
  listingId: string
  currency: 'eth' | 'usdc'
  price: number
}): Promise<boolean> {
  const { listingId, currency, price } = args
  if (!listingId || !Number.isFinite(price) || price <= 0) return false
  try {
    const wrote = await redis.eval(
      RECORD_SECONDARY_LUA,
      [secondaryCountedKey(listingId), SECONDARY_VOLUME_KEY],
      [currency, String(price), String(Date.now())],
    )
    return wrote === 1
  } catch {
    return false
  }
}

/** The secondary-volume aggregate, or null before the first fill / on error. */
export async function getSecondaryVolume(): Promise<SecondaryVolume | null> {
  try {
    const h = await redis.hgetall<Record<string, string | number>>(SECONDARY_VOLUME_KEY)
    if (!h) return null
    const num = (v: unknown) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : 0
    }
    const updatedAt = num(h.updatedAt)
    if (!updatedAt) return null
    return { transactions: num(h.transactions), eth: num(h.eth), usdc: num(h.usdc), updatedAt }
  } catch {
    return null
  }
}

// Platform-wide secondary-royalty totals — the Σ over the per-artist royalty
// zsets, which accrue event-driven (creditListingRoyalty) rather than via the
// rebuild. Small sets (one member per credited artist wallet), so a full
// ZRANGE is a couple of commands, and both reads ride one auto-pipelined
// round trip. Scope limit inherited from the credit path: Kismet-listing
// fills only — off-platform (OpenSea/Blur/Zora) resales are invisible here.
export async function getRoyaltyTotals(): Promise<{ eth: number; usdc: number }> {
  try {
    const [rawEth, rawUsdc] = await Promise.all([
      redis.zrange(ROYALTY_ETH_KEY, 0, -1, { withScores: true }) as Promise<(string | number)[]>,
      redis.zrange(ROYALTY_USDC_KEY, 0, -1, { withScores: true }) as Promise<(string | number)[]>,
    ])
    const sum = (raw: (string | number)[]) => {
      let total = 0
      for (const v of zpairsToMap(raw).values()) total += v
      return total
    }
    return { eth: sum(rawEth), usdc: sum(rawUsdc) }
  } catch {
    return { eth: 0, usdc: 0 }
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

// What creditListingRoyalty actually did for a fill. Returned to the caller
// so the royalty AUDIT (lib/royaltyAudit.ts) records the credit path's real
// outcome instead of re-deriving the receiver↔split match with its own RPC
// reads — two independent resolvers for the same question had already drifted
// once, and instrumentation that disagrees with the mechanism it measures is
// worse than none.
export interface RoyaltyCreditOutcome {
  /** False when the per-listing claim was already taken (retry / concurrent
   *  fill) or the credit failed — nothing was written this call. */
  credited: boolean
  /** True when the receiver decomposed into stored-split member credits. */
  decomposed: boolean
  /** The candidate token whose split matched the receiver (the listed token
   *  or the cover '1'); null when no decomposition happened. */
  matchedTokenId: string | null
  /** The credits this call computed. NON-empty on an already-claimed retry
   *  (credited:false but the match/decomposition still reflect this fill);
   *  empty only when the credit was rejected before decomposition (invalid
   *  amount/receiver) or errored (failed:true). */
  credits: Array<{ member: string; amount: number }>
  /** True when the credit attempt ERRORED (Redis eval failure) — the zeroed
   *  decomposition fields then mean "unknown", not "no split matched". The
   *  audit records this so infra failures aren't counted as coverage gaps. */
  failed: boolean
}

const NO_CREDIT: RoyaltyCreditOutcome = {
  credited: false,
  decomposed: false,
  matchedTokenId: null,
  credits: [],
  failed: false,
}

// Credit a secondary-sale creator royalty to the artist(s) who earned it.
// Called once per fill from the on-chain-verified listings PATCH handler with
// the royalty amount actually settled on-chain (human units).
//
// Royalties are configured COLLECTION-WIDE — one EIP-2981 receiver per
// contract, set at deploy. When that receiver is a plain wallet, the whole
// amount is credited to it (it surfaces on the owner's card via the earnings-
// wallet union). When it is the moment's 0xSplits payout split — the default
// for split mints — crediting the contract address stranded the royalty where
// no artist's read could see it, so: if the receiver matches the token's
// on-chain creator-reward recipient AND we hold that split's recipient list,
// the amount is decomposed pro-rata and each member wallet credited directly.
// Falls back to the single-receiver credit whenever the membership can't be
// established (never guesses).
//
// Idempotent per listing via the NX claim, committed atomically with the
// credit and a ledger entry (see CREDIT_ROYALTY_LUA). Best-effort — never
// fails the sale; a swallowed failure reports credited: false.
export async function creditListingRoyalty(args: {
  listingId: string
  currency: 'eth' | 'usdc'
  amount: number
  receiver: string
  /** Listed token, for split decomposition. Optional: absent = wallet credit. */
  collection?: string
  tokenId?: string
}): Promise<RoyaltyCreditOutcome> {
  const { listingId, currency, amount, receiver, collection, tokenId } = args
  if (!Number.isFinite(amount) || amount <= 0) return NO_CREDIT
  const member = receiver.toLowerCase()
  if (!member) return NO_CREDIT
  try {
    // Default: the receiver takes the whole amount.
    let credits: Array<{ member: string; amount: number }> = [{ member, amount }]
    let matchedTokenId: string | null = null

    if (collection && tokenId) {
      // Stored-splits first (Redis, cheap); only a membership hit pays the
      // receiver-verification read. Candidates: the listed token's split,
      // else the cover token #1's (collection-wide royalty receivers are
      // usually configured from the cover's split).
      const decomposed = await resolveRoyaltySplitCredits(
        collection,
        tokenId,
        member,
        amount,
      )
      if (decomposed) {
        credits = decomposed.credits
        matchedTokenId = decomposed.matchedTokenId
      }
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
    const wrote = await redis.eval(
      CREDIT_ROYALTY_LUA,
      [royaltyCreditedKey(listingId), zsetKey, ROYALTY_LEDGER_KEY],
      [listingId, ledgerEntry, ...credits.flatMap((c) => [c.member, String(c.amount)])],
    )
    return {
      credited: wrote === 1,
      decomposed: matchedTokenId !== null,
      matchedTokenId,
      credits,
      failed: false,
    }
  } catch {
    // Swallow — royalty stats are best-effort and must never fail the sale.
    return { ...NO_CREDIT, failed: true }
  }
}

// The per-member decomposition for a split-contract royalty receiver, or null
// when membership can't be established (wallet receiver, unstored split,
// mismatched addresses, RPC failure). Members with a zero share are dropped.
// Stored-splits reads go out together in one auto-pipelined round trip; only
// a membership hit pays the recipient lookup, which reads the SAME TTL-bounded
// kismetart:splitaddr:* cache the pending roll-up maintains and race-bounds
// any cold on-chain read — this runs awaited on the sale-confirmation path,
// so latency must stay bounded and the common case must stay Redis-only.
async function resolveRoyaltySplitCredits(
  collection: string,
  tokenId: string,
  receiver: string,
  amount: number,
): Promise<{ matchedTokenId: string; credits: Array<{ member: string; amount: number }> } | null> {
  try {
    const tids = [...new Set([tokenId, '1'])]
    const stored = await Promise.all(tids.map((tid) => getStoredSplits(collection, tid)))
    for (let i = 0; i < tids.length; i++) {
      if (!stored[i].recipients.length) continue
      const onchain = await getCachedCreatorRewardRecipient(collection, tids[i])
      if (!onchain || onchain !== receiver) continue
      const credits = stored[i].recipients
        .map((r) => ({
          member: r.address.toLowerCase(),
          amount: (amount * r.percentAllocation) / 100,
        }))
        .filter((c) => c.amount > 0)
      return credits.length ? { matchedTokenId: tids[i], credits } : null
    }
    return null
  } catch {
    return null
  }
}
