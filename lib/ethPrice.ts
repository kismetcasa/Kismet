import { redis } from './redis'
import { serverBaseClient } from './rpc'

// Chainlink ETH/USD on Base — the only price input, for the USD earnings view.
// Cached 60s. Override the feed address via env if it ever moves.
const FEED = (process.env.CHAINLINK_ETH_USD_FEED ??
  '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70') as `0x${string}`
const CACHE_KEY = 'kismetart:ethusd'
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
    const price = Number(data[1]) / 1e8
    if (!Number.isFinite(price) || price <= 0) return null
    await redis.set(CACHE_KEY, price, { ex: 60 }).catch(() => {})
    return price
  } catch {
    return null
  }
}
