import { decodeFunctionResult, encodeFunctionData, type Address } from 'viem'
import { getBlock } from 'viem/actions'
import { redis, SWEEP_ENABLED_KEY, SWEEP_INDEX_KEY } from './redis'
import { serverBaseClient } from './rpc'
import { isFlagSet } from './gateFlags'
import { memoize } from './memoCache'
import { isAddress, isValidTokenId } from './address'
import { PATRON_COLLECTION_ADDRESS } from './patronCollection'
import { FPSS_SALE_ABI, aggregate3Strict, readMintFeesWithBound } from './saleConfig'
import { ZORA_1155_TOKEN_INFO_ABI, ZORA_FIXED_PRICE_STRATEGY } from './zoraMint'
import type { ResolvedCatalog } from './catalogCensus'
import {
  buildSweepItem,
  finalizeSweepIndex,
  isLivePaidSale,
  sweepKey,
  type SweepCandidate,
  type SweepIndex,
  type SweepIndexItem,
  type SweepSaleRow,
  type SweepSupplyRow,
} from './sweepIndexCore'

// Sweep index — the I/O half. Rebuilt hourly by app/api/cron/sync-stats from
// the SAME resolved catalog the census just walked (no second inprocess
// fan-out), read by /api/sweep. Two chunked chain passes over Multicall3
// (SWEEP_IMPLEMENTATION.md §2.2):
//
//   1. FixedPriceSaleStrategy.sale() for EVERY visible candidate — fixed-size
//      structs, cheap, and it discards most of the catalog (free, ended,
//      scheduled, USDC-priced, unset rows never reach pass 2).
//   2. getTokenInfo() only for pass-1 survivors, in smaller chunks (each row
//      carries a `uri` string — the same reason the feeds cap supply reads at
//      80/240), plus mintFee() once per surviving collection.
//
// Failure contract: aggregate3Strict THROWS on an RPC-level failure, so a
// transient blip aborts the rebuild and the last good blob stays (the census's
// abort-don't-overwrite stance); a single reverting row is skipped. An EMPTY
// result after a healthy walk is legitimate (everything free / ended / sold)
// and is written as such. Correctness never depends on this index being
// fresh: the click-time re-verification (a cross-collection multicall) is the
// guarantee; the index only has to be a good candidate pool.

// Pass-1 chunk: 200 sale() reads. Each Call3 element ABI-encodes to 256 bytes
// (head + target + allowFailure + 68-byte calldata padded to 96), so a chunk is
// ≈ 51 KB of calldata and ≈ 58 KB of fixed-size return data — far inside any
// RPC payload limit; each sale() read is a few thousand gas of SLOADs, so the
// chunk stays far below an eth_call gas cap as well.
const PASS1_CHUNK = 200
// Pass-2 chunk: bounded by RESPONSE size — every getTokenInfo row carries the
// token's `uri` string (the feeds cap the same read at 80 / 240 rows).
const PASS2_CHUNK = 100

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Chain time, as fetchEligibleTokens reads it; wall-clock only if the block
// read is refused (the hourly build tolerates a few seconds of drift — the
// click-time re-check is authoritative).
async function chainNow(client: ReturnType<typeof serverBaseClient>): Promise<bigint> {
  try {
    return (await getBlock(client, { blockTag: 'latest' })).timestamp
  } catch {
    return BigInt(Math.floor(Date.now() / 1000))
  }
}

/** Visible, well-formed catalog rows → builder candidates (deduped, patron excluded). */
export function candidatesFromCatalog(catalog: ResolvedCatalog): SweepCandidate[] {
  const seen = new Set<string>()
  const out: SweepCandidate[] = []
  for (const it of catalog.items) {
    if (it.hidden) continue
    // resolveCatalog already excludes the pass contract; this re-check pins
    // the product rule at the consumer too (a swept pass would enter the
    // validity ledger as a purchase), so a future census change can't leak it.
    if (it.addr === PATRON_COLLECTION_ADDRESS) continue
    // `addr` can come from an upstream inprocess row (`m.address`), not only
    // from the validated tracked set: a malformed address would throw inside
    // encodeFunctionData and abort EVERY rebuild until the row is fixed. Skip
    // the row instead — the census tolerates it the same way (it only keys by it).
    if (!isAddress(it.addr)) continue
    const rawId = String(it.m.token_id)
    // Non-decimal ids would throw in BigInt(); canonicalize the rest so the
    // member form matches /api/collect's trending keys and the hide sets.
    if (!isValidTokenId(rawId)) continue
    const tokenId = BigInt(rawId).toString()
    const key = sweepKey(it.addr, tokenId)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      address: it.addr,
      tokenId,
      creator: it.creator,
      artist: it.artist ? it.artist.toLowerCase() : null,
      // KV pin over the feed's created_at — the feed's value moves on every
      // inprocess reindex-on-edit (see lib/notifications MomentMeta.createdAt).
      createdAt: it.meta?.createdAt ?? it.m.created_at ?? null,
      ...(it.m.metadata?.name ? { name: it.m.metadata.name } : {}),
      ...(it.m.metadata?.image ? { image: it.m.metadata.image } : {}),
      ...(it.m.metadata?.kismet_thumbhash ? { thumbhash: it.m.metadata.kismet_thumbhash } : {}),
    })
  }
  return out
}

/**
 * Rebuild + persist the index from a resolved catalog. Throws on an RPC-level
 * failure (nothing is written); returns the persisted index otherwise.
 */
export async function rebuildSweepIndex(catalog: ResolvedCatalog): Promise<SweepIndex> {
  const client = serverBaseClient()
  const candidates = candidatesFromCatalog(catalog)
  const now = await chainNow(client)

  // Pass 1 — sale rows for every candidate; keep only live + paid.
  const sales = new Map<string, SweepSaleRow>()
  for (const part of chunk(candidates, PASS1_CHUNK)) {
    const res = await aggregate3Strict(
      client,
      part.map((c) => ({
        target: ZORA_FIXED_PRICE_STRATEGY,
        callData: encodeFunctionData({
          abi: FPSS_SALE_ABI,
          functionName: 'sale',
          args: [c.address as Address, BigInt(c.tokenId)],
        }),
      })),
    )
    res.forEach((r, i) => {
      if (!r.success) return
      let sale: SweepSaleRow
      try {
        sale = decodeFunctionResult({ abi: FPSS_SALE_ABI, functionName: 'sale', data: r.returnData })
      } catch {
        return
      }
      if (isLivePaidSale(sale, now)) sales.set(sweepKey(part[i].address, part[i].tokenId), sale)
    })
  }
  const survivors = candidates.filter((c) => sales.has(sweepKey(c.address, c.tokenId)))

  // Pass 2 — supply for survivors (a reverting row = unreadable = open) + fees.
  const supply = new Map<string, SweepSupplyRow>()
  for (const part of chunk(survivors, PASS2_CHUNK)) {
    const res = await aggregate3Strict(
      client,
      part.map((c) => ({
        target: c.address as Address,
        callData: encodeFunctionData({
          abi: ZORA_1155_TOKEN_INFO_ABI,
          functionName: 'getTokenInfo',
          args: [BigInt(c.tokenId)],
        }),
      })),
    )
    res.forEach((r, i) => {
      if (!r.success) return
      try {
        const info = decodeFunctionResult({
          abi: ZORA_1155_TOKEN_INFO_ABI,
          functionName: 'getTokenInfo',
          data: r.returnData,
        })
        supply.set(sweepKey(part[i].address, part[i].tokenId), {
          maxSupply: info.maxSupply,
          totalMinted: info.totalMinted,
        })
      } catch {
        // malformed row → treated as unreadable (open) below
      }
    })
  }
  const fees = await readMintFeesWithBound(
    client,
    [...new Set(survivors.map((c) => c.address))] as Address[],
  )

  const items: SweepIndexItem[] = []
  for (const c of survivors) {
    const key = sweepKey(c.address, c.tokenId)
    const item = buildSweepItem(c, sales.get(key), supply.get(key) ?? null, fees.get(c.address), now)
    if (item) items.push(item)
  }
  const index = finalizeSweepIndex(items, Date.now())
  // Loud on failure (throw → the cron records it): a swallowed write would
  // silently serve a stale pool for an hour with nothing in the logs.
  await redis.set(SWEEP_INDEX_KEY, index)
  return index
}

/** The persisted index, or null before the first successful build / on a Redis
 *  blip — callers serve "nothing to sweep" rather than a fake pool. */
export async function getSweepIndex(): Promise<SweepIndex | null> {
  try {
    const raw = await redis.get<SweepIndex | string | null>(SWEEP_INDEX_KEY)
    if (!raw) return null
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as SweepIndex) : raw
    return typeof parsed?.updatedAt === 'number' && Array.isArray(parsed.items) ? parsed : null
  } catch {
    return null
  }
}

// Feature flag. Memoized 60 s (a public, edge-cached endpoint reads it on
// every miss); memoize never caches a rejection, so a Redis failure propagates
// to the caller, which fails CLOSED (feature off) — the sweep is an optional
// surface, and "off during a blip" is the safe degradation. setSweepEnabled
// invalidates own-pod immediately (single instance → no cross-pod lag).
async function _isSweepEnabled(): Promise<boolean> {
  const raw = await redis.get<string | number | null>(SWEEP_ENABLED_KEY)
  return isFlagSet(raw)
}
export const isSweepEnabled = memoize(_isSweepEnabled, 60_000)

export async function setSweepEnabled(enabled: boolean): Promise<void> {
  if (enabled) await redis.set(SWEEP_ENABLED_KEY, '1')
  else await redis.del(SWEEP_ENABLED_KEY)
  isSweepEnabled.invalidate()
}
