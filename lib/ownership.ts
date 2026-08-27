import 'server-only'
import { serverBaseClient } from './rpc'

/**
 * Live on-chain edition-ownership reads, lifted from lib/raffle.ts so the
 * collector-file gate and the raffle eligibility draw share one primitive
 * (COLLECTOR_DOWNLOADS_DESIGN.md §5.1). Provenance-agnostic raw balanceOf —
 * NOT hasValidPass — because both callers only care that the wallet holds
 * the edition, however it was acquired (secondary buys included; the
 * event-sourced collected ledger misses exactly those, lib/collected.ts).
 */

const norm = (s: string) => s.toLowerCase()

const BALANCE_OF_ABI = [
  {
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    name: 'balanceOf',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const BALANCE_OF_BATCH_ABI = [
  {
    inputs: [{ type: 'address[]' }, { type: 'uint256[]' }],
    name: 'balanceOfBatch',
    outputs: [{ type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/** Live on-chain check: does `address` hold ≥1 of (collection, tokenId)?
 *  Fails closed. */
export async function holdsEdition(
  collection: string,
  tokenId: string,
  address: string,
): Promise<boolean> {
  try {
    const bal = (await serverBaseClient().readContract({
      address: collection as `0x${string}`,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [address as `0x${string}`, BigInt(tokenId)],
    })) as bigint
    return bal > 0n
  } catch {
    return false
  }
}

// balanceOfBatch chunk size. 200 addresses ≈ 200 SLOADs + ~13KB calldata per
// call — far inside node limits — and chunks fan out concurrently.
const HOLDS_BATCH_CHUNK = 200

/**
 * Chunked balanceOfBatch: lowercased address -> currently-holds. Returns
 * `null` when ANY chunk fails, so each caller picks its own failure
 * semantics explicitly:
 *   - the raffle draw maps null → nobody-eligible (abort the draw, artist
 *     retries — a partial result would draw a "winner" from the surviving
 *     chunks while silently excluding real holders);
 *   - the collector-file fanout maps null → abort WITHOUT consuming the 24h
 *     notify cooldown (an all-false result would notify nobody and burn the
 *     artist's one notify for the day — design §6.2).
 */
export async function holdsEditionBatch(
  collection: string,
  tokenId: string,
  addresses: string[],
): Promise<Record<string, boolean> | null> {
  if (addresses.length === 0) return {}
  const chunks: string[][] = []
  for (let i = 0; i < addresses.length; i += HOLDS_BATCH_CHUNK) {
    chunks.push(addresses.slice(i, i + HOLDS_BATCH_CHUNK))
  }
  try {
    const perChunk = await Promise.all(
      chunks.map(
        (chunk) =>
          serverBaseClient().readContract({
            address: collection as `0x${string}`,
            abi: BALANCE_OF_BATCH_ABI,
            functionName: 'balanceOfBatch',
            args: [
              chunk.map((a) => a as `0x${string}`),
              chunk.map(() => BigInt(tokenId)),
            ],
          }) as Promise<readonly bigint[]>,
      ),
    )
    const out: Record<string, boolean> = {}
    chunks.forEach((chunk, ci) => {
      chunk.forEach((a, i) => {
        out[norm(a)] = (perChunk[ci][i] ?? 0n) > 0n
      })
    })
    return out
  } catch {
    return null
  }
}

/** Does ANY of `wallets` hold ≥1 of the edition? One balanceOfBatch call for
 *  the typical ≤10-wallet identity union. Fails closed (null → false). */
export async function holdsAny(
  collection: string,
  tokenId: string,
  wallets: string[],
): Promise<boolean> {
  const holding = await holdsEditionBatch(collection, tokenId, wallets)
  if (holding === null) return false
  return wallets.some((w) => holding[norm(w)])
}
