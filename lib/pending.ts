import { parseAbi, formatEther, formatUnits } from 'viem'
import { redis } from './redis'
import { serverBaseClient } from './rpc'
import { getEthUsd } from './ethPrice'
import { isAddress } from './address'
import { getRecipientSplits, type RecipientSplit } from './splits'
import { expandToFidSiblings } from './addressUnion'
import { dedupeBySplitAddress, type SplitJob } from './distributePlan'
import {
  ERC20_ABI,
  USDC_BASE,
  MULTICALL3_ADDRESS,
  ZORA_CREATOR_REWARD_RECIPIENT_ABI,
} from './zoraMint'

export interface ArtistPending {
  /** Undistributed ETH owed to the artist across their splits (human units). */
  eth: number
  /** Undistributed USDC owed to the artist across their splits (human units). */
  usdc: number
  /** Blended USD (eth × price + usdc). 0 when the ETH/USD price is unavailable
   *  and there IS an ETH leg — honest-USD policy shared with getArtistEarnings;
   *  never a silently-USDC-only figure presented as the whole total. */
  usd: number
  /** How many distinct split CONTRACTS currently hold a non-zero share for the
   *  artist. Several moments can pay into one deterministic split; each pot
   *  counts once (dedupeBySplitAddress). */
  count: number
}

const EMPTY: ArtistPending = { eth: 0, usdc: 0, usd: 0, count: 0 }

// Multicall3's native-balance reader — batches ETH balances into the same
// aggregate3 as the USDC balanceOf reads, so all balances cost one round-trip.
const MULTICALL3_BALANCE_ABI = parseAbi([
  'function getEthBalance(address addr) view returns (uint256)',
])

// A token's split address is its immutable on-chain creator-reward-recipient;
// cache the resolved mapping forever so only first-seen moments pay the read.
const splitAddrKey = (collection: string, tokenId: string) =>
  `kismetart:splitaddr:${collection.toLowerCase()}:${tokenId}`

// Bound a single ad-hoc recipient read the same way getEthUsd bounds its RPC —
// viem's default timeout × retries can run tens of seconds, which is fatal on
// an awaited response path (the listings fill handler).
const RECIPIENT_READ_TIMEOUT_MS = 3000

/**
 * Single-token creator-reward-recipient, through the SAME permanent
 * kismetart:splitaddr:* cache resolveSplitAddresses maintains — so the
 * listings fill path (creditListingRoyalty's split decomposition) reuses
 * mappings the pending roll-up already paid for, and vice versa. Bounded and
 * best-effort: null on miss + RPC failure/timeout, never throws. The mapping
 * is immutable on-chain, so a cache hit is always authoritative.
 */
export async function getCachedCreatorRewardRecipient(
  collection: string,
  tokenId: string,
): Promise<string | null> {
  const key = splitAddrKey(collection, tokenId)
  const cached = await redis.get<string>(key).catch(() => null)
  if (typeof cached === 'string' && isAddress(cached)) return cached.toLowerCase()
  try {
    const r = await Promise.race([
      serverBaseClient().readContract({
        address: collection as `0x${string}`,
        abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
        functionName: 'getCreatorRewardRecipient',
        args: [BigInt(tokenId)],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('recipient read timeout')), RECIPIENT_READ_TIMEOUT_MS),
      ),
    ])
    const addr = String(r).toLowerCase()
    if (!isAddress(addr) || addr === ZERO_ADDR) return null
    await redis.set(key, addr).catch(() => {})
    return addr
  } catch {
    return null
  }
}

// Bound the per-profile fan-out. SMEMBERS order is undefined, so past this many
// split moments the *arbitrary* tail is dropped (not the lowest-balance one) —
// acceptable only because an artist with 100+ split moments is vanishingly rare.
const MAX_MOMENTS = 100
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

// Bound the on-chain work so a slow RPC can't stall the owner's stats response
// (this runs in Promise.all with the earnings read). Mirrors getEthUsd's race.
const COMPUTE_TIMEOUT_MS = 4000

// Cache the rolled-up result 60s in Redis (cross-pod), mirroring getEthUsd — the
// owner views their own profile infrequently, so this mainly spares the
// multicalls on reloads. The client auto-(de)serializes objects (lib/redis.ts)
// and the key auto-expires, so there's no unbounded map to manage.
const pendingCacheKey = (address: string) => `kismetart:pending:${address.toLowerCase()}`
const CACHE_TTL_S = 60

// Resolve each moment's split (creator-reward-recipient) address, reading the
// Redis cache first and batching cache-misses into one multicall.
async function resolveSplitAddresses(
  moments: RecipientSplit[],
): Promise<(string | undefined)[]> {
  const cached = (await redis
    .mget<(string | null)[]>(...moments.map((m) => splitAddrKey(m.collection, m.tokenId)))
    .catch(() => moments.map(() => null))) as (string | null)[]

  const out: (string | undefined)[] = moments.map((_, i) => cached[i] ?? undefined)
  const missing = moments.map((m, i) => ({ m, i })).filter(({ i }) => !out[i])
  if (!missing.length) return out

  const res = await serverBaseClient().multicall({
    contracts: missing.map(({ m }) => ({
      address: m.collection as `0x${string}`,
      abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
      functionName: 'getCreatorRewardRecipient' as const,
      args: [BigInt(m.tokenId)] as const,
    })),
  })

  await Promise.all(
    missing.map(async ({ m, i }, k) => {
      const r = res[k]
      if (r.status !== 'success') return
      const addr = String(r.result).toLowerCase()
      if (!isAddress(addr) || addr === ZERO_ADDR) return
      out[i] = addr
      await redis.set(splitAddrKey(m.collection, m.tokenId), addr).catch(() => {})
    }),
  )
  return out
}

// Merge the split memberships of an artist's wallets into one per-moment list.
// A single moment can name more than one of the artist's own wallets as payees
// (they split their take across wallets), so their share of that moment is the
// SUM of those wallets' percents — deduping by moment, as a single-wallet read
// does, would silently drop the others. Clamped to a whole 1–100 to preserve the
// invariant the downstream BigInt share math relies on (a moment's allocations
// sum to 100 across ALL recipients, so an artist's own portion can't legitimately
// exceed it; the clamp just guards corrupt data).
function mergeSplitsByMoment(perWallet: RecipientSplit[][]): RecipientSplit[] {
  const byMoment = new Map<string, RecipientSplit>()
  for (const splits of perWallet) {
    for (const s of splits) {
      const k = `${s.collection}:${s.tokenId}`
      const existing = byMoment.get(k)
      if (existing) existing.pct = Math.min(100, existing.pct + s.pct)
      else byMoment.set(k, { ...s })
    }
  }
  return [...byMoment.values()]
}

/**
 * Resolve every split the artist is a payee on — deduped to UNIQUE split
 * contracts — with each split's LIVE ETH+USDC balance and the artist's
 * allocation: the shared work-list for both the pending roll-up (compute,
 * below, which sums the artist's shares) and distribute-all (which selects the
 * top-CAP by value and fans out). Union across FC siblings; MAX_MOMENTS-capped
 * on the merged set so the on-chain fan-out stays bounded. One aggregate3
 * reads native + USDC for every split (the irrelevant balance is simply 0,
 * keeping the index currency-agnostic). Returns [] when the artist is on no
 * splits or none resolve.
 */
export async function resolveArtistSplitJobs(
  address: string,
  wallets?: string[],
): Promise<SplitJob[]> {
  const ws = wallets ?? (await expandToFidSiblings(address))
  const perWallet = await Promise.all(ws.map((w) => getRecipientSplits(w)))
  const moments = mergeSplitsByMoment(perWallet).slice(0, MAX_MOMENTS)
  if (!moments.length) return []

  // Collapse onto unique split contracts BEFORE the balance read: 0xSplits
  // addresses are deterministic, so several moments (even across collections)
  // can pay into ONE shared pot, and a per-moment job list both re-reads the
  // same balances and — worse — counts/distributes the same pot once per
  // moment (the N× pending inflation and duplicate distribute calls fixed
  // 2026-07-17; see dedupeBySplitAddress and ANALYTICS.md §7b). The first-seen
  // moment stays as the pot's representative (collection, tokenId).
  const addrs = await resolveSplitAddresses(moments)
  const withAddr = dedupeBySplitAddress(
    moments
      .map((m, i) => ({ m, splitAddress: addrs[i], pct: m.pct }))
      .filter((x): x is { m: RecipientSplit; splitAddress: string; pct: number } => !!x.splitAddress),
  )
  if (!withAddr.length) return []

  const balances = await serverBaseClient().multicall({
    contracts: withAddr.flatMap(({ splitAddress }) => [
      {
        address: MULTICALL3_ADDRESS,
        abi: MULTICALL3_BALANCE_ABI,
        functionName: 'getEthBalance' as const,
        args: [splitAddress as `0x${string}`] as const,
      },
      {
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: 'balanceOf' as const,
        args: [splitAddress as `0x${string}`] as const,
      },
    ]),
  })

  return withAddr.map(({ m, splitAddress, pct }, idx) => {
    const ethRes = balances[idx * 2]
    const usdcRes = balances[idx * 2 + 1]
    return {
      collection: m.collection,
      tokenId: m.tokenId,
      splitAddress,
      pct, // getRecipientSplits guarantees a whole 1–100; min across a shared group
      ethWei: ethRes?.status === 'success' ? (ethRes.result as bigint) : 0n,
      usdcBase: usdcRes?.status === 'success' ? (usdcRes.result as bigint) : 0n,
    }
  })
}

async function compute(address: string, wallets?: string[]): Promise<ArtistPending> {
  const jobs = await resolveArtistSplitJobs(address, wallets)
  if (!jobs.length) return EMPTY

  // Sum the artist's SHARE (balance × their pct) across splits. `count` is the
  // number of splits where they have a non-zero share in either currency.
  let ethWei = 0n
  let usdcBase = 0n
  let count = 0
  for (const j of jobs) {
    const pct = BigInt(j.pct)
    let had = false
    const ethShare = (j.ethWei * pct) / 100n
    if (ethShare > 0n) {
      ethWei += ethShare
      had = true
    }
    const usdcShare = (j.usdcBase * pct) / 100n
    if (usdcShare > 0n) {
      usdcBase += usdcShare
      had = true
    }
    if (had) count++
  }

  if (ethWei === 0n && usdcBase === 0n) return EMPTY

  const ethUsd = await getEthUsd()
  const eth = Number(formatEther(ethWei))
  const usdc = Number(formatUnits(usdcBase, 6))
  // Same honest-USD policy as getArtistEarnings: when the price is down and
  // there IS an ETH leg, usd=0 (the card's rendersNonZero gate then falls back
  // to the ETH/USDC denominations) instead of a silently-USDC-only figure that
  // understates the pending total. No ETH leg → no price needed → exact.
  const usd = ethUsd == null && eth > 0 ? 0 : eth * (ethUsd ?? 0) + usdc
  return { eth, usdc, usd, count }
}

/**
 * Roll up an artist's UNDISTRIBUTED earnings — their share of the live on-chain
 * balance sitting on every split they're a recipient of. This is the settlement
 * counterpart to getArtistEarnings (lifetime gross attributed from sales): it
 * answers "how much have I earned that hasn't reached a wallet yet."
 *
 * Read from chain because no upstream feed exposes undistributed balances, and
 * never persisted — distribution is permissionless (it can happen outside our
 * /api/distribute), so any stored ledger would silently drift. Owner-only by
 * construction at the call site. Best-effort: any failure yields zeros rather
 * than breaking the stats response. Unioned across the artist's FC sibling
 * wallets to match getArtistEarnings; pass `wallets` to reuse a set the caller
 * already resolved (the cache key stays the canonical address either way).
 */
/** Bust the cached pending roll-up so a read right after a distribution reflects
 *  the drained balances instead of the stale 60s cache. Busts the signer's
 *  WHOLE FC-sibling set, not just their key: /api/stats caches under the PROFILE
 *  address, which may be a different verified wallet of the same FID than the
 *  one that signed — expanding the siblings guarantees that key is included.
 *  Falls back to the signer's own key if the sibling lookup fails. Best-effort. */
export async function invalidatePendingCache(address: string): Promise<void> {
  try {
    const wallets = await expandToFidSiblings(address.toLowerCase())
    await Promise.all(wallets.map((w) => redis.del(pendingCacheKey(w)).catch(() => {})))
  } catch {
    await redis.del(pendingCacheKey(address.toLowerCase())).catch(() => {})
  }
}

export async function getArtistPending(address: string, wallets?: string[]): Promise<ArtistPending> {
  const key = address.toLowerCase()
  const cacheKey = pendingCacheKey(key)
  const cached = await redis.get<ArtistPending>(cacheKey).catch(() => null)
  if (cached && typeof cached.usd === 'number' && typeof cached.count === 'number') {
    return cached
  }
  try {
    const value = await Promise.race([
      compute(key, wallets),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('pending timeout')), COMPUTE_TIMEOUT_MS),
      ),
    ])
    // Cache the fresh roll-up (including a zero result) for the TTL. A timeout or
    // throw falls through to the catch and is NOT cached, so the next call
    // retries rather than pinning zeros — same policy as getEthUsd.
    await redis.set(cacheKey, value, { ex: CACHE_TTL_S }).catch(() => {})
    return value
  } catch {
    return EMPTY
  }
}
