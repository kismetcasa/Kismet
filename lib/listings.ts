import { after } from 'next/server'
import { redis } from './redis'
import { bestEffort } from './bestEffort'
import type { Hex } from 'viem'
import { multicall } from 'viem/actions'
import { SEAPORT_ABI, SEAPORT_ADDRESS, listingOrderHash, type SerializedOrderComponents } from './seaport'
import { serverBaseClient } from './rpc'
import { fanoutToFollowers, writeNotification, getMomentMetaBatch } from './notifications'
import { getEthUsd } from './ethPrice'
import { getListingVisibility } from './hiddenListings'
import { PLATFORM_FEE_RECIPIENT } from './platformFee'
import { clearKismetListed } from './pass-validity'
import { unhideListing } from './hiddenListings'

export interface Listing {
  id: string
  collectionAddress: string
  tokenId: string
  seller: string
  // price/sellerProceeds/royaltyAmount are denominated in the currency's base
  // units: wei for ETH (18 dp), USDC base units (6 dp) for USDC. The currency
  // field disambiguates which.
  price: string
  sellerProceeds: string
  royaltyReceiver: string
  royaltyAmount: string
  // 'eth' for native; 'usdc' for ERC20 USDC consideration. Older rows minted
  // before USDC support are read with a default of 'eth' (see getListing).
  currency: 'eth' | 'usdc'
  // Platform fee baked into the Seaport consideration at index 1.
  // Older rows created before fee support default to '0' (see getListing).
  // INFORMATIONAL ONLY — all financial logic uses orderComponents.consideration
  // directly. On-chain, Seaport pays based on what the seller signed, not these
  // stored values. Do not use these fields for financial calculations.
  platformFee: string
  platformFeeRecipient: string
  orderComponents: SerializedOrderComponents
  signature: string
  createdAt: number       // ms
  expiresAt: number       // ms
  status: 'active' | 'filled' | 'cancelled' | 'expired'
  // Display metadata (denormalized for fast rendering)
  name?: string
  image?: string
  creatorAddress?: string
  // For writing-type moments: content uri (typically ar://) + mime ('text/plain').
  // MarketCard fetches the body via the shared text cache when these are
  // present and renders a preview snippet instead of "no preview".
  contentUri?: string
  contentMime?: string
  // Mint-price snapshot captured SERVER-SIDE at listing-create from the live
  // on-chain sale config — never client-supplied (a lister could otherwise
  // forge a high mint price to buy the below-mint deal signal). Base units of
  // mintPriceCurrency. Absent when the mint had no live sale at listing time
  // or the RPC read failed; such rows never match the belowMint filter
  // (fail-closed). Display badges use the LIVE dwell-gated read instead, so
  // the filter can drift from the badge if the artist reprices after listing.
  mintPrice?: string
  mintPriceCurrency?: 'eth' | 'usdc'
  // Response-only, never stored: the seller-scope GET sets this on the
  // seller's OWN rows that are content-hidden (admin per-listing hide, or
  // the hidden moment/collection cascade) — the rows a visitor's filtered
  // response omits. Mirrors Moment.hidden from the timeline so the profile's
  // public-view preview can drop exactly what visitors don't see.
  hidden?: boolean
}

const KEY_ALL = 'kismetart:listings'
const keyById = (id: string) => `kismetart:listing:${id}`
// One active listing per (collection, tokenId, seller) — supports multiple sellers per token
const keyByOwned = (collection: string, tokenId: string, seller: string) =>
  `kismetart:listings:owned:${collection.toLowerCase()}:${tokenId}:${seller.toLowerCase()}`
const keyBySeller = (seller: string) =>
  `kismetart:listings:seller:${seller.toLowerCase()}`
// Serializes concurrent handlers within one round so a listing is announced
// once. Named for expiry because that was the only outcome it used to gate; it
// now covers the sale/cancel outcomes resolveTerminalStatuses can return too.
// What makes retirement terminal is the STATUS write below, not this key —
// every entry path filters on status === 'active' — and the key's own 7-day
// TTL could not provide durable dedup anyway. The name is kept simply because
// there is no reason to rotate it.
const keyExpiredNotif = (id: string) => `kismetart:listing-notified:${id}`

export async function createListing(
  data: Omit<Listing, 'id' | 'createdAt' | 'status'>
): Promise<Listing> {
  const listing: Listing = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    status: 'active',
  }

  const ownedKey = keyByOwned(data.collectionAddress, data.tokenId, data.seller)

  // Atomic SET NX — only succeeds if no listing already occupies this slot.
  // Two concurrent POSTs for the same token race here; exactly one wins.
  // Non-atomic read-then-write (the prior approach) had a TOCTOU window where
  // both requests saw no incumbent and both created orphaned listings.
  const claimed = await redis.set(ownedKey, listing.id, { nx: true })
  if (!claimed) {
    // NX failed — someone else holds the slot. Check whether their listing is
    // still active (it may have been cancelled/expired since we entered here).
    const incumbentId = await redis.get<string>(ownedKey)
    const incumbent = incumbentId ? await getListing(incumbentId) : null
    if (incumbent && incumbent.status === 'active') {
      throw new Error('Active listing already exists for this token')
    }
    // Incumbent gone (inactive/expired/orphaned) — take the slot.
    await redis.set(ownedKey, listing.id)
  }

  await Promise.all([
    redis.zadd(KEY_ALL, { score: listing.createdAt, member: listing.id }),
    redis.set(keyById(listing.id), JSON.stringify(listing)),
    // ownedKey is already written above via SET NX
    redis.sadd(keyBySeller(listing.seller), listing.id),
  ])

  after(() =>
    fanoutToFollowers(listing.seller, {
      type: 'listing_created',
      tokenAddress: listing.collectionAddress,
      tokenId: listing.tokenId,
      tokenName: listing.name,
      tokenImage: listing.image,
      price: listing.price,
      currency: listing.currency,
      listingId: listing.id,
    }),
  )

  return listing
}

export async function getListing(id: string): Promise<Listing | null> {
  const raw = await redis.get<string | Listing>(keyById(id))
  if (!raw) return null
  const listing: Listing = typeof raw === 'string' ? JSON.parse(raw) : raw
  // Legacy rows minted before USDC support don't carry a currency field —
  // default to ETH so MarketCard / BuyButton don't accidentally enter the
  // USDC code path.
  if (!listing.currency) listing.currency = 'eth'
  // Legacy rows created before platform-fee support have no fee fields.
  if (!listing.platformFee) {
    listing.platformFee = '0'
    listing.platformFeeRecipient = PLATFORM_FEE_RECIPIENT
  }
  return listing
}

// Bulk variant of `getListing`. One MGET in place of N parallel GETs.
// Preserves the legacy currency='eth' fallback so callers see identical
// shapes whether they go through the single or batch path.
async function getListingsBatch(ids: string[]): Promise<(Listing | null)[]> {
  if (ids.length === 0) return []
  const raws = await redis.mget<(string | Listing | null)[]>(...ids.map(keyById))
  return raws.map((raw) => {
    if (!raw) return null
    const listing: Listing = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!listing.currency) listing.currency = 'eth'
    if (!listing.platformFee) {
      listing.platformFee = '0'
      listing.platformFeeRecipient = PLATFORM_FEE_RECIPIENT
    }
    return listing
  })
}

// Look up a specific seller's active listing for a token
export async function getListingForToken(
  collectionAddress: string,
  tokenId: string,
  seller: string
): Promise<Listing | null> {
  const id = await redis.get<string>(
    keyByOwned(collectionAddress.toLowerCase(), tokenId, seller.toLowerCase())
  )
  if (!id) return null
  const listing = await getListing(id)
  if (!listing || listing.status !== 'active' || listing.expiresAt <= Date.now()) return null
  return listing
}

// Periodic sweep — called by lib/backgroundTasks so expiry is claimed
// once per cycle instead of per /api/listings request. The request-time
// check in getListings stays as a safety net for between-sweep gaps.
export async function sweepExpiredListings(): Promise<void> {
  const ids = (await redis.zrange(KEY_ALL, 0, MAX_LISTINGS_SCAN - 1, { rev: true })) as string[]
  if (ids.length === 0) return
  const now = Date.now()
  const expired = (await getListingsBatch(ids)).filter(
    (l): l is Listing => l !== null && l.status === 'active' && l.expiresAt <= now,
  )
  if (expired.length > 0) await handleExpiredListings(expired)
}

/** What actually became of a listing whose clock ran out. */
type TerminalStatus = 'filled' | 'cancelled' | 'expired'

/**
 * Ask Seaport what became of each order, instead of assuming the clock did.
 *
 * A Kismet listing is a signed Seaport order. Kismet learns it sold only when
 * a buyer's client PATCHes /api/listings/[id] — so a fill through any other
 * Seaport surface (a direct fulfillOrder, another marketplace carrying the
 * same order) left the row `active` here until it timed out, at which point
 * the seller was told their listing EXPIRED. That is not merely a missing
 * notification, it is a false one: the piece sold and we announced that it
 * hadn't. getOrderStatus is the frontend-agnostic record — Seaport writes
 * totalFilled on every fulfillment and isCancelled in cancel(), whoever calls
 * them — so one multicall over the batch settles it before anyone is told
 * anything.
 *
 * Everything is failure-biased toward TODAY'S behavior: an unhashable order, a
 * reverting call, or a dead RPC all keep 'expired', so this can only ever
 * convert a wrong answer into a right one, never stall the sweep on chain
 * health.
 *
 * SCOPE: status and notification only. A fill discovered here is deliberately
 * NOT credited to royalties or secondary volume — those figures are
 * Kismet-listing-fills-only by an explicit decision documented on
 * creditListingRoyalty (lib/stats.ts), and widening them is a separate call
 * with its own reconciliation story. The seller gets told the truth either way.
 */
async function resolveTerminalStatuses(listings: Listing[]): Promise<TerminalStatus[]> {
  const out: TerminalStatus[] = listings.map(() => 'expired')
  // Compacted: only the listings whose order actually hashed get a call, with
  // `idx` mapping each result back to its position in `out`.
  const idx: number[] = []
  const contracts: {
    address: typeof SEAPORT_ADDRESS
    abi: typeof SEAPORT_ABI
    functionName: 'getOrderStatus'
    args: readonly [Hex]
  }[] = []
  for (let i = 0; i < listings.length; i++) {
    let orderHash: Hex
    try {
      orderHash = listingOrderHash(listings[i])
    } catch {
      // Malformed/legacy orderComponents — unhashable, so unanswerable. Leave
      // it 'expired' rather than let one bad row abort the whole batch.
      continue
    }
    idx.push(i)
    contracts.push({
      address: SEAPORT_ADDRESS,
      abi: SEAPORT_ABI,
      functionName: 'getOrderStatus',
      args: [orderHash] as const,
    })
  }
  if (contracts.length === 0) return out

  let results
  try {
    // allowFailure so one reverting/undecodable row degrades to 'expired' on
    // its own instead of throwing the batch away.
    results = await multicall(serverBaseClient(), { contracts, allowFailure: true })
  } catch (err) {
    console.error('[listings] Seaport order-status read failed — treating batch as expired', {
      count: contracts.length,
      err: err instanceof Error ? err.message : String(err),
    })
    return out
  }

  // A per-call failure is counted, not just skipped. Falling back to 'expired'
  // is the safe answer, but if the ABI below ever stops matching the deployed
  // Seaport — a wrong signature, a redeploy — EVERY call fails that way and the
  // reconciliation silently stops working while looking exactly like "nothing
  // sold off-platform". That is the failure mode this whole change exists to
  // remove, so it has to be visible in its own implementation too.
  let unreadable = 0
  for (let j = 0; j < idx.length; j++) {
    const r = results[j]
    if (!r || r.status !== 'success') {
      unreadable++
      continue
    }
    const [, isCancelled, totalFilled] = r.result as readonly [boolean, boolean, bigint, bigint]
    // Filled wins over cancelled: the two can only coexist on a partially
    // filled order that was then cancelled, and "it sold" is the fact the
    // seller needs. An untouched off-chain order reads all-zero and stays
    // 'expired', which is the honest answer for it.
    if (totalFilled > 0n) out[idx[j]] = 'filled'
    else if (isCancelled) out[idx[j]] = 'cancelled'
  }
  if (unreadable > 0) {
    console.warn('[listings] Seaport order-status unreadable for some orders', {
      unreadable,
      of: idx.length,
    })
  }
  return out
}

// Retire listings whose clock ran out, announcing what ACTUALLY happened to
// each (see resolveTerminalStatuses). A claim key (NX) ensures exactly one
// notification per listing even under concurrency.
async function handleExpiredListings(listings: Listing[]): Promise<void> {
  // Resolved BEFORE the claim, which is a deliberate trade and not the obvious
  // ordering. Claiming first would be cheaper: the claim decides which handler
  // proceeds, never what it announces, so only the winner would pay for the
  // multicall instead of every concurrent handler paying before dedup rejects
  // it. What claiming first would cost is a much wider crash window — the gap
  // between taking the claim and writing the status would then contain a
  // network round trip, and a process that dies inside it leaves the listing
  // claimed but un-retired for the claim key's full 7-day TTL, announced to
  // nobody. Keeping the RPC outside that gap leaves only Redis writes in it.
  // The duplicated work is bounded in practice: `listings` here is only the
  // rows that crossed expiresAt since the last pass and are still active,
  // which is normally zero.
  const outcomes = await resolveTerminalStatuses(listings)
  await Promise.all(listings.map(async (listing, i) => {
    const status = outcomes[i]
    const claimed = await redis.set(keyExpiredNotif(listing.id), '1', {
      nx: true,
      ex: 7 * 24 * 60 * 60,
    })
    if (!claimed) return

    const updated: Listing = { ...listing, status }
    await Promise.all([
      redis.set(keyById(listing.id), JSON.stringify(updated)),
      redis.del(keyByOwned(listing.collectionAddress, listing.tokenId, listing.seller)),
      redis.zrem(KEY_ALL, listing.id),
      clearKismetListed(listing.collectionAddress, listing.tokenId, listing.seller).catch(() => {}),
      // GC any admin hide on this now-dead slot so the hidden-listings set
      // self-prunes instead of accumulating tombstones for gone listings.
      // Best-effort: a failed prune must never block the expiry write.
      unhideListing(listing.collectionAddress, listing.tokenId, listing.seller).catch(() => {}),
    ])

    // An on-chain cancel is the seller's own deliberate act — they already
    // know. Announcing anything would be noise, and announcing EXPIRY would be
    // wrong.
    if (status === 'cancelled') return

    // 'sale' means it sold through some other Seaport surface, so the seller
    // was never told. Same payload the on-platform fill sends from
    // PATCH /api/listings/[id], minus `actor`: getOrderStatus reports THAT an
    // order filled, never to whom, and inventing a buyer would be worse than
    // omitting one — NotificationRow already renders the actor-less sale as
    // "your listing was filled". `price` is the listing's signed asking price,
    // the same field the on-platform path passes.
    await writeNotification({
      type: status === 'filled' ? 'sale' : 'listing_expired',
      recipient: listing.seller,
      tokenAddress: listing.collectionAddress,
      tokenId: listing.tokenId,
      tokenName: listing.name,
      tokenImage: listing.image,
      price: listing.price,
      // Pair the price with its currency so NotificationRow renders USDC
      // listings correctly (defaults to ETH otherwise).
      currency: listing.currency,
      listingId: listing.id,
    })
  }))
}

const MAX_LISTINGS_SCAN = 500

/** BigInt(price) that never throws — malformed rows sort/filter as 0. */
function safePrice(raw: string): bigint {
  try {
    return BigInt(raw)
  } catch {
    return 0n
  }
}

export interface ListingFilters {
  /** Scope to one settlement currency. Required alongside priceMin/priceMax —
   *  a base-units range is meaningless across wei (18dp) and USDC (6dp). */
  currency?: 'eth' | 'usdc'
  /** Inclusive price bounds in the currency's BASE UNITS. */
  priceMin?: bigint
  priceMax?: bigint
  /** Keep only listings expiring within this many ms from now. */
  expiringWithinMs?: number
  /** 'artist' = seller is the moment's creator, verified against the KV
   *  moment-meta record (NOT the client-supplied creatorAddress display field,
   *  which is spoofable). Unverifiable rows (no meta) are excluded —
   *  fail-closed so the artist badge can't be bought with a forged field. */
  sellerType?: 'artist'
  /** Minimum creator-royalty share of the sale price, in basis points.
   *  Derived from the stored royaltyAmount/price (display-level fields; fine
   *  for a browse filter, never for settlement math). */
  royaltyMinBps?: number
  /** Only listings priced below their mint-price snapshot (same currency,
   *  snapshot present — see Listing.mintPrice for the trust + drift notes). */
  belowMint?: boolean
  /** In-memory sort before pagination. Price sorts compare exact base units
   *  within a currency; cross-currency pairs compare at the Chainlink ETH/USD
   *  rate (rate unavailable → ETH rows group first, order degraded not wrong). */
  sort?: 'price-asc' | 'price-desc' | 'expiring'
}

/** One pass over the marketplace zset: batch-read, drop ghosts and just-
 *  expired rows (with the same cleanup side-effects getListings always had),
 *  return the ACTIVE rows newest-first. Shared by getListings and
 *  getActiveListingSnapshot so the two views of "what's live" can't drift. */
async function scanActiveListings(): Promise<Listing[]> {
  const ids = (await redis.zrange(KEY_ALL, 0, MAX_LISTINGS_SCAN - 1, { rev: true })) as string[]

  const all = await getListingsBatch(ids)
  const now = Date.now()
  const expired: Listing[] = []
  const ghosts: string[] = [] // ZSET entries with no/non-active data — clean up

  const active = all.filter((l, idx): l is Listing => {
    if (!l) {
      ghosts.push(ids[idx])
      return false
    }
    if (l.status === 'active' && l.expiresAt <= now) {
      expired.push(l)
      return false
    }
    if (l.status !== 'active') {
      ghosts.push(l.id)
      return false
    }
    return true
  })

  if (expired.length > 0) {
    after(() => handleExpiredListings(expired))
  }
  if (ghosts.length > 0) {
    redis.zrem(KEY_ALL, ...ghosts).catch(bestEffort('listings.sweepGhosts', { count: ghosts.length }))
  }
  return active
}

export interface ActiveListingSnapshot {
  /** "collection:tokenId" per visible active listing — duplicates are
   *  meaningful (multiple sellers listing the same token = that many live
   *  resales). */
  keys: string[]
  /** Per-collection floor (min active listing price) in BASE UNITS, kept
   *  per currency — a cross-currency min needs an oracle, and a browse
   *  label doesn't warrant one. */
  floors: Record<string, { eth?: string; usdc?: string }>
}

/**
 * One visibility-filtered pass over the active book, folded two ways: the
 * bridge keys (primary ovals' "N resale" asides via /api/listings?keys=1 and
 * the timeline's resale=1 filter) and the collection floors (the drawer's
 * collection picker labels). Visibility-filtered here so a hidden listing can
 * never leak its existence through a count or a floor.
 */
export async function getActiveListingSnapshot(): Promise<ActiveListingSnapshot> {
  const [active, visibility] = await Promise.all([scanActiveListings(), getListingVisibility()])
  const visible = active.filter((l) => !visibility.feedHidden(l))
  const floors: ActiveListingSnapshot['floors'] = {}
  for (const l of visible) {
    const price = safePrice(l.price)
    if (price <= 0n) continue
    const slot = (floors[l.collectionAddress.toLowerCase()] ??= {})
    const cur = l.currency ?? 'eth'
    const prev = slot[cur]
    if (prev === undefined || price < BigInt(prev)) slot[cur] = price.toString()
  }
  return {
    keys: visible.map((l) => `${l.collectionAddress.toLowerCase()}:${l.tokenId}`),
    floors,
  }
}

export async function getListings({
  page = 1,
  limit = 18,
  collection,
  filters,
}: {
  page?: number
  limit?: number
  collection?: string
  filters?: ListingFilters
} = {}): Promise<{ listings: Listing[]; total: number }> {
  const scanned = await scanActiveListings()
  const active = collection
    ? scanned.filter((l) => l.collectionAddress.toLowerCase() === collection.toLowerCase())
    : scanned

  // Browse filters — applied to the full in-memory active set BEFORE
  // pagination, so filtered pages and totals are honest (never the sparse
  // client-side-filtered pages that lie about emptiness). The zset scan is
  // bounded at MAX_LISTINGS_SCAN, so each predicate is a cheap array pass.
  let rows = active
  if (filters?.currency) {
    rows = rows.filter((l) => (l.currency ?? 'eth') === filters.currency)
  }
  if (filters?.priceMin !== undefined) {
    rows = rows.filter((l) => safePrice(l.price) >= filters.priceMin!)
  }
  if (filters?.priceMax !== undefined) {
    rows = rows.filter((l) => safePrice(l.price) <= filters.priceMax!)
  }
  if (filters?.expiringWithinMs !== undefined) {
    const now = Date.now()
    rows = rows.filter((l) => l.expiresAt <= now + filters.expiringWithinMs!)
  }
  if (filters?.royaltyMinBps !== undefined) {
    rows = rows.filter((l) => {
      const price = safePrice(l.price)
      if (price <= 0n) return false
      return (safePrice(l.royaltyAmount) * 10000n) / price >= BigInt(filters.royaltyMinBps!)
    })
  }
  if (filters?.belowMint) {
    rows = rows.filter((l) => {
      if (!l.mintPrice || !l.mintPriceCurrency) return false
      if ((l.currency ?? 'eth') !== l.mintPriceCurrency) return false
      const mint = safePrice(l.mintPrice)
      return mint > 0n && safePrice(l.price) < mint
    })
  }
  if (filters?.sellerType === 'artist') {
    const metas = await getMomentMetaBatch(
      rows.map((l) => ({ address: l.collectionAddress, tokenId: l.tokenId })),
    )
    rows = rows.filter((l, i) => {
      const creator = metas[i]?.creator?.toLowerCase()
      return !!creator && creator === l.seller.toLowerCase()
    })
  }

  if (filters?.sort === 'expiring') {
    rows = [...rows].sort((a, b) => a.expiresAt - b.expiresAt)
  } else if (filters?.sort === 'price-asc' || filters?.sort === 'price-desc') {
    const ethUsd = await getEthUsd().catch(() => null)
    const usdOf = (l: Listing): number => {
      const v = Number(safePrice(l.price))
      return (l.currency ?? 'eth') === 'usdc' ? v / 1e6 : (v / 1e18) * (ethUsd ?? 0)
    }
    const dir = filters.sort === 'price-asc' ? 1 : -1
    rows = [...rows].sort((a, b) => {
      // Same currency → exact base-units compare (oracle-independent).
      if ((a.currency ?? 'eth') === (b.currency ?? 'eth')) {
        const pa = safePrice(a.price)
        const pb = safePrice(b.price)
        return pa < pb ? -dir : pa > pb ? dir : 0
      }
      return (usdOf(a) - usdOf(b)) * dir
    })
  }

  const total = rows.length
  const start = (page - 1) * limit
  return { listings: rows.slice(start, start + limit), total }
}

export async function getListingsBySeller(seller: string): Promise<Listing[]> {
  const ids = await redis.smembers(keyBySeller(seller.toLowerCase())) as string[]
  if (!ids.length) return []
  const all = await getListingsBatch(ids)
  const now = Date.now()
  const expired: Listing[] = []

  const active = all.filter((l): l is Listing => {
    if (!l) return false
    if (l.status === 'active' && l.expiresAt <= now) {
      expired.push(l)
      return false
    }
    return l.status === 'active'
  })

  if (expired.length > 0) {
    after(() => handleExpiredListings(expired))
  }

  return active
}

export async function updateListingStatus(
  id: string,
  status: 'filled' | 'cancelled' | 'expired'
): Promise<void> {
  const listing = await getListing(id)
  if (!listing) return
  const updated: Listing = { ...listing, status }
  await Promise.all([
    redis.set(keyById(id), JSON.stringify(updated)),
    redis.del(keyByOwned(listing.collectionAddress, listing.tokenId, listing.seller)),
    redis.zrem(KEY_ALL, id),
    // GC any admin hide on this now-dead slot (cancel/fill/expire) so the
    // hidden-listings set self-prunes instead of accumulating tombstones.
    // Best-effort: the status transition is critical and must not fail on a
    // prune error.
    unhideListing(listing.collectionAddress, listing.tokenId, listing.seller).catch(
      bestEffort('listings.updateStatus.clearHide', { id, status }),
    ),
  ])
}

/**
 * Hard-delete every listing a seller authored, plus all associated keys. Used
 * by admin profile-erase: a listing is a signed Seaport order the wallet
 * POSTed into our Redis — authored Kismet content, purged with the rest of the
 * profile. Iterates the RAW seller set (ALL statuses — updateListingStatus
 * re-writes keyById and never srem's the index, so terminal-status records the
 * wallet authored linger there) to reap everything. Redis-only, no on-chain
 * artifact — identical to the platform's own seller-cancel; the signed Seaport
 * order simply lapses at its endTime (≤1y). No counterparty harm: a listing
 * routes only the erased seller's own sale, unlike the earnings/splits ledgers
 * erase deliberately retains.
 *
 * Best-effort per listing so one bad record can't strand the rest; the seller
 * index is deleted LAST so a partial failure re-runs cleanly.
 */
export async function deleteListingsBySeller(seller: string): Promise<void> {
  const key = keyBySeller(seller.toLowerCase())
  const ids = (await redis.smembers(key)) as string[]
  if (ids.length === 0) return
  const listings = await getListingsBatch(ids)
  await Promise.all(
    ids.map((id, i) => {
      const l = listings[i]
      return Promise.all([
        redis.del(keyById(id)), // the authored order record
        redis.zrem(KEY_ALL, id), // the market-feed source ZSET
        // Slot lock, hide tombstone, and Pass-listed marker are keyed by
        // collection+tokenId+seller — only reconstructable from the record,
        // so skip them for any id whose row is already gone.
        l ? redis.del(keyByOwned(l.collectionAddress, l.tokenId, l.seller)) : Promise.resolve(),
        l ? unhideListing(l.collectionAddress, l.tokenId, l.seller) : Promise.resolve(),
        l ? clearKismetListed(l.collectionAddress, l.tokenId, l.seller) : Promise.resolve(),
      ]).catch(() => {})
    }),
  )
  await redis.del(key) // seller index last — partial failures re-run cleanly
}
