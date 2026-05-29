import { redis } from './redis'
import { serverBaseClient } from './rpc'
import { isPassBlacklisted } from './pass-blacklist'

const PROCESSED_TTL = 30 * 24 * 60 * 60 // 30 days
// Platform-tx flags live long enough to cover any plausible Alchemy
// delivery delay (typically seconds-to-minutes; SLA spec is hours). 90
// days bounds the keyspace — without it, every successful mint, collect,
// and airdrop wrote a permanent Redis key, even for non-Pass-collection
// targets where the flag is never consulted (the webhook filters by
// passCollection, so the flag sits unread for off-Pass mints).
const PLATFORM_TX_TTL = 90 * 24 * 60 * 60
// Credited-once dedup TTL. Bounds the keyspace to the same realistic
// window as platform-tx; long-tail re-delivery beyond 90d is implausible.
const CREDITED_TTL = 90 * 24 * 60 * 60
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const keyPlatformTx = (txHash: string) =>
  `kismetart:pass:platform-tx:${txHash.toLowerCase()}`
const keyValidBalance = (collection: string, addr: string) =>
  `kismetart:pass:valid-balance:${collection.toLowerCase()}:${addr.toLowerCase()}`
const keyAdminGrant = (collection: string, addr: string) =>
  `kismetart:pass:admin-grant:${collection.toLowerCase()}:${addr.toLowerCase()}`
const keyKnownTokens = (collection: string) =>
  `kismetart:pass:tokenids:${collection.toLowerCase()}`
const keyProcessed = (txHash: string, logIndex: number, subIndex: number) =>
  `kismetart:pass:processed:${txHash.toLowerCase()}:${logIndex}:${subIndex}`
// Per-acquisition idempotency for credits — distinct from the per-event
// processed-key above. Direct-credit paths (listing fill, future:
// collect, airdrop) and the webhook backstop both write through
// creditValidityOnce, which CAS-claims this key; second writer is a no-op.
const keyCredited = (collection: string, address: string, txHash: string) =>
  `kismetart:pass:credited:${collection.toLowerCase()}:${address.toLowerCase()}:${txHash.toLowerCase()}`

const ERC1155_ABI = [
  {
    inputs: [{ type: 'address[]' }, { type: 'uint256[]' }],
    name: 'balanceOfBatch',
    outputs: [{ type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/** Mark a transaction as platform-originated (mint, collect, or platform sale).
 *  Called server-side from the endpoints that produce Pass-related on-chain txs.
 *  The webhook later consults this set to decide whether a transfer's recipient
 *  earns validity (yes for platform-originated, no for off-platform).
 *
 *  Retries with backoff so a transient Redis flap doesn't silently drop the
 *  flag — a missing flag at webhook time silently denies the recipient pass
 *  validity even though they legitimately got the Pass through our flow. */
export async function recordPlatformTx(txHash: string): Promise<void> {
  if (!txHash) return
  const delays = [0, 200, 500, 1000]
  let lastErr: unknown
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    try {
      await redis.set(keyPlatformTx(txHash), '1', { ex: PLATFORM_TX_TTL })
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

async function isPlatformTx(txHash: string): Promise<boolean> {
  const v = await redis.get(keyPlatformTx(txHash))
  return !!v
}

export async function getValidBalance(collection: string, address: string): Promise<number> {
  const v = await redis.get<string | number>(keyValidBalance(collection, address))
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseInt(v, 10) || 0
  // Clamp at read time. Stored value may briefly be negative due to
  // out-of-order webhook events; never return negatives to callers.
  return Math.max(0, n)
}

async function adjustValidBalance(collection: string, address: string, delta: number): Promise<void> {
  // INCRBY is atomic and returns the post-write value. We do NOT clamp
  // negative values back to 0 here — that would be a non-atomic check-
  // then-write race. Reads clamp via Math.max(0).
  const newBalance = (await redis.incrby(keyValidBalance(collection, address), delta)) as number
  // Clear the admin-grant flag once validBalance hits zero. Without this
  // an admin-granted address that later sells / transfers their Pass
  // would keep the flag persisting past the depletion, and any subsequent
  // legitimate acquisition (airdrop, mint, collect) would still skip live
  // reconciliation under the stale flag — meaning a webhook-drift bug
  // wouldn't be caught for that address. Best-effort: the clamp on read
  // still applies if the DEL fails.
  if (newBalance <= 0) {
    await redis.del(keyAdminGrant(collection, address)).catch(() => {})
  }
}

/** Admin override: set the validBalance for an address to an explicit value.
 *  Used as an escape hatch for webhook-failure recovery, promotional grants
 *  (e.g. early access before a Pass is delivered), or revocation of a
 *  specific holder without nuking the whole collection.
 *
 *  When safe > 0, marks an "admin-grant" flag so hasValidPass honors the
 *  value directly without live on-chain reconciliation. Without this flag,
 *  admin grants to non-holders would be silently zeroed by balanceOfBatch.
 *  When safe === 0, clears the flag — explicit revocation removes the
 *  override semantics. */
export async function setValidBalance(
  collection: string,
  address: string,
  value: number,
): Promise<void> {
  const safe = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  if (safe > 0) {
    await Promise.all([
      redis.set(keyValidBalance(collection, address), String(safe)),
      redis.set(keyAdminGrant(collection, address), '1'),
    ])
  } else {
    await Promise.all([
      redis.set(keyValidBalance(collection, address), '0'),
      redis.del(keyAdminGrant(collection, address)),
    ])
  }
}

async function getKnownTokenIds(collection: string): Promise<string[]> {
  try {
    const ids = (await redis.smembers(keyKnownTokens(collection))) as string[]
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

/** Process a single Transfer event for the gate's Pass collection. Idempotent
 *  via processed-key (tx:logIdx:subIdx). Aggregates validity across all
 *  tokenIds in the collection — every Pass tokenId grants access. Auto-
 *  discovers tokenIds for later live-balance reconciliation.
 *
 *  - Platform-originated tx: increment `to` (always), decrement `from` (unless mint).
 *  - Off-platform tx: decrement `from` only (recipients gain nothing). Direct
 *    contract-call mints (no platform-tx flag) confer no validity. */
export async function processTransfer(params: {
  collection: string
  from: string
  to: string
  amount: number
  tokenId: string
  txHash: string
  logIndex: number
  /** Within-event index for batched ERC1155 transfers (multiple tokenIds in
   *  a single TransferBatch log). Defaults to 0 for single-transfer events. */
  subIndex?: number
}): Promise<void> {
  const { collection, from, to, amount, tokenId, txHash, logIndex } = params
  const subIndex = params.subIndex ?? 0
  if (amount <= 0) return

  const claimed = await redis.set(keyProcessed(txHash, logIndex, subIndex), '1', {
    nx: true,
    ex: PROCESSED_TTL,
  })
  if (!claimed) return

  if (tokenId) {
    void redis.sadd(keyKnownTokens(collection), tokenId).catch(() => {})
  }

  const platform = await isPlatformTx(txHash)
  const isMint = from === ZERO_ADDRESS

  // Off-platform sale invariant: `from`'s decrement runs UNCONDITIONALLY
  // for any non-mint transfer. So an OpenSea / direct-Seaport / P2P
  // transfer of a Pass automatically revokes the seller's validity, even
  // though `to` is never credited (the platform-flag gate below denies
  // them). Live reconciliation in hasValidPass is a second layer of
  // protection: if this webhook event is missed, the ledger>on-chain
  // clamp still revokes once the seller no longer holds the token.
  if (!isMint) {
    await adjustValidBalance(collection, from, -amount)
  }
  if (platform) {
    // Convergence point: webhook and any direct-credit path
    // (currently /api/listings/[id] PATCH filled, on a Pass-collection
    // sale) both call creditValidityOnce so whichever fires first
    // credits and the other is a no-op. Pass-blacklist + knownTokenIds
    // sadd live inside the primitive.
    await creditValidityOnce({ collection, address: to, txHash, tokenId, amount })
  }
}

/**
 * Idempotent validity credit keyed by (collection, address, txHash).
 * Designed to be called from BOTH the synchronous direct-credit paths
 * (e.g. /api/listings/[id] PATCH filled on a Kismet Pass sale) AND the
 * asynchronous webhook backstop — whichever fires first wins the SET NX
 * and increments validBalance; the other is a no-op via the same key.
 *
 * Always populates knownTokenIds. hasValidPass's live reconciliation
 * (balanceOfBatch clamp-down) only runs when knownTokenIds is non-empty,
 * so without this sadd a direct credit ahead of any webhook event would
 * leave the ledger uncheckable and the gate would trust a stale value.
 *
 * Pass-blacklist short-circuits BEFORE the CAS so a blacklisted address
 * doesn't burn the credited-key slot for a real future acquisition.
 *
 * Caller responsibilities:
 *   - On-chain proof that `address` received `tokenId` of `collection`
 *     in `txHash` (collect: verifyMintOnChain; airdrop: verifyAirdropOnChain;
 *     listing fill: findFulfillmentInLogs + recipient===signer).
 *   - This function trusts what it's given. It is the credit step, not
 *     the proof step.
 */
export async function creditValidityOnce(params: {
  collection: string
  address: string
  txHash: string
  tokenId: string
  amount?: number
}): Promise<void> {
  const { collection, address, txHash, tokenId } = params
  const amount = params.amount ?? 1
  if (amount <= 0 || !address || !txHash) return

  if (await isPassBlacklisted(address)) return

  const claimed = await redis.set(
    keyCredited(collection, address, txHash),
    '1',
    { nx: true, ex: CREDITED_TTL },
  )
  if (!claimed) return

  if (tokenId) {
    void redis.sadd(keyKnownTokens(collection), tokenId).catch(() => {})
  }
  await adjustValidBalance(collection, address, amount)
}

/** Returns true if the address holds any validly-acquired pass in the
 *  collection. Combines the Redis aggregate ledger with a live on-chain
 *  balanceOfBatch across known tokenIds; clamps the ledger DOWN if the live
 *  total is lower (catches webhook drift). Fails closed on RPC or Redis error.
 *
 *  Admin-grant exception: if setValidBalance was used to grant validity
 *  explicitly, skip live reconciliation. Without this, grants to non-holders
 *  (promotional access before a Pass is airdropped) get silently nullified by
 *  balanceOfBatch. The grant is the documented intent of the override path. */
export async function hasValidPass(collection: string, address: string): Promise<boolean> {
  // Pass-blacklist short-circuit: even if the address holds the Pass
  // on-chain and the ledger says they have a positive balance, an
  // admin-listed address is denied creator access. This is the moderation
  // overlay that operates on top of the ledger; it lets admin revoke
  // validity without nuking the ledger value (which would be silently
  // restored by the next legitimate Transfer event).
  if (await isPassBlacklisted(address)) return false

  let validBalance: number
  try {
    validBalance = await getValidBalance(collection, address)
  } catch {
    return false
  }

  // Admin-granted validity bypasses on-chain check — see setValidBalance.
  try {
    const granted = await redis.get(keyAdminGrant(collection, address))
    if (granted) return validBalance >= 1
  } catch {
    // Redis transient — fall through to live reconciliation.
  }

  // No tokenIds known yet (empty collection or fresh setup) — the ledger is
  // authoritative. validBalance > 0 only happens after a webhook event, which
  // would have populated knownTokenIds, so this is rare.
  const knownIds = await getKnownTokenIds(collection)
  if (knownIds.length === 0) {
    return validBalance >= 1
  }

  let liveTotal = 0n
  try {
    const balances = (await serverBaseClient().readContract({
      address: collection as `0x${string}`,
      abi: ERC1155_ABI,
      functionName: 'balanceOfBatch',
      args: [
        knownIds.map(() => address as `0x${string}`),
        knownIds.map((id) => BigInt(id)),
      ],
    })) as readonly bigint[]
    for (const b of balances) liveTotal += b
  } catch {
    return false
  }

  if (liveTotal < BigInt(validBalance)) {
    validBalance = Number(liveTotal)
    try {
      await redis.set(keyValidBalance(collection, address), String(validBalance))
    } catch {
      // Best-effort drift correction; in-memory clamp still applies for this request.
    }
  }

  return validBalance >= 1
}
