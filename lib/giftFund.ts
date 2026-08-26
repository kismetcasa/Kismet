/**
 * Gift Fund — the pure decision layer for community-backed gifts.
 *
 * A gift fund is REIMBURSEMENT, not escrow: the organizer has already
 * executed the gift (a primary mint to the recipient, verified on-chain by
 * the campaign-open route), and backers send plain ETH straight to the
 * organizer's wallet. The platform verifies each transfer against the chain
 * and renders progress — it never holds funds, so there is nothing to
 * refund and no execution to fail. An underfunded campaign means the
 * organizer absorbed the difference on a gift that already happened.
 *
 * This module holds every rule that decides whether an UNAUTHENTICATED
 * claim (a txHash anyone can POST) becomes a credited contribution, and
 * from whom. The claim route derives the backer FROM THE CHAIN — there is
 * no claimed-backer field to spoof, and a third party submitting someone
 * else's transfer merely surfaces a real contribution correctly attributed.
 * Two verification tiers feed these rules:
 *
 *   - RECEIPT tier (every EOA backer): the transaction itself pays the
 *     organizer — `tx.to == organizer`, `tx.value` is the amount.
 *   - TRACE tier (smart-wallet / ERC-4337 backers, whose top-level tx goes
 *     to the EntryPoint): internal calls are inspected, and ONLY a direct
 *     value-call whose CALLER is a `UserOperationEvent.sender` of that same
 *     receipt counts. That binding is what stops protocol contracts from
 *     becoming backers: in a Seaport fill the value reaches the organizer
 *     from Seaport's conduit — not from any userOp sender — so it yields
 *     nothing, and a listing purchase can never be laundered into a
 *     "contribution".
 *
 * Zero imports on purpose — the passUnion/gateFlags/passTaint pattern — so
 * scripts/verify-gift-fund.ts can pin every rule under
 * `node --experimental-strip-types` without loading redis or viem.
 */

/** Floor on a countable contribution. Dust below this is rejected rather
 *  than listed: the backer roll is a social surface, and a 0-cost spam
 *  entry would otherwise be the cheapest way onto it. 0.0001 ETH. */
export const MIN_CONTRIBUTION_WEI = 100_000_000_000_000n

/** How long after a campaign closes a transfer made DURING the window may
 *  still be claimed. Acceptance is by transfer time, not claim time — a
 *  contribution sent at 11:59 must not be lost because its POST landed at
 *  12:01 — but the claim surface cannot stay open forever, so late claims
 *  get one week. */
export const CLAIM_GRACE_MS = 7 * 24 * 60 * 60 * 1000

/** Landing slack on the transfer clock itself. A send fired moments before
 *  the window closed (or before the organizer's early close) lands with a
 *  block timestamp AFTER it — the chain can't say when it was SENT, only
 *  when it landed. Rejecting those loses real money that reached the
 *  organizer, the one failure shape the design treats as unacceptable, so
 *  transfers landing within this slack of the close still count. Bounded
 *  well under CLAIM_GRACE_MS, so the claim clock is unaffected. */
export const TRANSFER_LANDING_GRACE_MS = 15 * 60 * 1000

export type CampaignStatus = 'open' | 'funded' | 'expired'

/**
 * A campaign's display status from its stored facts. Monotonic by
 * construction: `goalWei` is frozen at open (sale prices are editable —
 * lib/saleEdit — so a re-read goal could move the bar) and `raisedWei` only
 * grows, so 'funded' can never regress. 'funded' outranks 'expired':
 * reaching the goal is terminal success even if noticed after the window.
 */
export function campaignStatus(params: {
  raisedWei: bigint
  goalWei: bigint
  closesAtMs: number
  nowMs: number
}): CampaignStatus {
  if (params.goalWei > 0n && params.raisedWei >= params.goalWei) return 'funded'
  return params.nowMs > params.closesAtMs ? 'expired' : 'open'
}

/** May a claim still be POSTed, and may the transfer it names count?
 *  Two separate clocks: the TRANSFER must have landed inside the campaign
 *  window (plus the landing slack — a send can't land before it was sent,
 *  but it can land after the window shut on it mid-flight); the CLAIM may
 *  arrive up to CLAIM_GRACE_MS later. */
export function transferWithinWindow(params: {
  blockTimestampMs: number
  openedAtMs: number
  closesAtMs: number
}): boolean {
  return (
    params.blockTimestampMs >= params.openedAtMs &&
    params.blockTimestampMs <= params.closesAtMs + TRANSFER_LANDING_GRACE_MS
  )
}

export function claimWindowOpen(params: { closesAtMs: number; nowMs: number }): boolean {
  return params.nowMs <= params.closesAtMs + CLAIM_GRACE_MS
}

const isHexAddress = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

export interface VerifiedContribution {
  /** The wallet that actually paid, lowercased — derived, never claimed. */
  backer: string
  amountWei: bigint
}

/**
 * RECEIPT tier: the plain-send shape every EOA wallet produces. Accepts only
 * a transaction whose top-level `to` IS the organizer — value reaching the
 * organizer any other way belongs to the trace tier, where the caller
 * binding applies.
 */
export function evaluateReceiptTransfer(params: {
  txFrom: string
  txTo: string | null | undefined
  valueWei: bigint
  organizer: string
}): VerifiedContribution | null {
  const { txFrom, txTo, valueWei, organizer } = params
  if (!isHexAddress(txFrom) || !isHexAddress(txTo)) return null
  if (txTo.toLowerCase() !== organizer.toLowerCase()) return null
  if (valueWei < MIN_CONTRIBUTION_WEI) return null
  return { backer: txFrom.toLowerCase(), amountWei: valueWei }
}

/** One internal call, as reported by a callTracer frame or an Etherscan
 *  txlistinternal row: who sent value, to whom, how much. */
export interface TracedCall {
  from: string
  to: string
  valueWei: bigint
}

/** A geth callTracer frame — nested calls, hex value. Only the fields the
 *  flattening rules read. */
export interface TraceFrame {
  type?: string
  from?: string
  to?: string
  /** Hex wei string. */
  value?: string
  /** Set when this frame reverted (e.g. "execution reverted"). */
  error?: string
  calls?: TraceFrame[]
}

/**
 * Flatten a callTracer tree to the calls that ACTUALLY MOVED ETH. Two rules,
 * each closing a way to fabricate a contribution from a trace:
 *
 *   - ONLY type CALL moves ETH. DELEGATECALL and CALLCODE execute foreign
 *     code in the caller's context and can carry an inherited `value` field
 *     while transferring NOTHING — a smart account delegatecalling the
 *     organizer's EOA address would produce a frame {from: account, to:
 *     organizer, value: X} with no ETH moved, i.e. a free fake contribution
 *     if counted. SELFDESTRUCT can move real value but its `from` is the
 *     destructed contract, never a userOp sender, so excluding it only
 *     under-credits (the safe direction). The root frame of any tx is type
 *     CALL, so the EOA-shaped case is unaffected.
 *   - A REVERTED SUBTREE moved nothing. A frame carrying `error` reverted,
 *     and the revert rolled back every transfer beneath it — including child
 *     CALLs that succeeded locally before the parent reverted (those child
 *     frames carry no error of their own). A wallet that sends the organizer
 *     ETH inside a helper, reverts the helper, and catches the revert would
 *     otherwise be credited for money that never left it.
 */
export function flattenValueCalls(frame: TraceFrame, out: TracedCall[]): TracedCall[] {
  if (frame.error) return out
  const value = frame.value ? BigInt(frame.value) : 0n
  if (frame.type === 'CALL' && frame.from && frame.to && value > 0n) {
    out.push({ from: frame.from, to: frame.to, valueWei: value })
  }
  for (const sub of frame.calls ?? []) flattenValueCalls(sub, out)
  return out
}

/**
 * TRACE tier: internal calls from a smart-wallet transaction. The rule that
 * carries all the security weight: a call counts ONLY when its `from` is one
 * of the receipt's `UserOperationEvent` senders — the smart account whose
 * user actually signed this operation. Calls from anything else (Seaport
 * conduits, splits contracts, routers) yield nothing, whatever value they
 * moved. Multiple qualifying calls from the same sender sum (a batched
 * wallet op may split the send); the minimum applies to the SUM, so a
 * split send is not rejected piecewise. When several userOp senders paid in
 * one bundle (unusual but legal), the largest contributor is credited —
 * one claim, one backer, and the others can claim their own tx… which is
 * this same tx, already NX-claimed. Deliberate: a shared-bundle edge this
 * rare gets the simple rule, not a multi-credit path.
 */
export function evaluateTracedTransfer(params: {
  calls: TracedCall[]
  userOpSenders: string[]
  organizer: string
}): VerifiedContribution | null {
  const organizer = params.organizer.toLowerCase()
  const senders = new Set(
    params.userOpSenders.filter(isHexAddress).map((s) => s.toLowerCase()),
  )
  if (senders.size === 0) return null

  const bySender = new Map<string, bigint>()
  for (const call of params.calls) {
    if (!isHexAddress(call.from) || !isHexAddress(call.to)) continue
    if (call.to.toLowerCase() !== organizer) continue
    const from = call.from.toLowerCase()
    if (!senders.has(from)) continue
    if (call.valueWei <= 0n) continue
    bySender.set(from, (bySender.get(from) ?? 0n) + call.valueWei)
  }

  let best: VerifiedContribution | null = null
  for (const [backer, amountWei] of bySender) {
    if (amountWei < MIN_CONTRIBUTION_WEI) continue
    if (!best || amountWei > best.amountWei) best = { backer, amountWei }
  }
  return best
}

/**
 * Which userOp paid for a mint, in a possibly-SHARED bundler transaction.
 *
 * A smart-wallet gift submitted through a public bundler can land in one tx
 * with strangers' operations — refusing every multi-op receipt as ambiguous
 * would make such gifts un-fundable through no fault of the gifter. The
 * EntryPoint executes ops in order and emits each op's UserOperationEvent
 * AFTER that op's own logs, so log order is the attribution: the mint's
 * payer is the sender of the FIRST UserOperationEvent whose logIndex is
 * greater than the mint log's. No event after the mint (malformed receipt)
 * → null, and the caller refuses rather than guesses.
 */
export function payerForMint(params: {
  userOpEvents: { sender: string; logIndex: number }[]
  mintLogIndex: number
}): string | null {
  let best: { sender: string; logIndex: number } | null = null
  for (const ev of params.userOpEvents) {
    if (!isHexAddress(ev.sender)) continue
    if (ev.logIndex <= params.mintLogIndex) continue
    if (!best || ev.logIndex < best.logIndex) best = ev
  }
  return best ? best.sender.toLowerCase() : null
}

/**
 * Parse a decimal wei string from storage. Same dual-representation caution
 * as every other Upstash-backed number in this codebase (gateFlags,
 * passUnion, passTaint): accept string or number, read garbage as 0n so a
 * corrupt field can only under-report progress, never fabricate it.
 */
export function parseWei(v: unknown): bigint {
  if (typeof v === 'bigint') return v >= 0n ? v : 0n
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return BigInt(Math.floor(v))
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    try {
      return BigInt(v)
    } catch {
      return 0n
    }
  }
  return 0n
}

/** Progress for the bar: integer percent, capped at 100. Overshoot (tips
 *  past the goal) reports 100 — the bar is monotonic and never wraps. */
export function progressPercent(raisedWei: bigint, goalWei: bigint): number {
  if (goalWei <= 0n) return 0
  if (raisedWei >= goalWei) return 100
  return Number((raisedWei * 100n) / goalWei)
}
