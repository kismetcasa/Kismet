import { redis } from './redis'
import { serverBaseClient } from './rpc'

// Chainlink ETH/USD on Base — the only price input, for the USD earnings view.
// Cached 60s. Override the feed address via env if it ever moves.
const FEED = (process.env.CHAINLINK_ETH_USD_FEED ??
  '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70') as `0x${string}`
const CACHE_KEY = 'kismetart:ethusd'
// Freshness ceiling on the feed's answer. The feed heartbeats every few
// minutes; an answer older than this means the feed is halted, and pricing
// with it would silently FREEZE every USD figure at the stale answer.
// Returning null instead routes callers to the shared honest-USD rule
// (usd=0 when an ETH leg exists and no price is available).
const MAX_ANSWER_AGE_S = 2 * 60 * 60
const ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const

/** ETH price in USD (8-dp Chainlink answer), or null if unavailable. Cached 60s. */
export async function getEthUsd(): Promise<number | null> {
  try {
    const cached = await redis.get<number>(CACHE_KEY)
    if (typeof cached === 'number' && cached > 0) return cached
    // Bound the on-chain read so a slow/hanging RPC can't stall callers on the
    // hot profile path (viem's default timeout + retries can run tens of secs).
    const data = (await Promise.race([
      serverBaseClient().readContract({ address: FEED, abi: ABI, functionName: 'latestRoundData' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('ethusd timeout')), 2500)),
    ])) as readonly [bigint, bigint, bigint, bigint, bigint]
    // data[3] = updatedAt (seconds) — reject a stale round, see MAX_ANSWER_AGE_S.
    const answeredAt = Number(data[3])
    if (!Number.isFinite(answeredAt) || Date.now() / 1000 - answeredAt > MAX_ANSWER_AGE_S) {
      return null
    }
    const price = Number(data[1]) / 1e8
    if (!Number.isFinite(price) || price <= 0) return null
    await redis.set(CACHE_KEY, price, { ex: 60 }).catch(() => {})
    return price
  } catch {
    return null
  }
}
