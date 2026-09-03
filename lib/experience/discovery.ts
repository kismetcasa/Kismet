import 'server-only'
import { parseAbiItem, type Address } from 'viem'
import { serverBaseClient } from '../rpc'
import { redis } from '../redis'

/**
 * Find a player's capsule mints on-chain — the recovery path for capsules
 * minted OUTSIDE this app.
 *
 * ── Why this is an indexing read and not new infrastructure ──
 *
 * The capsule is a plain Zora 1155, so anyone can mint it through any
 * Zora-compatible frontend, and a capsule minted on zora.co never passes
 * through our UI — the one place that records the transaction hash the play
 * route needs. But the hash was never actually lost: every mint emits
 * `TransferSingle(operator, 0x0 → player, id, value)` on the capsule
 * collection, and `from` and `to` are both INDEXED topics. One eth_getLogs
 * call filtered to (this collection, from = zero, to = this player) returns
 * exactly that player's mints — a handful of rows — with the transaction hash
 * and quantity on each. The chain is already the index.
 *
 * ── Why the scan is cheap enough to run on demand ──
 *
 * Three bounds stack:
 *   1. The topic filter is maximally selective — one collection, one
 *      recipient, genesis-only — so the RESULT set is tiny regardless of range.
 *   2. `fromBlock` is the machine's publish block (Machine.createdBlock):
 *      capsules cannot be minted before the machine existed, so the range is
 *      the season, not history. Legacy machines without the field fall back to
 *      a fixed lookback.
 *   3. Results are cached in Redis for a short TTL, so a page mount does not
 *      re-scan.
 * This runs on the configured paid RPC (lib/rpc), the same endpoint
 * lib/collections.findLandedDeploy already trusts for the identical query
 * shape. On any failure it returns [] — the machine page's paste-a-hash input
 * is the always-available manual fallback, so a degraded scan degrades UX,
 * never correctness.
 *
 * ── Why NOT a webhook, and NOT a contract ──
 *
 * The Alchemy activity webhook (the pass-transfer pattern) would push these
 * rows to us live, but it needs a per-collection registration at machine
 * publish — an ops dependency that can silently lapse — and it cannot see
 * mints that happened before it was registered, which is exactly the window a
 * recovery path exists for. The on-demand read has neither problem and costs
 * one cached RPC call per player-visit. A custom contract adds nothing at
 * all: it cannot add information TransferSingle does not already carry, and
 * players minting through other frontends would never call it.
 */

const TRANSFER_SINGLE = parseAbiItem(
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
)

const ZERO = '0x0000000000000000000000000000000000000000' as const

/** Fallback scan window for machines published before `createdBlock` was
 *  recorded: ~14 days of ~2s Base blocks. Wide enough for any live season this
 *  applies to; anything older is reachable through paste-a-hash. */
const FALLBACK_LOOKBACK_BLOCKS = 605_000n

/** Cache TTL. Discovery is the recovery net, not the primary path — a capsule
 *  minted through our own UI is opened immediately and never needs it — so a
 *  short staleness window buys a large reduction in log queries. */
const CACHE_TTL_SECONDS = 30

/** Per-log unit clamp, same rule as lib/verifyMint and
 *  lib/passTaint.aggregateMintUnits: a matched log is at least one unit, and a
 *  pathological value cannot inflate a count. */
function clampUnits(value: bigint): number {
  return value > 0n && value < 1_000_000n ? Number(value) : 1
}

export interface CapsuleMint {
  txHash: string
  units: number
  blockNumber: number
}

interface MintLogRow {
  transactionHash: string | null
  blockNumber: bigint | null
  from: string
  to: string
  id: bigint
  value: bigint
}

/**
 * Group raw TransferSingle rows into per-transaction capsule mints. PURE — the
 * oracle drives every branch directly.
 *
 * Defensive re-filtering is deliberate: the getLogs topics already constrain
 * `from` and `to`, but this function must be correct for ANY caller, and the
 * tokenId cannot be topic-filtered at all (it lives in the data), so the
 * decode-side filter is the only thing keeping a different edition on the same
 * collection out of the result.
 */
export function groupCapsuleMints(
  rows: MintLogRow[],
  tokenId: string,
  account: string,
): CapsuleMint[] {
  const wanted = BigInt(tokenId)
  const player = account.toLowerCase()
  const byTx = new Map<string, CapsuleMint>()

  for (const r of rows) {
    if (!r.transactionHash) continue
    if (r.from.toLowerCase() !== ZERO) continue
    if (r.to.toLowerCase() !== player) continue
    if (r.id !== wanted) continue
    const tx = r.transactionHash.toLowerCase()
    const prev = byTx.get(tx)
    const units = clampUnits(r.value)
    if (prev) prev.units += units
    else byTx.set(tx, { txHash: tx, units, blockNumber: Number(r.blockNumber ?? 0n) })
  }

  // Newest first: the capsule a player is looking for is almost always the one
  // they just minted.
  return [...byTx.values()].sort((a, b) => b.blockNumber - a.blockNumber)
}

/**
 * The on-chain read, cached. Returns every capsule mint of (collection,
 * tokenId) to `account` since `fromBlock`. Never throws; [] on any failure.
 */
export async function discoverCapsuleMints(params: {
  collection: string
  tokenId: string
  account: string
  createdBlock?: number
}): Promise<CapsuleMint[]> {
  const account = params.account.toLowerCase()
  const collection = params.collection.toLowerCase()
  const cacheKey = `kismetart:xp:discover:${collection}:${params.tokenId}:${account}`

  const cached = await redis.get<CapsuleMint[] | string>(cacheKey).catch(() => null)
  if (cached) {
    try {
      const rows = typeof cached === 'string' ? (JSON.parse(cached) as CapsuleMint[]) : cached
      if (Array.isArray(rows)) return rows
    } catch {
      // fall through to a fresh read
    }
  }

  try {
    const client = serverBaseClient()
    const head = await client.getBlockNumber()
    const fromBlock =
      params.createdBlock && params.createdBlock > 0
        ? BigInt(params.createdBlock)
        : head > FALLBACK_LOOKBACK_BLOCKS
          ? head - FALLBACK_LOOKBACK_BLOCKS
          : 0n

    const logs = await client.getLogs({
      address: collection as Address,
      event: TRANSFER_SINGLE,
      args: { from: ZERO, to: account as Address },
      fromBlock,
      toBlock: 'latest',
    })

    const mints = groupCapsuleMints(
      logs.map((l) => ({
        transactionHash: l.transactionHash,
        blockNumber: l.blockNumber,
        from: l.args.from ?? '',
        to: l.args.to ?? '',
        id: l.args.id ?? -1n,
        value: l.args.value ?? 0n,
      })),
      params.tokenId,
      account,
    )

    await redis.set(cacheKey, JSON.stringify(mints), { ex: CACHE_TTL_SECONDS }).catch(() => {})
    return mints
  } catch {
    // Range cap, rate limit, or outage. The paste-a-hash path still works, so
    // degrade silently rather than surface an error on a recovery net.
    return []
  }
}
