import { redis } from './redis'
import { serverBaseClient } from './rpc'
import { isPassBlacklisted } from './pass-blacklist'
import { parseLedgerBalance } from './passUnion'
import {
  countableUnits,
  parseUnitCount,
  planTransferEffects,
} from './passTaint'

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
// can't inherit "platform-originated" to escape the off-platform mark or get
// credited. New
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
// Off-platform provenance, per HOLDER: a HASH of { tokenId -> units this
// address acquired outside the sanctioned chain } (OpenSea sale, P2P send,
// direct Seaport fill). hasValidPass subtracts these units from what the
// holder's on-chain balance is allowed to prove, so an off-platform copy
// confers nothing while every other holder of the same edition is untouched.
// Fields are deleted as units are released, so the key disappears on its own
// once a wallet is clean — no TTL needed and no unbounded growth.
//
// REPLACES `kismetart:pass:tainted:<collection>` (below), a per-COLLECTION set
// of tokenIds. That form was correct for a 1-of-1 and catastrophic for an
// edition: Patron drops are 19 and 100 copies of ONE id, so a single holder's
// off-platform transfer excluded that id from EVERY holder's live balance and
// made creditValidityOnce refuse every future mint of a still-open sale. The
// full argument, and why units rather than a per-holder boolean, is in
// lib/passTaint.ts; the rules are pinned by scripts/verify-pass-taint.ts.
const keyOffPlatform = (collection: string, address: string) =>
  `kismetart:pass:offplatform:${collection.toLowerCase()}:${address.toLowerCase()}`

// The superseded token-scoped taint set. Nothing in the request path reads it
// any more — it is kept addressable only so the migration can inspect and
// clear it (listLegacyTaintedTokenIds / clearLegacyTaint, driven by
// scripts/reconcile-pass-validity.mjs). Delete this and its two helpers once
// production reports an empty set.
const keyLegacyTainted = (collection: string) =>
  `kismetart:pass:tainted:${collection.toLowerCase()}`
// Active Kismet listing marker: set at listing-creation time, cleared at
// fill/cancel/expiry. processTransfer checks it before recording an
// off-platform acquisition, so a legitimate Kismet secondary sale does not
// falsely discount the BUYER's copy when the
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

// Release off-platform units from a sender, atomically and clamped at zero.
// Read-modify-write in app code would race two concurrent transfers from the
// same wallet and could leave a NEGATIVE count, which would then offset a
// later genuine off-platform acquisition and silently launder it. Deleting
// the field at zero (rather than storing 0) keeps the hash — and the key —
// from accumulating dead entries for wallets that have gone clean.
const RELEASE_OFFPLATFORM_LUA = `
local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
local new = cur - tonumber(ARGV[2])
if new <= 0 then
  redis.call('HDEL', KEYS[1], ARGV[1])
else
  redis.call('HSET', KEYS[1], ARGV[1], new)
end
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
// the recipient's flag (escape the off-platform mark + take a redundant
// credit). tokenId is
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
 *  `to` earns validity for that tokenId and whether `to` escapes being recorded
 *  as an off-platform acquirer of it.
 *  Callers MUST flag only pairs they proved on-chain — never the whole tx — so
 *  a transfer bundled into the same tx can't ride the flag to launder validity
 *  or skip the off-platform mark.
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
    // normal off-platform path. The listing PATCH's synchronous
    // creditValidityOnce is the primary credit path; this flag only prevents
    // the buyer being falsely recorded as an off-platform acquirer.
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
  // parseLedgerBalance clamps at read time: the stored value may briefly be
  // negative due to out-of-order webhook events; never return negatives.
  return parseLedgerBalance(v)
}

/** Batched ledger read: ONE MGET for many addresses (Upstash bills per
 *  command, and the gate's identity union makes multi-address reads the
 *  common case). Same eventually-consistent, clamped-at-0 contract as
 *  getValidBalance, index-aligned with `addresses`. Throws on Redis failure
 *  so each caller picks its own degradation (hasValidPassForAny falls back
 *  to per-wallet fail-closed checks; /api/pass-validity 500s and the client
 *  hint fails open — both match their single-address behavior). */
export async function getValidBalances(
  collection: string,
  addresses: string[],
): Promise<number[]> {
  if (addresses.length === 0) return []
  const values = await redis.mget<(string | number | null)[]>(
    ...addresses.map((a) => keyValidBalance(collection, a)),
  )
  return addresses.map((_, i) => parseLedgerBalance(values[i]))
}

/** True when ANY of `addresses` holds a valid Pass — the read backing the
 *  gate's identity union (hasGateAccess over expandToGateWallets). Callers
 *  pass a pre-planned list (lowercased, deduped, capped — lib/passUnion).
 *
 *  Cost shape: one MGET prefilter, then the full hasValidPass (blacklist +
 *  off-platform subtraction + live balanceOfBatch clamp) ONLY on wallets with
 *  a positive
 *  ledger — usually exactly one. The prefilter is exact, not heuristic:
 *  hasValidPass never reconciles the ledger UPWARD (on-chain holding without
 *  a platform-provenance credit never grants validity, and an admin grant
 *  always stores a positive balance), so ledger <= 0 implies hasValidPass
 *  is false and skipping it cannot change the verdict.
 *
 *  A failed prefilter falls back to checking every wallet — each
 *  hasValidPass fails closed on its own Redis/RPC errors, so a Redis outage
 *  still denies rather than admits. */
export async function hasValidPassForAny(
  collection: string,
  addresses: string[],
): Promise<boolean> {
  if (addresses.length === 0) return false
  // Single wallet — exactly the pre-union check, no MGET overhead. This is
  // every non-Farcaster caller.
  if (addresses.length === 1) return hasValidPass(collection, addresses[0])

  let candidates = addresses
  try {
    const balances = await getValidBalances(collection, addresses)
    candidates = addresses.filter((_, i) => balances[i] > 0)
  } catch {
    // MGET flake — check every wallet; each fails closed independently.
  }
  for (const address of candidates) {
    if (await hasValidPass(collection, address)) return true
  }
  return false
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

/** Attribute `units` of `tokenId` to `address` as an off-platform acquisition.
 *  HINCRBY is atomic, so concurrent transfers to the same wallet accumulate
 *  correctly. Best-effort by the caller: a missed mark means those units stay
 *  countable until the next event for that wallet, which is the same
 *  degradation the old best-effort taint had — and now confined to one wallet
 *  instead of the whole edition. */
async function markOffPlatformUnits(
  collection: string,
  address: string,
  tokenId: string,
  units: number,
): Promise<void> {
  if (!address || !tokenId || units <= 0) return
  await redis.hincrby(keyOffPlatform(collection, address), tokenId, units)
}

/** Release `units` of `tokenId` from `address` — they no longer hold them.
 *  Runs on EVERY non-mint send, platform or not: ERC-1155 copies are fungible
 *  so we cannot know which copy moved, and releasing is the lenient direction
 *  (see lib/passTaint's conservation note — over-marking would falsely revoke
 *  a legitimate holder, the exact bug this model replaced). */
async function releaseOffPlatformUnits(
  collection: string,
  address: string,
  tokenId: string,
  units: number,
): Promise<void> {
  if (!address || !tokenId || units <= 0) return
  await redis.eval(
    RELEASE_OFFPLATFORM_LUA,
    [keyOffPlatform(collection, address)],
    [tokenId, units],
  )
}

/** One holder's off-platform units, by tokenId, for hasValidPass's live
 *  reconciliation. One HGETALL — the same single command the collection-wide
 *  taint SMEMBERS cost, so the gate's per-decision command count is unchanged.
 *
 *  Fails OPEN (no marks). The ledger is the primary control and it is capped
 *  in the safe direction by construction: it only ever increments through a
 *  proven on-platform acquisition (creditValidityOnce's callers each prove one
 *  on-chain) and hasValidPass only ever clamps it DOWN. So a missing read here
 *  cannot manufacture validity — it can only fail to catch the narrow drift
 *  case where a webhook decrement was also missed. Failing CLOSED would mean a
 *  Redis blip reads every holder as fully off-platform and revokes the entire
 *  collection, which is the failure mode this whole change exists to remove. */
async function getOffPlatformUnits(
  collection: string,
  address: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  try {
    const hash = await redis.hgetall<Record<string, string | number>>(
      keyOffPlatform(collection, address),
    )
    if (!hash) return out
    for (const [tokenId, raw] of Object.entries(hash)) {
      const units = parseUnitCount(raw)
      if (units > 0) out.set(tokenId, units)
    }
  } catch {
    // fail open — see above
  }
  return out
}

/** Process a single Transfer event for the gate's Pass collection. Idempotent
 *  via processed-key (tx:logIdx:subIdx). Aggregates validity across all
 *  tokenIds in the collection — every Pass tokenId grants access. Auto-
 *  discovers tokenIds for later live-balance reconciliation.
 *
 *  Four rules, derived from the "valid pass" definition (acquired through
 *  mint / airdrop / Kismet secondary, with every link on-platform). The
 *  arithmetic for 1, 3 and 4 lives in lib/passTaint.planTransferEffects so it
 *  can be unit-pinned; this function does the I/O around it.
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
 *  3. An OFF-PLATFORM non-mint transfer records the moved units against the
 *     RECEIVER (keyOffPlatform), and hasValidPass subtracts them from the
 *     balance that receiver may prove. Per holder and per unit: it denies the
 *     wallet that left the sanctioned chain without touching any other holder
 *     of the same edition.
 *  4. EVERY non-mint transfer releases the same units from the SENDER, whether
 *     or not it was platform-flagged — they no longer hold the copies. This is
 *     what keeps provenance attached to copies rather than branding a wallet
 *     forever, and it is why an off-platform copy resold through Kismet comes
 *     out clean for its buyer (the seller stays revoked by rule 1).
 *
 *  SUPERSEDED: rule 3 used to mark the tokenId itself, collection-wide. On an
 *  edition that revoked every holder of the id and blocked every future mint
 *  of a live sale, from one holder's sale. lib/passTaint.ts documents the
 *  change in full; scripts/verify-pass-taint.ts pins it. */
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
  // flagged `to` for some OTHER tokenId — reads false, so its units are
  // recorded against the receiver as off-platform and it isn't credited.
  const platform = await isPlatformTx(txHash, to, tokenId)
  const isMint = from === ZERO_ADDRESS

  // Race-condition guard: check whether `from` has an active Kismet listing
  // for this tokenId. If so, treat it as platform-originated even without
  // the platform-tx flag — the listing was created before the transfer,
  // proving a Kismet secondary sale was in flight. Without this, a webhook
  // that fires before the listing PATCH's after() callbacks set the
  // platform-tx flag would falsely mark the BUYER as an off-platform
  // acquirer, denying validity for a sale that was fully on-platform.
  // Keyed on (collection, tokenId, from/seller) to avoid shielding a
  // concurrent off-platform sale by a different holder of the same tokenId.
  const listedOnKismet =
    !isMint && !platform && tokenId
      ? !!(await redis.get(keyKismetListed(collection, tokenId, from)).catch(() => null))
      : false

  // The whole per-transfer decision, derived in one pure place so it can be
  // unit-pinned (lib/passTaint + scripts/verify-pass-taint.ts) rather than
  // re-read out of interleaved branches here.
  const effects = planTransferEffects({
    amount,
    isMint,
    isPlatform: platform,
    isKismetListed: listedOnKismet,
    toIsBurn: !to || to === ZERO_ADDRESS,
  })

  // Any-transfer-revokes invariant: `from`'s decrement runs UNCONDITIONALLY
  // for any non-mint Transfer event — OpenSea sale, direct Seaport fill, P2P
  // safeTransferFrom (e.g. sending to a different wallet you own), burn, all
  // the same. The platform flag only affects whether `to` is credited, never
  // whether `from` is decremented. Live reconciliation in hasValidPass is a
  // second layer: if this webhook event is missed, the ledger>on-chain clamp
  // still revokes once the seller no longer holds the token.
  if (effects.decrementFrom > 0) {
    await adjustValidBalance(collection, from, -effects.decrementFrom)
  }

  // Sender no longer holds these copies, so any off-platform units recorded
  // against them are released. Runs on platform-flagged sends too — the copy
  // leaves either way — which is what lets an off-platform copy be laundered
  // clean by a Kismet secondary sale. That is the deliberate softening this
  // model accepts in exchange for not punishing bystanders: the seller is
  // still revoked, and the buyer paid on Kismet, which the Mint Pass Ruleset
  // already calls a valid acquisition.
  if (effects.releaseFrom > 0 && tokenId) {
    try {
      await releaseOffPlatformUnits(collection, from, tokenId, effects.releaseFrom)
    } catch {
      // Best-effort: a missed release leaves stale units against a wallet that
      // no longer holds them, which can under-count a LATER legitimate
      // acquisition by that same wallet. Self-heals on their next send of this
      // tokenId, and admin can clear it via DELETE /api/admin/taint.
    }
  }

  // Off-platform acquisition: attribute the units to the RECEIVER, and only
  // the receiver. This is the whole fix — the superseded rule marked the
  // tokenId, so one holder's OpenSea sale revoked every other holder of the
  // edition and blocked every future mint of it (see lib/passTaint).
  if (effects.markTo > 0 && tokenId) {
    try {
      await markOffPlatformUnits(collection, to, tokenId, effects.markTo)
    } catch {
      // Best-effort. A missed mark leaves this acquirer's units countable —
      // but they still hold no ledger credit (an off-platform transfer is
      // never credited below), so it grants nothing on its own. It only
      // matters if that wallet later earns a legitimate credit, and the next
      // off-platform event for them re-establishes the count.
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
  // (both fire) never double-credits, and its pass-blacklist check still
  // applies. Provenance is NOT re-checked here: a mint is the genesis of a
  // copy, so there is no prior owner to launder from (see creditValidityOnce).
  //
  // PLATFORM (non-mint): a Kismet collect / airdrop / secondary fill, proven
  // by the per-(recipient, tokenId) flag. listedOnKismet is intentionally
  // excluded from the credit condition: the listing PATCH handler calls
  // creditValidityOnce synchronously before the response (primary credit),
  // and recordPlatformTx in after() ensures the webhook converges via the
  // platform flag. Allowing listedOnKismet to also trigger credit opened an
  // exploit: an attacker could list a Pass on Kismet (sets the flag) then
  // transfer it off-platform to an accomplice; the webhook would see
  // listedOnKismet=true, skip the off-platform mark, and credit the accomplice
  // for free. The flag's sole remaining job is suppressing a false
  // off-platform mark during the race window.
  if (platform || isMint) {
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
 * Provenance is enforced at READ time (hasValidPass subtracts off-platform
 * units), not here — see the note in the body for why that is both safe and
 * strictly more precise than the token-scoped refusal it replaced.
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
  // Reject a missing tokenId outright. Without it (a) keyCredited loses its
  // per-token dimension, so two different tokens acquired in the SAME tx share
  // one idempotency slot and the second credit is silently dropped, and (b) the
  // known-tokens SADD is skipped, leaving hasValidPass with nothing to
  // reconcile against — `knownIds.length === 0` makes it trust the ledger
  // blindly, with no live balance check and no off-platform subtraction. No
  // caller passes an empty id today (all canonicalize via BigInt().toString());
  // this closes the latent footgun.
  if (amount <= 0 || !address || !txHash || !tokenId) return

  if (await isPassBlacklisted(address)) return

  // NO PROVENANCE CHECK HERE — deliberate, and the reasoning matters.
  //
  // This used to refuse any credit for a tokenId that had ever been moved
  // off-platform by ANYONE. That check could not distinguish the wallet that
  // left the platform from the 99 that didn't, so on an edition it denied
  // every future buyer of a still-open sale. Removing it costs nothing,
  // because every caller of this function has already PROVEN an on-platform
  // acquisition on-chain before arriving:
  //    /api/collect            verifyMintOnChain  (TransferSingle 0x0 -> account)
  //    /api/airdrop/notify     verifyAirdropOnChain (operator===sender, from 0x0)
  //    /api/listings/[id]      findFulfillmentInLogs + recipient===signer
  //    lib/mint-proxy          the relayed mint it just executed
  //    processTransfer         the mint arm (genesis) or the per-(recipient,
  //                            tokenId) platform flag
  // None of those is an off-platform acquisition, so the check never fired on
  // a legitimate path — its only live effect was the collateral denial.
  //
  // Enforcement now has exactly ONE point instead of two that could disagree:
  // hasValidPass subtracts a holder's off-platform units from the balance they
  // are allowed to prove. That is strictly more precise than a boolean refusal
  // and it is applied at gate-decision time, so there is no window between a
  // credit and its enforcement. The resulting invariant is
  //   ledger <= min(proven on-platform acquisitions, on-chain balance minus
  //                 off-platform units)
  // because the ledger only increments through the proven paths above and
  // hasValidPass only ever clamps DOWN.
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
  // Two SMEMBERS-class reads in parallel — the same command count the
  // collection-wide taint lookup cost, now scoped to THIS holder.
  const [knownIds, offPlatform] = await Promise.all([
    getKnownTokenIds(collection),
    getOffPlatformUnits(collection, address),
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
    // Count only what this holder acquired on-platform. Without the
    // subtraction, a holder whose copies are all off-platform (e.g. a
    // legitimate ledger that drifted because the webhook missed a decrement,
    // then an OpenSea purchase) would have live >= ledger → no clamp → keep
    // validity from an off-platform source.
    //
    // Per-holder and per-UNIT, which is the whole point: the superseded rule
    // dropped the entire id for everyone, so one holder's sale revoked the
    // edition — and a hostile party could revoke any patron just by SENDING
    // them a pass. Here an unsolicited copy is discounted and the holder's own
    // copy still counts. countableUnits + scripts/verify-pass-taint.ts pin it.
    for (let i = 0; i < balances.length; i++) {
      liveTotal += countableUnits(balances[i], offPlatform.get(knownIds[i]) ?? 0)
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

/** One holder's off-platform units, for the admin inspection endpoint.
 *  Returns `{ tokenId: units }`, empty when the wallet is clean. */
export async function listOffPlatformUnits(
  collection: string,
  address: string,
): Promise<Record<string, number>> {
  const units = await getOffPlatformUnits(collection, address)
  const out: Record<string, number> = {}
  for (const tokenId of Array.from(units.keys()).sort()) {
    out[tokenId] = units.get(tokenId) as number
  }
  return out
}

/** Clear a holder's off-platform units for one tokenId. Admin escape-hatch for
 *  a false mark — e.g. a legitimate Kismet secondary sale whose keyKismetListed
 *  flag was missing (Redis down at listing creation), which would otherwise
 *  discount the buyer's copy.
 *
 *  Unlike the token-scoped remediation it replaces, this is usually sufficient
 *  on its own: clearing the mark makes the holder's balance countable again on
 *  the very next gate decision. It does NOT re-run a credit that was skipped
 *  for some other reason (blacklist, a lost webhook) — those still need
 *  setValidBalance. */
export async function clearOffPlatformUnits(
  collection: string,
  address: string,
  tokenId: string,
): Promise<void> {
  if (!collection || !address || !tokenId) return
  await redis.hdel(keyOffPlatform(collection, address), tokenId)
}

/** MIGRATION ONLY — read the superseded token-scoped taint set so an operator
 *  can see what the old model had accumulated before clearing it. Nothing in
 *  the request path consults this any more. */
export async function listLegacyTaintedTokenIds(collection: string): Promise<string[]> {
  try {
    const members = (await redis.smembers(keyLegacyTainted(collection))) as string[]
    return Array.isArray(members) ? members.sort() : []
  } catch {
    return []
  }
}

/** MIGRATION ONLY — drop the superseded token-scoped taint set. Safe once the
 *  new model is deployed: no read path references it, and the denials it used
 *  to provide for the wallets that actually left the platform are already
 *  carried by their zeroed ledgers (an off-platform acquirer is never
 *  credited). What it stops providing is the collateral denial of everyone
 *  else — which is the point. */
export async function clearLegacyTaint(collection: string): Promise<void> {
  if (!collection) return
  await redis.del(keyLegacyTainted(collection))
}
