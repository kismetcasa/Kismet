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
// processed-key above. The direct-credit path (listing fill) and the
// webhook backstop both write through creditValidityOnce, which CAS-
// claims this key; second writer is a no-op.
const keyCredited = (collection: string, address: string, txHash: string) =>
  `kismetart:pass:credited:${collection.toLowerCase()}:${address.toLowerCase()}:${txHash.toLowerCase()}`
// Tainted tokenIds: any tokenId that has ever left the sanctioned
// provenance chain via an off-platform transfer (OpenSea sale, P2P send,
// burn, direct Seaport fill). Once in this set, the tokenId is
// permanently denied as a validity source — even if subsequently
// resold through Kismet's marketplace. This is the Pass-purity
// invariant per the user's "valid pass" definition: collected /
// airdropped / bought-on-Kismet-secondary, with every link in the
// chain on-platform. Admin can override via setValidBalance.
const keyTainted = (collection: string) =>
  `kismetart:pass:tainted:${collection.toLowerCase()}`
// Active Kismet listing marker: set at listing-creation time, cleared at
// fill/cancel/expiry. processTransfer checks this before tainting so a
// legitimate Kismet secondary sale is not falsely tainted when the
// webhook races ahead of the listing PATCH's recordPlatformTx write.
// Keyed by seller so a concurrent holder selling the same tokenId
// off-platform is not shielded by another holder's Kismet listing.
const keyKismetListed = (collection: string, tokenId: string, seller: string) =>
  `kismetart:pass:kismet-listed:${collection.toLowerCase()}:${tokenId}:${seller.toLowerCase()}`

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

/** Mark (collection, tokenId, seller) as actively listed on Kismet.
 *  Called at listing-creation time so processTransfer can distinguish
 *  a legitimate Kismet secondary sale from a truly off-platform transfer,
 *  even when the webhook races ahead of the listing PATCH's after()
 *  callbacks. TTL should match the listing's remaining lifetime so the
 *  flag auto-expires if the explicit clear at fill/cancel is missed. */
export async function markKismetListed(
  collection: string,
  tokenId: string,
  seller: string,
  ttlSeconds: number,
): Promise<void> {
  if (!collection || !tokenId || !seller || ttlSeconds <= 0) return
  try {
    await redis.set(keyKismetListed(collection, tokenId, seller), '1', { ex: ttlSeconds })
  } catch {
    // Best-effort: a missed flag means processTransfer falls back to the
    // normal taint path. The listing PATCH's synchronous creditValidityOnce
    // is the primary credit path; this flag only prevents the false taint.
  }
}

/** Clear the Kismet-listed flag when a listing is filled, cancelled, or expired.
 *  A lingering flag (e.g. after a Redis error here) is bounded by the TTL set
 *  at creation time, so it self-corrects within the listing's original lifetime. */
export async function clearKismetListed(
  collection: string,
  tokenId: string,
  seller: string,
): Promise<void> {
  if (!collection || !tokenId || !seller) return
  try {
    await redis.del(keyKismetListed(collection, tokenId, seller))
  } catch {
    // Best-effort: the TTL from markKismetListed bounds the stale window.
  }
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

/** Single-tokenId taint check, used at credit-decision time. Fails CLOSED:
 *  a transient Redis error here should NOT silently grant validity to a
 *  potentially-tainted Pass — better to deny a legitimate credit (which
 *  the webhook backstop or admin grant will recover) than to launder
 *  validity through a downed Redis. */
async function isTokenTainted(collection: string, tokenId: string): Promise<boolean> {
  if (!tokenId) return false
  try {
    return !!(await redis.sismember(keyTainted(collection), tokenId))
  } catch {
    return true
  }
}

/** Bulk taint lookup for hasValidPass's live reconciliation. Fails OPEN:
 *  the ledger is the authoritative credit record (creditValidityOnce
 *  rejected tainted tokens at write time), so a missing taint set here
 *  only matters for the rare drift case where the webhook missed a
 *  decrement. Worst case during outage: a stale-ledger holder briefly
 *  passes the gate; the credit-time fail-closed above prevents new
 *  laundering. */
async function getTaintedTokenIds(collection: string): Promise<Set<string>> {
  try {
    const members = (await redis.smembers(keyTainted(collection))) as string[]
    return new Set(Array.isArray(members) ? members : [])
  } catch {
    return new Set()
  }
}

/** Process a single Transfer event for the gate's Pass collection. Idempotent
 *  via processed-key (tx:logIdx:subIdx). Aggregates validity across all
 *  tokenIds in the collection — every Pass tokenId grants access. Auto-
 *  discovers tokenIds for later live-balance reconciliation.
 *
 *  Three rules, derived from the "valid pass" definition (acquired through
 *  mint / airdrop / Kismet secondary, with every link on-platform):
 *
 *  1. ANY non-mint transfer decrements `from` (revokes the sender's
 *     validity). Unconditional — applies to OpenSea, Seaport direct,
 *     P2P safeTransferFrom, burns. The platform-flag only affects the
 *     to-credit decision below, never the from-decrement.
 *  2. Platform-flagged tx (Kismet mint / collect / airdrop / secondary
 *     fill) credits `to` via creditValidityOnce. Direct-credit paths
 *     converge through the same idempotency key.
 *  3. OFF-PLATFORM non-mint transfer permanently taints the tokenId.
 *     A tainted tokenId can never confer validity again, even via a
 *     subsequent Kismet sale — creditValidityOnce refuses credit for
 *     it, and hasValidPass excludes it from liveTotal so a webhook-
 *     missed decrement can't keep a tainted-only holder valid. */
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

  // Any-transfer-revokes invariant: `from`'s decrement runs
  // UNCONDITIONALLY for any non-mint Transfer event — OpenSea sale,
  // direct Seaport fill, P2P safeTransferFrom (e.g. sending to a
  // different wallet you own), burn, all the same. The platform-flag
  // gate only affects whether `to` is credited, never whether `from`
  // is decremented. Live reconciliation in hasValidPass is a second
  // layer of protection: if this webhook event is missed, the
  // ledger>on-chain clamp still revokes once the seller no longer
  // holds the token.
  if (!isMint) {
    await adjustValidBalance(collection, from, -amount)
  }

  // Race-condition guard: check whether `from` has an active Kismet listing
  // for this tokenId. If so, treat it as platform-originated even without
  // the platform-tx flag — the listing was created before the transfer,
  // proving a Kismet secondary sale was in flight. Without this, a webhook
  // that fires before the listing PATCH's after() callbacks set the
  // platform-tx flag would falsely taint the tokenId, permanently blocking
  // the buyer's validity even though the sale was fully on-platform.
  // Keyed on (collection, tokenId, from/seller) to avoid shielding a
  // concurrent off-platform sale by a different holder of the same tokenId.
  const listedOnKismet =
    !isMint && !platform && tokenId
      ? !!(await redis.get(keyKismetListed(collection, tokenId, from)).catch(() => null))
      : false

  // Pass-purity invariant: any non-mint transfer that is NOT platform-flagged
  // AND NOT a Kismet-listed transfer taints the tokenId permanently. The
  // listedOnKismet guard above prevents a race-induced false taint on
  // legitimate Kismet secondary sales; it does NOT bypass existing taint —
  // creditValidityOnce still refuses credits for previously-tainted tokens.
  if (!isMint && !platform && !listedOnKismet && tokenId) {
    try {
      await redis.sadd(keyTainted(collection), tokenId)
    } catch {
      // Best-effort. A missed taint here is the only way a tainted
      // tokenId could later relaunder through Kismet — but hasValidPass's
      // live reconciliation excludes tainted tokenIds from liveTotal, so
      // even a missed taint is recovered if and when the taint set is
      // ever populated for this tokenId by any subsequent off-platform
      // event. Worst-case window: one Kismet-laundering credit between
      // a transient Redis failure and the next off-platform event.
    }
  }
  if (platform || listedOnKismet) {
    // Convergence point: webhook (either via platform flag or listing guard)
    // and the listing PATCH's synchronous creditValidityOnce both call this
    // primitive — whichever fires first claims the keyCredited CAS and the
    // other is a no-op. Pass-blacklist + existing taint check + knownTokenIds
    // sadd live inside creditValidityOnce.
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

  // Pass-purity check: a tainted tokenId (one that has ever left the
  // sanctioned chain through an off-platform transfer) cannot confer
  // validity again, even via Kismet's own marketplace. This is the
  // launder-prevention layer per the "valid pass" definition. Fails
  // CLOSED — see isTokenTainted's docstring. Admin override (manual
  // setValidBalance) is the only bypass.
  if (await isTokenTainted(collection, tokenId)) return

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
  const [knownIds, taintedIds] = await Promise.all([
    getKnownTokenIds(collection),
    getTaintedTokenIds(collection),
  ])
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
    // Exclude tainted tokenIds from liveTotal. Without this, a holder
    // who only owns tainted Passes (e.g. legitimate ledger drifted
    // because the webhook missed a decrement) would have
    // live >= ledger → no clamp → keep validity from a tainted source.
    // Including only untainted balances in liveTotal makes the clamp
    // correctly revoke them.
    for (let i = 0; i < balances.length; i++) {
      if (taintedIds.has(knownIds[i])) continue
      liveTotal += balances[i]
    }
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
