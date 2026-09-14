import 'server-only'
import type { Address } from 'viem'
import { serverBaseClient } from '../rpc'
import { PERMISSION_BIT_SALES, hasAdminBit, hasMinterBit, readPermissions } from '../permissions'
import { resolveOnchainSale } from '../saleConfig'
import { ZORA_1155_TOKEN_INFO_ABI, ZORA_ERC20_MINTER, isOpenEdition } from '../zoraMint'

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

/**
 * Is this creator actually in control of the capsule they are building a machine
 * on, and does that capsule actually charge for a play?
 *
 * Two questions, one read pass, because they fail for the same reason: a machine
 * pointed at a token its creator has no relationship with. Publishing had no
 * constraint on the capsule beyond it being readable, which let a creator aim a
 * machine at ANY Zora 1155 on Base. Two things then go wrong at once:
 *
 *   - lib/experience/payees resolves that token's payees by asking what Kismet
 *     recorded at ITS mint. For a foreign token Kismet recorded nothing, so it
 *     answers "no split, the creator keeps 100%" — naming as sole payee an
 *     address that in fact receives nothing, since the price goes to the foreign
 *     token's own fundsRecipient. The machine page then publishes that
 *     fabrication as "pays 1 recipient".
 *   - Every historical holder of that token already holds a valid capsule.
 *
 * And separately from control: a capsule with no sale row, or one priced at
 * zero, dispenses other artists' consented editions for nothing. Nothing read
 * the price at publish at all — `readCapsuleSupply` reads supply only.
 *
 * ADMIN (collection-wide at tokenId 0, or on the token) or SALES both count:
 * SALES is the role that sets the price, ADMIN implies it. Fails CLOSED on an
 * unreadable RPC — publishing is a deliberate, retryable act, and admitting an
 * unverified capsule is the failure this exists to prevent.
 */
export type CapsuleControl =
  | { ok: true; pricePerToken: bigint; currency: 'eth' | 'usdc' }
  | { ok: false; code: 'not-controlled' | 'not-priced'; detail: string }

export async function checkCapsuleControl(params: {
  collection: string
  tokenId: string
  creator: string
}): Promise<CapsuleControl> {
  const client = serverBaseClient()
  const collection = params.collection as Address
  const tokenId = BigInt(params.tokenId)
  const creator = params.creator as Address

  let controls = false
  try {
    // tokenId 0 is Zora's collection-wide permission row; either grants control.
    const [onToken, onCollection] = await Promise.all([
      readPermissions(client, collection, tokenId, creator, { retries: 2 }),
      readPermissions(client, collection, 0n, creator, { retries: 2 }),
    ])
    const holds = (p: bigint) => hasAdminBit(p) || (p & PERMISSION_BIT_SALES) === PERMISSION_BIT_SALES
    controls = holds(onToken) || holds(onCollection)
  } catch {
    return {
      ok: false,
      code: 'not-controlled',
      detail: 'could not read your permissions on this capsule token — try again',
    }
  }
  if (!controls) {
    return {
      ok: false,
      code: 'not-controlled',
      detail: 'you do not hold admin or sales rights on this capsule token, so you cannot set what a play costs or who it pays',
    }
  }

  const sale = await resolveOnchainSale(client, collection, tokenId).catch(() => null)
  if (!sale) {
    return { ok: false, code: 'not-priced', detail: 'this capsule has no sale configured, so a play would cost nothing' }
  }
  if (sale.pricePerToken <= 0n) {
    return {
      ok: false,
      code: 'not-priced',
      detail: 'this capsule is priced at zero — every play would dispense an artist’s work for free',
    }
  }
  return { ok: true, pricePerToken: sale.pricePerToken, currency: sale.currency }
}

/**
 * Was this capsule BOUGHT, or minted for free by someone entitled to?
 *
 * ── The hole ──
 *
 * A play is authorised by a capsule mint, and every mint of a Zora 1155 emits
 * the same TransferSingle whether it came through the sale or through
 * `adminMint`, which any holder of ADMIN or MINTER on the token can call at no
 * cost. So a machine's creator could mint themselves a stack of free capsules
 * and play them — consuming OTHER artists' consented copies, whose share of a
 * price that was never paid is nothing. Bounded by the capsule's maxSupply and
 * by the postdate rule, but inside those bounds it is a drain on every artist
 * who trusted the pool.
 *
 * ── The evidence, in order of strength ──
 *
 *   1. The collection emitted `Purchased` for this token in this transaction.
 *      Only the 1155's own sale path emits it; `adminMint` never does. Both
 *      facts verified against Zora's source (see lib/verifyMint). Decisive.
 *   2. The mint was executed by Zora's ERC20Minter. It takes the ERC20 payment
 *      and then mints via `adminMint` (verified likewise) — so it emits no
 *      `Purchased`, and it IS a sale. Its address is the one every USDC collect
 *      in this codebase already sends funds to, so trusting it adds no trust.
 *   3. Otherwise: did the executing `operator` hold mint rights on the capsule?
 *      A buyer never does. A creator minting to themselves always does. Read
 *      on the token row and the collection-wide row — at the mint block where
 *      the chain will say, else live (next section).
 *
 * (1) is layered ABOVE (3) so that it can only ever ADD acceptances. That was
 * originally insurance against an unverified event declaration; now that the
 * declaration is verified it is defence in depth, and it still means a change
 * to Zora's event could refuse nobody honest — every sale would fall through
 * to (3), where an ordinary buyer passes.
 *
 * ── At the mint block, when the chain will say ──
 *
 * The question is what rights the operator held WHEN IT MINTED, not now. Read
 * live only, a creator who grants MINTER to a fresh wallet, mints, and revokes
 * before playing would pass. So (3) is asked first at the block the mint landed
 * in, which is exactly the state that decided whether `adminMint` succeeded.
 * A non-archive RPC can answer that only for recent blocks and throws for
 * older ones; a play normally follows its mint by seconds, so the pinned read
 * covers the ordinary case on any node, and the live read is the fallback for
 * an old mint on a node that cannot look back. The fallback is documented
 * weaker, not silently equal: on it, the three-transaction fraud passes, and
 * leaves two `UpdatedPermissions` events beside the mint for forensics.
 *
 * Fails closed on an unreadable RPC — the player retries — because the
 * alternative is to admit exactly the mint this exists to refuse.
 */
export type CapsulePurchase =
  | { ok: true }
  | { ok: false; reason: 'free-mint' | 'unreadable' }

export async function checkCapsulePurchase(params: {
  collection: string
  tokenId: string
  purchasedEvent: boolean
  operators: string[]
  /** Block the mint landed in, from the proof. Absent only for a proof whose
   *  verdict predates the field; the read is then live. */
  mintBlock?: number
}): Promise<CapsulePurchase> {
  if (params.purchasedEvent) return { ok: true }
  const erc20Minter = ZORA_ERC20_MINTER.toLowerCase()
  const suspects = params.operators.filter((op) => op !== erc20Minter)
  if (suspects.length === 0) return { ok: true }

  const client = serverBaseClient()
  const collection = params.collection as Address
  const tokenId = BigInt(params.tokenId)
  const pinned = params.mintBlock && params.mintBlock > 0 ? BigInt(params.mintBlock) : undefined

  const readBoth = (op: Address, blockNumber?: bigint) =>
    Promise.all([
      readPermissions(client, collection, tokenId, op, { retries: blockNumber ? 1 : 2, blockNumber }),
      readPermissions(client, collection, 0n, op, { retries: blockNumber ? 1 : 2, blockNumber }),
    ])

  for (const op of suspects) {
    let onToken: bigint
    let onCollection: bigint
    try {
      ;[onToken, onCollection] = pinned
        ? await readBoth(op as Address, pinned).catch(() => readBoth(op as Address))
        : await readBoth(op as Address)
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
    const canMintFree = (p: bigint) => hasAdminBit(p) || hasMinterBit(p)
    if (canMintFree(onToken) || canMintFree(onCollection)) return { ok: false, reason: 'free-mint' }
  }
  return { ok: true }
}

/**
 * Does the declared artist actually own the piece?
 *
 * A pool entry's `artist` was whatever the creator typed. It is the address the
 * split check holds the machine to, the address the blacklist is checked
 * against, and the name a winner is introduced to — and nothing verified it.
 * The grant that makes a piece deliverable is to the PLATFORM's operator, not
 * to a machine, so once an artist granted it for one machine, any creator could
 * pool that piece under their own name, satisfy 'artist-not-in-split' by being
 * in their own capsule's split, and dispense the artist's work while paying
 * them nothing.
 *
 * The artist is the token's ADMIN — the collection-wide row or the token's own
 * — which is the definition the rest of the platform already uses for who may
 * edit, price and grant on a piece, and the same read `checkCapsuleControl`
 * makes about the capsule. `undefined` when the chain could not answer, which
 * the solvency gate treats exactly like unreadable headroom: refused, retry.
 */
export async function readArtistControl(
  collection: string,
  tokenId: string,
  artist: string,
): Promise<boolean | undefined> {
  const client = serverBaseClient()
  try {
    // Collection-wide first, on its own: it is where Zora puts the admin of
    // every token a creator set up, so it answers for almost every entry and the
    // token row is read only when it does not. Publish reads this for every
    // entry of a pool alongside its headroom, and the difference between one
    // read and two is the difference between a burst the RPC absorbs and one it
    // rate-limits into a spurious 'artist-unreadable' on a legitimate machine.
    const onCollection = await readPermissions(client, collection as Address, 0n, artist as Address, { retries: 2 })
    if (hasAdminBit(onCollection)) return true
    const onToken = await readPermissions(client, collection as Address, BigInt(tokenId), artist as Address, { retries: 2 })
    return hasAdminBit(onToken)
  } catch {
    return undefined
  }
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
