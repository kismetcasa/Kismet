import { redis } from './redis'
import { serverBaseClient } from './rpc'

// Cached ETH/USD spot price for the "USD" earnings lens. The ONLY place the
// stats system touches a price — native ETH/USDC totals are the stable truth;
// USD is derived from this at read time and is explicitly a current-market-value
// view, so its drift is expected and isolated here.
//
// Source: Chainlink ETH/USD aggregator on Base (on-chain, free, no external
// API or extra egress — the app already talks to Base RPC everywhere). USD
// pairs report 8 decimals via latestRoundData().answer.
//
// VERIFY the proxy address against Chainlink's Base docs (data.chain.link) on
// deploy; env-overridable so it can be corrected without a code change.
const CHAINLINK_ETH_USD_BASE =
  process.env.CHAINLINK_ETH_USD_FEED ?? '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70'

const AGGREGATOR_ABI = [
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

const CACHE_KEY = 'kismetart:ethusd'
const LAST_KEY = 'kismetart:ethusd:last'
const CACHE_TTL_SECONDS = 60

/**
 * Current ETH price in USD, or null only if we have never once read it (cold
 * cache + RPC down on the very first call). A short-TTL cache absorbs bursts;
 * a TTL-less `:last` key is a durable fallback so a transient RPC blip degrades
 * to a slightly stale price rather than no price. Best-effort — never throws.
 */
export async function getEthUsd(): Promise<number | null> {
  try {
    const cached = await redis.get<number>(CACHE_KEY)
    if (typeof cached === 'number' && cached > 0) return cached
  } catch {
    // fall through to a fresh read
  }

  try {
    const data = (await serverBaseClient().readContract({
      address: CHAINLINK_ETH_USD_BASE as `0x${string}`,
      abi: AGGREGATOR_ABI,
      functionName: 'latestRoundData',
    })) as readonly [bigint, bigint, bigint, bigint, bigint]
    const price = Number(data[1]) / 1e8
    if (Number.isFinite(price) && price > 0) {
      // Set the short-TTL cache and refresh the durable fallback together.
      await Promise.all([
        redis.set(CACHE_KEY, price, { ex: CACHE_TTL_SECONDS }),
        redis.set(LAST_KEY, price),
      ]).catch(() => {})
      return price
    }
  } catch {
    // RPC / decode failure — fall back to the last good value below.
  }

  try {
    const last = await redis.get<number>(LAST_KEY)
    if (typeof last === 'number' && last > 0) return last
  } catch {
    // nothing cached yet
  }
  return null
}
