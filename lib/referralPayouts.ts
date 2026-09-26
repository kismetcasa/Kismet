import 'server-only'
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, parseAbi, type Address } from 'viem'
import { redis } from './redis'
import { serverBaseClient } from './rpc'
import { KISMET_REFERRAL } from './zoraMint'
import type { DeliveryReceipt } from './experience/delivery'

/**
 * Referral rewards, paid out without anyone having to claim them.
 *
 * Zora credits a mint's ETH rewards — the mint referral, the create referral,
 * the creator's share of a free mint — to a balance in its ProtocolRewards
 * contract rather than sending them, so they reach a wallet only when someone
 * withdraws. Its `withdrawFor(owner, 0)` may be called by ANYONE and always
 * pays the owner's whole balance to the owner, so Kismet can do it for every
 * address it routes referrals to: its own treasury, and each reveal machine's
 * curator. USDC referrals need none of this — the ERC20 minter transfers them
 * at mint.
 */

/** Zora's ProtocolRewards on Base (zora-protocol legacy/1155-contracts
 *  chainConfigs/8453.json; the same address In Process's fork points at). */
export const PROTOCOL_REWARDS: Address = '0x7777777F279eba3d3Ad8F4E708545291A6fDBA8B'
export const PROTOCOL_REWARDS_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function withdrawFor(address to, uint256 amount)',
])

/** Below this a balance waits for the next run: about one and a half paid
 *  collects' mint referral (0.0000317 ETH each), so a payout is always many
 *  times the sponsored gas it costs on Base. */
export const MIN_PAYOUT_WEI = 50_000_000_000_000n
/** Bounds one run's broadcasts; anything left is paid by the next run. */
export const MAX_PAYOUTS_PER_RUN = 25

/** Who to pay this run, largest balance first. Pure, so the oracle can pin it. */
export function planPayouts(
  balances: { address: string; balance: bigint }[],
  min: bigint = MIN_PAYOUT_WEI,
  max: number = MAX_PAYOUTS_PER_RUN,
): { address: string; balance: bigint }[] {
  return balances
    .filter((b) => b.balance >= min)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
    .slice(0, max)
}

/** Every address a referral may have been routed to: Kismet's, and the
 *  curators it named. Deduplicated, lowercased, Kismet's first. */
export function payoutAddresses(curators: string[]): string[] {
  return [...new Set([KISMET_REFERRAL, ...curators].map((a) => a.toLowerCase()))]
}

/** Escrowed balances, one multicall. Unreadable entries are left out: a
 *  balance nobody could read is not a payout anyone should send. */
export async function readRewardBalances(addresses: string[]): Promise<{ address: string; balance: bigint }[]> {
  if (addresses.length === 0) return []
  const results = await serverBaseClient().multicall({
    contracts: addresses.map((a) => ({
      address: PROTOCOL_REWARDS,
      abi: PROTOCOL_REWARDS_ABI,
      functionName: 'balanceOf' as const,
      args: [a as Address] as const,
    })),
    allowFailure: true,
  })
  const out: { address: string; balance: bigint }[] = []
  results.forEach((r, i) => {
    if (r.status === 'success') out.push({ address: addresses[i], balance: r.result as bigint })
  })
  return out
}

/** Would `withdrawFor(owner, 0)` go through? It reverts when the owner is a
 *  contract that refuses ETH, and a reverted userOp still spends sponsored gas,
 *  so each payout is simulated from the sending account first. A simulation
 *  that could not run at all is `unreadable`, not a revert: both are skipped,
 *  but only one says something about the owner's wallet. */
export async function checkPayout(owner: string, from: string): Promise<'ok' | 'reverts' | 'unreadable'> {
  try {
    await serverBaseClient().simulateContract({
      account: from as Address,
      address: PROTOCOL_REWARDS,
      abi: PROTOCOL_REWARDS_ABI,
      functionName: 'withdrawFor',
      args: [owner as Address, 0n],
    })
    return 'ok'
  } catch (err) {
    return err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError) ? 'reverts' : 'unreadable'
  }
}

export function withdrawForCall(owner: string): { to: Address; data: `0x${string}` } {
  return {
    to: PROTOCOL_REWARDS,
    data: encodeFunctionData({ abi: PROTOCOL_REWARDS_ABI, functionName: 'withdrawFor', args: [owner as Address, 0n] }),
  }
}

// ─── ledger ──────────────────────────────────────────────────────────────────
//
// A payout is broadcast, not awaited, so the chain is the record of whether it
// happened — and a record nobody reads is not an audit trail. Each payout is
// kept by its userOp hash as `sent`; the next run asks what became of it and
// settles it `landed` (adding it to the owner's paid total) or `failed`. The
// ledger is written only by the payout run, under its lock.

const K_OPS = 'kismetart:referral-payouts:ops'
const K_PAID = 'kismetart:referral-payouts:paid'
/** Totals are stored as `wei:<digits>`: the Upstash client turns a bare
 *  numeric string back into a JS number, which is exact only below 2^53 wei
 *  (about 0.009 ETH) — a total past that would silently lose precision. */
const toStored = (wei: bigint) => `wei:${wei}`
const fromStored = (v: unknown): bigint => {
  const s = String(v ?? '')
  return s.startsWith('wei:') ? BigInt(s.slice(4)) : 0n
}
/** Settled entries are pruned after this long; unsettled ones are kept. */
const LEDGER_DAYS = 30

interface LedgerEntry {
  address: string
  amount: string
  at: number
  status: 'sent' | 'landed' | 'failed'
  txHash?: string
}

export async function recordPayout(p: { address: string; amount: bigint; userOpHash: string }): Promise<void> {
  const entry: LedgerEntry = { address: p.address, amount: p.amount.toString(), at: Date.now(), status: 'sent' }
  await redis.hset(K_OPS, { [p.userOpHash]: JSON.stringify(entry) })
}

/** Settle every `sent` payout the chain has answered for. A landed payout adds
 *  its amount to the owner's paid total — the figure a curator is shown. */
export async function reconcilePayouts(
  read: (userOpHash: string) => Promise<DeliveryReceipt>,
): Promise<{ landed: number; failed: number; waiting: number; expired: number }> {
  const raw = (await redis.hgetall<Record<string, LedgerEntry | string>>(K_OPS)) ?? {}
  const counts = { landed: 0, failed: 0, waiting: 0, expired: 0 }
  const cutoff = Date.now() - LEDGER_DAYS * 86_400_000
  for (const [hash, v] of Object.entries(raw)) {
    let entry: LedgerEntry
    try {
      entry = typeof v === 'string' ? (JSON.parse(v) as LedgerEntry) : v
    } catch {
      continue
    }
    if (entry.status !== 'sent') {
      if (entry.at < cutoff) await redis.hdel(K_OPS, hash)
      continue
    }
    const outcome = await read(hash)
    if (outcome.kind === 'landed') {
      const paid = fromStored(await redis.hget(K_PAID, entry.address))
      await redis.hset(K_PAID, { [entry.address]: toStored(paid + BigInt(entry.amount)) })
      await redis.hset(K_OPS, { [hash]: JSON.stringify({ ...entry, status: 'landed', txHash: outcome.txHash }) })
      counts.landed++
    } else if (outcome.kind === 'failed') {
      await redis.hset(K_OPS, { [hash]: JSON.stringify({ ...entry, status: 'failed' }) })
      counts.failed++
    } else if (entry.at < cutoff) {
      // Nobody can say what became of it — the operation is no longer known —
      // so stop asking. The payout itself is on-chain or not regardless; only
      // the paid-so-far figure can miss it.
      await redis.hdel(K_OPS, hash)
      counts.expired++
    } else {
      counts.waiting++
    }
  }
  return counts
}

/** Referral rewards Kismet has confirmed paid into this address's wallet. */
export async function paidTo(address: string): Promise<bigint> {
  return fromStored(await redis.hget(K_PAID, address.toLowerCase()))
}
