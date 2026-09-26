import 'server-only'
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, parseAbi, type Address } from 'viem'
import { serverBaseClient } from './rpc'
import { KISMET_REFERRAL } from './zoraMint'

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
