import 'server-only'
import { decodeEventLog, parseAbi, type Hex } from 'viem'
import { redis } from './redis'
import { serverBaseClient } from './rpc'

/**
 * The shared on-chain mint proof, for the question "was THIS account minted
 * THIS token in THIS transaction".
 *
 * ── What was actually extracted, and what deliberately was not ──
 *
 * Three routes decode TransferSingle with their own loop: /api/collect,
 * /api/airdrop/notify (verifyAirdropOnChain) and /api/admin/airdrop-record.
 * Only the FIRST is extracted here, because only the first asks this question.
 * The airdrop pair are scoped to a sender and verify a SET of recipients in one
 * transaction, returning per-recipient counts; collapsing them into this
 * signature would widen its contract to serve callers it does not have. They
 * keep their own loops on purpose — this is one proof with two callers, not a
 * decoding utility.
 *
 * The extraction earns its place because the Experience is the second caller:
 * /api/experience/play must prove a capsule mint under exactly these rules
 * before it will dispense an artwork. A copy there would have put the path that
 * RECORDS a payment and the path that PAYS ONE OUT on separately drifting
 * implementations of the same security check.
 *
 * The proof answers exactly one question: does this receipt show a GENESIS mint
 * (from == 0x0) of `tokenId` on `collection`, and to whom, in what quantity.
 * Fail-closed on every ambiguity — RPC error, decode failure, reverted receipt,
 * or no matching log all return ok:false.
 *
 * ── Behaviours preserved verbatim from the original, each load-bearing ──
 *
 *  • The matching log MUST originate from `collection`. Without it, a caller
 *    could pass a txHash whose only TransferSingle is on an unrelated 1155 and
 *    have it accepted as proof.
 *  • A reverted receipt caches a NEGATIVE verdict; an RPC failure caches
 *    nothing, because it is transient and caching it would turn a blip into a
 *    five-minute denial.
 *  • The cache value uses the non-numeric `1:<payer>:<units>` form. This is not
 *    cosmetic: Upstash stores '1' unchanged but JSON-PARSES it back as the
 *    NUMBER 1 on read, so an earlier `cached === '1'` comparison never matched
 *    and the cache never hit — every verified collect re-fetched its receipt.
 *    The same dual-representation trap lib/gateFlags.isFlagSet guards against.
 *  • Legacy '1' and '0' entries written before the payer/units form still parse.
 *
 * ── One deliberate improvement over the collect route's original ──
 *
 *  The original returned on the FIRST matching log. This sums ALL matching
 *  logs, which is what /api/airdrop/notify already does via
 *  lib/passTaint.aggregateMintUnits. For a normal mint the two are identical —
 *  ERC-1155 `_mint` emits ONE TransferSingle carrying the full quantity — so
 *  this changes nothing in practice. Where they differ (several matching logs
 *  in one transaction) the sum is strictly more correct: it reflects what the
 *  recipient actually received, which is what a policy denial should be sized
 *  by and what a multi-unit capsule owes draws for.
 */

const ERC1155_TRANSFER_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
])

const ZERO = '0x0000000000000000000000000000000000000000'

/** Verdict cache TTL. Short: it exists so an atomic bundle whose N records
 *  share one txHash hits RPC once, not to persist a judgement. */
const VERIFY_CACHE_TTL_SECONDS = 300

/** Per-log unit clamp, matching lib/passTaint.aggregateMintUnits exactly: a
 *  zero or pathological value reads as 1 (the log matched a real mint, so at
 *  least one unit moved) and an absurd value cannot inflate a count. */
function clampUnits(value: bigint): number {
  return value > 0n && value < 1_000_000n ? Number(value) : 1
}

export interface MintProofOk {
  ok: true
  /** receipt.from, lowercased. On ERC-4337 this is the BUNDLER, not the payer —
   *  callers must never derive ownership from it. The recipient proved by the
   *  log is the only authority on who received the mint. */
  from: string
  /** Summed on-chain units minted to `account` for this (collection, tokenId). */
  units: number
}
export type MintProof = { ok: false } | MintProofOk

/**
 * Prove that `account` was minted `tokenId` of `collection` in `txHash`.
 *
 * `collection` and `account` must already be lowercased, and `tokenId` must be
 * BigInt-canonical (base-10, no leading zeros). Canonicalisation is the
 * caller's job because the caller also uses that same string in its Redis keys:
 * accepting '01' here while keying on the literal would let a legitimate mint of
 * token 1 be replayed as '01', '001', … past a per-tuple idempotency gate.
 */
export async function verifyMintOnChain(
  txHash: Hex,
  collection: string,
  tokenId: string,
  account: string,
): Promise<MintProof> {
  const cacheKey = `verify:collect:${txHash}:${collection}:${tokenId}:${account}`
  const cached = await redis.get<string | number>(cacheKey).catch(() => null)
  const cachedStr = cached == null ? null : String(cached)
  if (cachedStr === '0') return { ok: false }
  // Legacy '1' — verified, payer and quantity unknown. Costs an unproven gift
  // claim its attribution, and makes a denial mark the minimum 1 unit, for one
  // TTL window after deploy.
  if (cachedStr === '1') return { ok: true, from: '', units: 1 }
  if (cachedStr?.startsWith('1:')) {
    const [, payer = '', units = '1'] = cachedStr.split(':')
    return { ok: true, from: payer, units: Math.max(1, parseInt(units, 10) || 1) }
  }

  try {
    const receipt = await serverBaseClient().getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      await redis.set(cacheKey, '0', { ex: VERIFY_CACHE_TTL_SECONDS }).catch(() => {})
      return { ok: false }
    }
    const payer = receipt.from.toLowerCase()
    const expectedTokenId = BigInt(tokenId)

    let units = 0
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== collection) continue
      let decoded
      try {
        decoded = decodeEventLog({
          abi: ERC1155_TRANSFER_ABI,
          data: log.data,
          topics: log.topics,
        })
      } catch {
        continue
      }
      const { from, to, id, value } = decoded.args
      if (from === ZERO && to.toLowerCase() === account && id === expectedTokenId) {
        units += clampUnits(value)
      }
    }

    if (units > 0) {
      await redis
        .set(cacheKey, `1:${payer}:${units}`, { ex: VERIFY_CACHE_TTL_SECONDS })
        .catch(() => {})
      return { ok: true, from: payer, units }
    }

    await redis.set(cacheKey, '0', { ex: VERIFY_CACHE_TTL_SECONDS }).catch(() => {})
    return { ok: false }
  } catch {
    // RPC failure: transient, so don't cache a verdict we can't stand behind.
    return { ok: false }
  }
}
