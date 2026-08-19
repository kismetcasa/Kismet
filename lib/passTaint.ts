/**
 * Pass provenance — the pure arithmetic behind off-platform unit accounting.
 *
 * WHAT THIS REPLACES. The gate used to mark a whole tokenId as "tainted" the
 * moment ANY holder moved a copy off-platform, and then
 *   - excluded that id from every holder's live balance (hasValidPass), and
 *   - refused every future credit for that id (creditValidityOnce).
 * That is sound for a 1-of-1. It is structurally wrong for an edition: the
 * Patron drops are 19 and 100 copies of ONE id, so one holder selling on
 * OpenSea revoked every other holder of that edition AND left every
 * subsequent primary mint of a still-open sale crediting nobody. The blast
 * radius was the entire drop, from an action the Mint Pass Ruleset says
 * invalidates only the mover's own pass.
 *
 * WHAT REPLACES IT. Provenance is tracked per (holder, tokenId) as a COUNT OF
 * UNITS acquired off-platform, and the gate subtracts those units from what
 * that holder's balance is allowed to prove. Nobody else is touched.
 *
 * WHY UNITS AND NOT A BOOLEAN MARK. A per-(holder, tokenId) boolean is the
 * obvious form and it is a griefing vector: excluding a marked holder's whole
 * id-balance means anyone can revoke a legitimate patron by SENDING them a
 * pass they never asked for. Counting units closes it — the unsolicited copy
 * is discounted and the holder's own copy still counts (see countableUnits).
 * That case is pinned in scripts/verify-pass-taint.ts.
 *
 * CONSERVATION. Units are released from the sender on every non-mint transfer
 * and attributed to the receiver only when the transfer was off-platform, so
 * an off-platform unit follows the copy instead of branding a wallet forever.
 * Because ERC-1155 copies are fungible we cannot know WHICH copy moved, so
 * release is unconditional — deliberately the lenient direction. Over-marking
 * would falsely revoke a legitimate holder, which is precisely the bug class
 * this module exists to end; under-marking can at most let a holder keep
 * validity they already earned through a proven on-platform acquisition,
 * because the ledger only ever increments on proven acquisitions and
 * hasValidPass only ever clamps it DOWN.
 *
 * Zero imports on purpose — same pattern as lib/passUnion and lib/gateFlags,
 * so scripts/verify-pass-taint.ts can pin every rule under
 * `node --experimental-strip-types` without loading redis.
 */

/** What one Transfer event does to the two wallets it touches. */
export interface TransferEffects {
  /** Units to subtract from the sender's validity ledger. The
   *  any-transfer-revokes invariant: unconditional on every non-mint
   *  transfer, off-platform or not. */
  decrementFrom: number
  /** Off-platform units the sender no longer holds, released from their
   *  provenance record (clamped at 0 by the caller). */
  releaseFrom: number
  /** Off-platform units to attribute to the receiver. Non-zero only when the
   *  transfer left the sanctioned chain. */
  markTo: number
}

const NO_EFFECTS: TransferEffects = { decrementFrom: 0, releaseFrom: 0, markTo: 0 }

/**
 * The complete per-transfer decision, derived from the same four facts
 * processTransfer already establishes on-chain.
 *
 * `isMint` (from == 0x0) is the genesis of a copy: there is no sender to
 * decrement and the recipient's acquisition is on-platform by definition, so
 * a mint has no effects here at all. That is what makes a collect-and-gift
 * safe (lib/gift.ts) — it is a mint, so it can never mark anyone.
 *
 * `isPlatform` is the per-(recipient, tokenId) platform-tx flag; `isKismetListed`
 * is the race guard for a Kismet secondary sale whose flag hasn't landed yet.
 * Either one means the copy never left the sanctioned chain, so the receiver
 * is not marked — but the sender is still decremented and released, because
 * they genuinely no longer hold it.
 *
 * `toIsBurn` suppresses marking the zero address on a burn: nothing holds
 * those units afterwards, so recording provenance against 0x0 is noise.
 */
export function planTransferEffects(params: {
  amount: number
  isMint: boolean
  isPlatform: boolean
  isKismetListed: boolean
  toIsBurn: boolean
}): TransferEffects {
  const { amount, isMint, isPlatform, isKismetListed, toIsBurn } = params
  if (!Number.isFinite(amount) || amount <= 0) return NO_EFFECTS
  if (isMint) return NO_EFFECTS
  const units = Math.floor(amount)
  const leftPlatform = !isPlatform && !isKismetListed
  return {
    decrementFrom: units,
    releaseFrom: units,
    markTo: leftPlatform && !toIsBurn ? units : 0,
  }
}

/**
 * How much of an on-chain balance may prove validity: everything except the
 * units this holder acquired off-platform. Never negative.
 *
 * This is the single enforcement point for provenance at read time. It
 * replaces the old "skip the whole id" exclusion, and the difference is the
 * entire fix: a holder with one legitimate copy and one unsolicited
 * off-platform copy counts 1, where the old rule counted 0 and revoked them.
 */
export function countableUnits(balance: bigint, offPlatform: number): bigint {
  if (!Number.isFinite(offPlatform) || offPlatform <= 0) return balance
  const off = BigInt(Math.floor(offPlatform))
  return balance > off ? balance - off : 0n
}

/** Sender-side release, clamped at zero. Mirrors the Lua that performs it
 *  atomically in Redis, so the two can be compared and kept in step. */
export function releaseUnits(current: number, amount: number): number {
  const cur = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0
  const amt = Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0
  return cur > amt ? cur - amt : 0
}

/**
 * Parse a stored unit count. Upstash SETs numbers as strings but JSON-parses
 * them back on GET, so a field written by HINCRBY can read as either `2` or
 * `'2'` — the same dual-representation trap lib/gateFlags and
 * lib/passUnion.parseLedgerBalance guard for. Anything unparseable, negative,
 * or absent reads as 0, which is the safe direction here: it means "no
 * off-platform units", so a corrupt field can never falsely revoke a holder.
 */
export function parseUnitCount(v: unknown): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseInt(String(v), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}
