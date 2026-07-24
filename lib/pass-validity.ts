import { redis } from './redis'
import { serverBaseClient } from './rpc'
import { isPassBlacklisted } from './pass-blacklist'
import { shouldCreditTransfer } from './passCredit'

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

// Per-tx set of the `<recipient>:<tokenId>` pairs individually verified as
// platform acquisitions in this tx (see platformTxMember), consulted by the
// webhook via SISMEMBER. Per-(recipient, tokenId) — not tx-level — so a
// transfer bundled into a platform-flagged tx (e.g. a smart-wallet batch)
// can't inherit "platform-originated" to escape taint or get credited. New
// `:rcpt:` namespace so it never collides with the pre-migration tx-level
// string flag (which simply expires unread).
const keyPlatformTx = (txHash: string) =>
  `kismetart:pass:platform-tx:rcpt:${txHash.toLowerCase()}`
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
// tokenId is included so a multicall that sends two different tokenIds to
// the same address in one tx gets two independent credits (one per tokenId)
// rather than having the second claim blocked by the first's NX lock.
const keyCredited = (collection: string, address: string, txHash: string, tokenId: string) =>
  `kismetart:pass:credited:${collection.toLowerCase()}:${address.toLowerCase()}:${txHash.toLowerCase()}:${tokenId}`
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

// Atomically INCRBY the balance and, when the result drops to ≤ 0, delete
// the admin-grant flag in the same Redis round-trip. Without atomicity, a
// concurrent setValidBalance (two writes: SET balance + SET adminGrant) could
// have its adminGrant overwritten by a webhook INCRBY's separate DEL arriving
// between the two SET calls, silently removing a deliberate admin override.
const ADJUST_BALANCE_LUA = `
local new = tonumber(redis.call('INCRBY', KEYS[1], tonumber(ARGV[1])))
if new <= 0 then redis.call('DEL', KEYS[2]) end
return new
`

// Atomically write both validBalance and adminGrant so no concurrent INCRBY
// (from a webhook decrement) can interleave and leave them inconsistent.
const SET_VALIDITY_LUA = `
local safe = tonumber(ARGV[1])
redis.call('SET', KEYS[1], tostring(safe))
if safe > 0 then redis.call('SET', KEYS[2], '1') else redis.call('DEL', KEYS[2]) end
return 1
`

// Compare-and-swap for drift correction in hasValidPass. Only overwrites the
// ledger if its current value still equals what we read when we called
// balanceOfBatch. Guards against a concurrent creditValidityOnce INCRBY
// landing between the read and the SET — without the CAS that INCRBY would
// be silently overwritten by the stale drift-correction SET, permanently
// losing the legitimate credit.
const CAS_BALANCE_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur == tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0
`

const ERC1155_ABI = [
  {
    inputs: [{ type: 'address[]' }, { type: 'uint256[]' }],
    name: 'balanceOfBatch',
    outputs: [{ type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Multi-SADD + EXPIRE in ONE eval (one Redis round-trip / billed command) so a
// many-recipient airdrop flags everyone in a single command instead of N — back
// to the pre-fix command count and within the Redis free-tier budget — and the
// set always carries its TTL (a SADD without a paired EXPIRE would leak the
// key). ARGV[1] = TTL, ARGV[2..] = members.
const RECORD_PLATFORM_TX_LUA = `
for i = 2, #ARGV do
  redis.call('SADD', KEYS[1], ARGV[i])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return 1
`

// A flagged set member is `<recipient>:<canonical tokenId>` — the exact
// (wallet, tokenId) pair a route proved on-chain. Per-(recipient, tokenId),
// not per-recipient: otherwise a transfer of a DIFFERENT tokenId bundled into
// the same tx as a legitimate acquisition by the same wallet would still ride
// the recipient's flag (escape taint + take a redundant credit). tokenId is
// canonicalized (BigInt) so it matches the webhook's hexToBigIntString form
// regardless of leading zeros. Returns null for an unparseable tokenId →
// unflaggable, treated as not-platform.
function platformTxMember(recipient: string, tokenId: string): string | null {
  if (!recipient || !tokenId) return null
  try {
    return `${recipient.toLowerCase()}:${BigInt(tokenId).toString()}`
  } catch {
    return null
  }
}

/** Flag each of `recipients` as a verified platform acquirer of `tokenId` in
 *  `txHash` (mint, collect, airdrop, or Kismet secondary fill) — all in ONE
 *  eval, so a many-recipient airdrop is a single Redis command. The webhook
 *  consults this set per-(recipient, tokenId) to decide whether a transfer's
 *  `to` earns validity for that tokenId and whether the tokenId escapes taint.
 *  Callers MUST flag only pairs they proved on-chain — never the whole tx — so
 *  a transfer bundled into the same tx can't ride the flag to launder validity
 *  or skip taint.
 *
 *  Retries with backoff so a transient Redis flap doesn't silently drop the
 *  flag — a missing flag at webhook time silently denies the recipient pass
 *  validity even though they legitimately got the Pass through our flow. */
export async function recordPlatformTx(
  txHash: string,
  recipients: string[],
  tokenId: string,
): Promise<void> {
  const members = recipients
    .map((r) => platformTxMember(r, tokenId))
    .filter((m): m is string => m !== null)
  if (!txHash || members.length === 0) return
  const delays = [0, 200, 500, 1000]
  let lastErr: unknown
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay))
    try {
      await redis.eval(
        RECORD_PLATFORM_TX_LUA,
        [keyPlatformTx(txHash)],
        [PLATFORM_TX_TTL, ...members],
      )
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

async function isPlatformTx(txHash: string, recipient: string, tokenId: string): Promise<boolean> {
  const member = platformTxMember(recipient, tokenId)
  if (!member) return false
  const v = await redis.sismember(keyPlatformTx(txHash), member)
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
  // Lua script runs atomically: INCRBY then DEL adminGrant if result ≤ 0.
  // A separate DEL after INCRBY would race with concurrent setValidBalance
  // (which writes both keys in a single script), potentially deleting an
  // admin-grant flag that was set after our INCRBY resolved.
  await redis.eval(
    ADJUST_BALANCE_LUA,
    [keyValidBalance(collection, address), keyAdminGrant(collection, address)],
    [delta],
  )
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
  // Atomic Lua script: SET balance and SET/DEL adminGrant in one round-trip.
  // Without atomicity, a webhook INCRBY that lands between the two writes
  // could see: balance=safe (new) but adminGrant=deleted (stale DEL from a
  // concurrent adjustValidBalance), stranding a legitimate admin override.
  await redis.eval(
    SET_VALIDITY_LUA,
    [keyValidBalance(collection, address), keyAdminGrant(collection, address)],
    [safe],
  )
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
  // Fail CLOSED on a missing tokenId: an empty id must never read as
  // "not tainted" and let a credit through. Defense-in-depth — creditValidityOnce
  // already rejects an empty tokenId before reaching here.
  if (!tokenId) return true
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
 *  2. Credit `to` via creditValidityOnce when the transfer is a MINT
 *     (from == 0x0 — the genesis of the Pass, always a valid acquisition, so
 *     it needs no platform flag) OR when `(to, tokenId)` is a flagged platform
 *     acquisition of this tx (Kismet collect / airdrop / secondary fill). The
 *     mint arm makes the webhook self-sufficient when the client's /api/collect
 *     never runs (dropped POST, hung receipt wait); the flag arm is
 *     per-(recipient, tokenId), so a transfer co-bundled into the tx — to an
 *     unflagged wallet, OR of a different tokenId to a flagged wallet — is NOT
 *     credited. Direct-credit paths converge through the same idempotency key.
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

  // Per-(recipient, tokenId): was THIS exact (to, tokenId) pair flagged as a
  // verified platform acquisition in this tx? A transfer whose (to, tokenId)
  // wasn't verified — including a different tokenId bundled into a tx that
  // flagged `to` for some OTHER tokenId — reads false, so it taints + isn't
  // credited.
  const platform = await isPlatformTx(txHash, to, tokenId)
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
  // Credit when the acquisition is a MINT or a platform-verified transfer.
  //
  // MINT (isMint, from == 0x0): a Transfer from the zero address is the
  // genesis of the Pass — a definitionally valid acquisition per the "valid
  // pass" definition (mint / airdrop / Kismet secondary). There is no prior
  // owner to launder from, so a mint needs no platform flag. Crediting mints
  // unconditionally here makes the webhook SELF-SUFFICIENT: the client's
  // /api/collect (which both sets the platform flag via recordPlatformTx AND
  // direct-credits) can fail or never run — e.g. a desktop-browser mint whose
  // post-mint waitForTransactionReceipt hangs or whose /api/collect POST is
  // dropped on tab-close — and the buyer STILL earns validity from the
  // on-chain event alone. This closes the permanent-loss gap where a
  // minted-but-unflagged Pass credited no one (the webhook saw the mint,
  // claimed its processed-key, and — with the old `if (platform)` — did
  // nothing, losing the credit forever). creditValidityOnce shares the same
  // keyCredited as /api/collect's synchronous credit, so the normal path
  // (both fire) never double-credits; its taint check still refuses a mint of
  // a previously-tainted tokenId, and its blacklist check still applies.
  //
  // PLATFORM (non-mint): a Kismet collect / airdrop / secondary fill, proven
  // by the per-(recipient, tokenId) flag. listedOnKismet is intentionally
  // excluded from the credit condition: the listing PATCH handler calls
  // creditValidityOnce synchronously before the response (primary credit),
  // and recordPlatformTx in after() ensures the webhook converges via the
  // platform flag. Allowing listedOnKismet to also trigger credit opened an
  // exploit: an attacker could list a Pass on Kismet (sets the flag) then
  // transfer it off-platform to an accomplice; the webhook would see
  // listedOnKismet=true, skip taint, and credit the accomplice for free.
  // The flag's sole remaining job is taint prevention during the race window.
  if (shouldCreditTransfer({ platform, isMint })) {
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
  // Reject a missing tokenId outright: without it the taint check below is
  // meaningless (a tainted Pass could be credited) and the credited-key/
  // known-tokens writes are skipped. No caller passes an empty id today (all
  // canonicalize via BigInt().toString()); this closes the latent footgun.
  if (amount <= 0 || !address || !txHash || !tokenId) return

  if (await isPassBlacklisted(address)) return

  // Pass-purity check: a tainted tokenId (one that has ever left the
  // sanctioned chain through an off-platform transfer) cannot confer
  // validity again, even via Kismet's own marketplace. This is the
  // launder-prevention layer per the "valid pass" definition. Fails
  // CLOSED — see isTokenTainted's docstring. Admin override (manual
  // setValidBalance) is the only bypass.
  if (await isTokenTainted(collection, tokenId)) return

  const claimed = await redis.set(
    keyCredited(collection, address, txHash, tokenId),
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
    const corrected = Number(liveTotal)
    try {
      // CAS: only overwrite if the ledger value hasn't changed since we read
      // it above. A concurrent creditValidityOnce INCRBY landing between the
      // balanceOfBatch call and this SET would otherwise be silently
      // overwritten, permanently losing a legitimate credit.
      await redis.eval(
        CAS_BALANCE_LUA,
        [keyValidBalance(collection, address)],
        [validBalance, String(corrected)],
      )
    } catch {
      // Best-effort; in-memory clamp still applies for this request.
    }
    validBalance = corrected
  }

  return validBalance >= 1
}

/** List all tainted tokenIds for a collection. Used by the admin taint
 *  management endpoint to inspect and remediate incorrect taints. */
export async function listTaintedTokenIds(collection: string): Promise<string[]> {
  try {
    const members = (await redis.smembers(keyTainted(collection))) as string[]
    return Array.isArray(members) ? members.sort() : []
  } catch {
    return []
  }
}

/** Remove a tokenId from the taint set. Admin escape-hatch for false taints:
 *  e.g. a legitimate Kismet secondary sale that was incorrectly tainted because
 *  the keyKismetListed flag was missing (Redis down at listing creation time).
 *
 *  Does NOT restore past credits — addresses that previously failed
 *  creditValidityOnce due to the taint must be granted via setValidBalance.
 *  Future acquisitions of the un-tainted tokenId will credit normally. */
export async function removeTaint(collection: string, tokenId: string): Promise<void> {
  if (!collection || !tokenId) return
  await redis.srem(keyTainted(collection), tokenId)
}
