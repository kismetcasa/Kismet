import 'server-only'
import type { Address } from 'viem'
import { serverBaseClient } from '../rpc'
import { hasAdminBit, hasMinterBit, readPermissions } from '../permissions'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '../zoraMint'

/**
 * The live on-chain authority check for a single drawn prize.
 *
 * ── Why this runs on ONE piece and not the whole pool ──
 *
 * `serverBaseClient()` is a bare `http()` transport with NO multicall batching
 * (unlike the wagmi client, which sets `batch: { multicall: true }`). Verifying
 * a whole pool live would therefore be two sequential eth_calls per entry —
 * ~24 round trips for a twelve-piece machine — inside the few seconds a player
 * is watching a capsule open, on an action they have already paid for.
 *
 * So eligibility is two-tier: the FREEZE filters on cached state (the hidden
 * cascade, which already fails closed, plus a swept grant flag), and this
 * function is the authoritative gate applied to the single piece actually
 * drawn. That ordering is what makes a stale cache harmless — the worst it can
 * cause is one extra redraw, never an unauthorised mint, because delivery is
 * gated here rather than at freeze.
 */

export type AuthorityFailure =
  | 'no-grant'      // operator holds neither MINTER nor ADMIN on this token
  | 'minted-out'    // the edition's on-chain cap is exhausted
  | 'unreadable'    // RPC could not answer — fail closed, redraw

export interface AuthorityResult {
  ok: boolean
  reason?: AuthorityFailure
  /** Which configured operator address holds the grant, so delivery signs with
   *  the one that actually works (see OPERATOR_ADDRESSES below). */
  operator?: string
}

/**
 * Operator addresses, in preference order.
 *
 * A single address is a rotation hazard: every artist grant names one specific
 * operator, so re-keying would silently invalidate the entire catalogue of
 * grants at once. Supporting an ordered set turns rotation into a gradual,
 * non-breaking migration — the check passes if ANY configured operator holds
 * the grant, delivery signs with that one, and artists re-grant to the new
 * address at their own pace.
 *
 * The baseline is stable regardless: the CDP smart account is resolved BY NAME
 * (`getOrCreateSmartAccount({ name })`), so its address survives restarts and
 * rotation is a deliberate act rather than an accident.
 */
export function operatorAddresses(): string[] {
  const raw = process.env.EXPERIENCE_OPERATOR_ADDRESSES ?? process.env.NEXT_PUBLIC_OPERATOR_SMART_WALLET ?? ''
  return raw
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
}

/**
 * Can we mint this exact piece to a winner, right now?
 *
 * Checks both halves, because either alone is insufficient:
 *   1. an operator must still hold MINTER (or ADMIN — Zora's `adminMint` ORs
 *      the tokenId-0 row, so a collection-wide ADMIN also authorises it);
 *   2. the edition must not be minted out — and the cap comparison uses
 *      `totalMinted`, NOT `totalSupply`, because Zora's own `mint()` compares
 *      against the former and `totalSupply` DECREASES on burn, so a burned
 *      edition would otherwise look mintable and revert delivery.
 *
 * Fails closed on an unreadable RPC: a redraw costs a player nothing, while
 * proceeding on an unknown would risk a reverted delivery on a paid play.
 */
export async function checkPrizeAuthority(params: {
  collection: string
  tokenId: string
}): Promise<AuthorityResult> {
  const operators = operatorAddresses()
  if (operators.length === 0) return { ok: false, reason: 'no-grant' }

  const client = serverBaseClient()
  const collection = params.collection as Address
  const tokenId = BigInt(params.tokenId)

  // 1. supply headroom
  try {
    const info = (await client.readContract({
      address: collection,
      abi: ZORA_1155_TOKEN_INFO_ABI,
      functionName: 'getTokenInfo',
      args: [tokenId],
    })) as { maxSupply: bigint; totalMinted: bigint }
    if (!isOpenEdition(info.maxSupply) && info.totalMinted >= info.maxSupply) {
      return { ok: false, reason: 'minted-out' }
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }

  // 2. grant — first operator that holds it wins, and is returned so the
  //    delivery signs with an address that will actually pass adminMint's gate.
  for (const op of operators) {
    try {
      // retries:1 — this sits inside a live reveal, and readPermissions' default
      // four attempts with linear backoff would add seconds. A transient miss
      // costs a redraw, which is cheap; a slow reveal is the thing we cannot pay.
      const perms = await readPermissions(client, collection, tokenId, op as Address, { retries: 1 })
      if (hasMinterBit(perms) || hasAdminBit(perms)) return { ok: true, operator: op }
    } catch {
      continue
    }
  }
  return { ok: false, reason: 'no-grant' }
}

/** Capsule supply state, read at publish to fix the machine's liability ceiling
 *  and again for the public coverage figure. `maxSupply: null` means open. */
export async function readCapsuleSupply(
  collection: string,
  tokenId: string,
): Promise<{ maxSupply: number | null; minted: number } | null> {
  try {
    const info = (await serverBaseClient().readContract({
      address: collection as Address,
      abi: ZORA_1155_TOKEN_INFO_ABI,
      functionName: 'getTokenInfo',
      args: [BigInt(tokenId)],
    })) as { maxSupply: bigint; totalMinted: bigint }
    return {
      maxSupply: isOpenEdition(info.maxSupply) ? null : Number(info.maxSupply),
      minted: Number(info.totalMinted),
    }
  } catch {
    return null
  }
}

/** Remaining mintable copies of an edition — the headroom a pool entry's pledge
 *  is validated against at publish. null = unlimited. */
export async function readHeadroom(collection: string, tokenId: string): Promise<number | null | undefined> {
  const s = await readCapsuleSupply(collection, tokenId)
  if (!s) return undefined // unreadable: caller skips the check rather than blocking a publish on a blip
  return s.maxSupply === null ? null : Math.max(0, s.maxSupply - s.minted)
}
