import { parseAbi, formatEther, formatUnits } from 'viem'
import { redis } from './redis'
import { serverBaseClient } from './rpc'
import { getEthUsd } from './ethPrice'
import { isAddress } from './address'
import { getRecipientSplits, type RecipientSplit } from './splits'
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
  /** Blended USD (eth × price + usdc); falls back to USDC-only if price is down. */
  usd: number
  /** How many split moments currently hold a non-zero share for the artist. */
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

// Bound the per-profile fan-out. An artist past this many split moments is
// vanishingly rare; the tail is dropped rather than ballooning the multicall.
const MAX_MOMENTS = 100
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

// Bound the on-chain work so a slow RPC can't stall the owner's stats response
// (this runs in Promise.all with the earnings read). Mirrors getEthUsd's race.
const COMPUTE_TIMEOUT_MS = 4000

// Process-local 60s cache (owner-only surface, viewed infrequently) so reloads
// don't re-hit the RPC. memoize() is arg-less, so this is keyed per address.
const cache = new Map<string, { value: ArtistPending; expiresAt: number }>()
const TTL_MS = 60_000

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

async function compute(address: string): Promise<ArtistPending> {
  const moments = (await getRecipientSplits(address)).slice(0, MAX_MOMENTS)
  if (!moments.length) return EMPTY

  const addrs = await resolveSplitAddresses(moments)
  const resolved = moments
    .map((m, i) => ({ pct: m.pct, addr: addrs[i] }))
    .filter((x): x is { pct: number; addr: string } => !!x.addr)
  if (!resolved.length) return EMPTY

  // One aggregate3: native + USDC balance for every split. Reading both (rather
  // than tracking each moment's currency) keeps the index currency-agnostic —
  // the irrelevant balance is simply 0.
  const balances = await serverBaseClient().multicall({
    contracts: resolved.flatMap((r) => [
      {
        address: MULTICALL3_ADDRESS,
        abi: MULTICALL3_BALANCE_ABI,
        functionName: 'getEthBalance' as const,
        args: [r.addr as `0x${string}`] as const,
      },
      {
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: 'balanceOf' as const,
        args: [r.addr as `0x${string}`] as const,
      },
    ]),
  })

  let ethWei = 0n
  let usdcBase = 0n
  let count = 0
  resolved.forEach((r, idx) => {
    const ethRes = balances[idx * 2]
    const usdcRes = balances[idx * 2 + 1]
    const pct = BigInt(Math.max(0, Math.min(100, Math.round(r.pct))))
    let had = false
    if (ethRes?.status === 'success') {
      const share = ((ethRes.result as bigint) * pct) / 100n
      if (share > 0n) {
        ethWei += share
        had = true
      }
    }
    if (usdcRes?.status === 'success') {
      const share = ((usdcRes.result as bigint) * pct) / 100n
      if (share > 0n) {
        usdcBase += share
        had = true
      }
    }
    if (had) count++
  })

  if (ethWei === 0n && usdcBase === 0n) return EMPTY

  const ethUsd = await getEthUsd()
  const eth = Number(formatEther(ethWei))
  const usdc = Number(formatUnits(usdcBase, 6))
  return { eth, usdc, usd: eth * (ethUsd ?? 0) + usdc, count }
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
 * than breaking the stats response.
 */
export async function getArtistPending(address: string): Promise<ArtistPending> {
  const key = address.toLowerCase()
  const hit = cache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value
  try {
    const value = await Promise.race([
      compute(key),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('pending timeout')), COMPUTE_TIMEOUT_MS),
      ),
    ])
    // Bound the map so a long-lived pod can't accumulate one entry per artist
    // ever viewed; entries are short-lived anyway, so a hard reset is fine.
    if (cache.size > 5000) cache.clear()
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS })
    return value
  } catch {
    return EMPTY
  }
}
