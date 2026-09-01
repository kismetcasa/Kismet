import 'server-only'
import { concat, encodeFunctionData, type Address, type Hex } from 'viem'
import { COLLECTION_ABI } from '../collections'
import { BUILDER_DATA_SUFFIX } from '../builderCode'
import { serverBaseClient } from '../rpc'
import { acquireLock } from '../redisLock'

/**
 * Prize delivery: a server-signed `adminMint` of the drawn artwork to the
 * player, sponsored by a paymaster so the win costs them nothing.
 *
 * `adminMint` is `nonpayable`, so unlike a collect this carries no Zora protocol
 * fee — the player pays for the capsule and receives the artwork free of any
 * further cost. Gas is the paymaster's.
 *
 * ── A DEDICATED CDP account, not the Scout spender ──
 *
 * lib/agent/scout/spender.ts serialises every send behind a Redis mutex keyed on
 * the spender's own address, so sharing that account would queue prize delivery
 * behind autonomous collects — unacceptable inside a live reveal. It is also
 * bound by a startup assertion to NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS, which we
 * must not disturb. A separate named account gets its own lock for free and
 * keeps a compromise of one out of the other.
 *
 * ── The three failure modes, and why they must stay distinguishable ──
 *
 * Reading the Scout's implementation shows they separate cleanly, and the
 * distinction IS the design:
 *
 *   sponsorship-denied  throws BEFORE any userOpHash exists
 *   on-chain revert     surfaces from the wait, WITH a hash
 *   indeterminate       the wait times out, WITH a hash and no verdict
 *
 * The third is the dangerous one: we genuinely cannot tell whether the player
 * received their artwork. The Scout's own comment names the stakes — a
 * slow-but-landed mint counted as a skip means "user gets the NFT, /api/collect
 * never records it". So this module NEVER retries an indeterminate send.
 * `reconcileDelivered` reads the chain instead, and only a definitive
 * zero-balance authorises another mint. Blind retry is the single action that
 * can mint twice for one payment.
 */

const BALANCE_OF_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const

export type DeliveryOutcome =
  /** Confirmed on-chain. */
  | { kind: 'delivered'; txHash: string; userOpHash: string }
  /** Sponsorship refused / spender unusable — nothing was broadcast. */
  | { kind: 'unsponsored'; error: string }
  /** Broadcast and reverted. The prize is wrong (grant gone, minted out); the
   *  caller may redraw. */
  | { kind: 'reverted'; userOpHash: string; error: string }
  /** Broadcast, outcome unknown. MUST be reconciled against chain state before
   *  any further mint is attempted. */
  | { kind: 'indeterminate'; userOpHash: string }
  /** Could not even start (misconfiguration). */
  | { kind: 'unavailable'; error: string }

/** Encoded `adminMint(to, tokenId, 1, 0x)` with the ERC-8021 builder suffix
 *  appended, so a prize carries the same on-chain attribution every other
 *  Kismet write does. Exported for the oracle to assert the suffix survives. */
export function buildAdminMintCall(to: string, tokenId: string): { data: Hex } {
  const data = encodeFunctionData({
    abi: COLLECTION_ABI,
    functionName: 'adminMint',
    args: [to as Address, BigInt(tokenId), 1n, '0x'],
  })
  return { data: BUILDER_DATA_SUFFIX ? (concat([data, BUILDER_DATA_SUFFIX]) as Hex) : data }
}

/** Has this player already got the prize? The only safe question to ask after
 *  an indeterminate send. */
export async function reconcileDelivered(params: {
  collection: string
  tokenId: string
  player: string
}): Promise<boolean | null> {
  try {
    const bal = (await serverBaseClient().readContract({
      address: params.collection as Address,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [params.player as Address, BigInt(params.tokenId)],
    })) as bigint
    return bal > 0n
  } catch {
    // Unknown — the caller must keep the claim pending rather than assume
    // either direction.
    return null
  }
}

/**
 * Mint the prize. Single-flight per (collection, tokenId, player) so a
 * double-submitted claim cannot produce two userOps for one obligation, using
 * the same token-CAS lock the stats rebuild and distribute-all already share.
 */
export async function deliverPrize(params: {
  collection: string
  tokenId: string
  player: string
  /** The operator address `checkPrizeAuthority` actually found the grant on.
   *
   *  WHY THIS IS PASSED IN. `operatorAddresses()` is an ORDERED SET so that
   *  re-keying is a gradual migration instead of invalidating every artist grant
   *  at once — the check passes if ANY configured operator holds the grant. But
   *  this module has exactly one signing identity (the named CDP smart account),
   *  so during a rotation the check can pass on an operator that is not the one
   *  about to sign, and the mint reverts on a play the player already paid for.
   *  Comparing here turns that into a clean pend with a stated reason, and
   *  nothing is broadcast. */
  operator?: string
  /** Called with the userOpHash the instant it exists — BEFORE the wait — so
   *  the caller can persist `sending` and make a timeout recoverable. */
  onBroadcast?: (userOpHash: string) => Promise<void>
}): Promise<DeliveryOutcome> {
  const apiKeyId = process.env.CDP_API_KEY_ID
  const apiKeySecret = process.env.CDP_API_KEY_SECRET
  const walletSecret = process.env.CDP_WALLET_SECRET
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    return { kind: 'unavailable', error: 'CDP credentials not configured' }
  }

  const lockKey = `kismetart:xp:deliver:${params.collection.toLowerCase()}:${params.tokenId}:${params.player.toLowerCase()}`
  const lock = await acquireLock(lockKey, 120).catch(() => ({ acquired: false, release: async () => {} }))
  if (!lock.acquired) {
    return { kind: 'unavailable', error: 'delivery already in flight for this prize' }
  }

  try {
    const { CdpClient } = await import('@coinbase/cdp-sdk')
    const cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret })
    const owner = await cdp.evm.getOrCreateAccount({
      name: process.env.CDP_XP_OWNER_NAME || 'kismet-experience-owner',
    })
    const smartAccount = await cdp.evm.getOrCreateSmartAccount({
      name: process.env.CDP_XP_ACCOUNT_NAME || 'kismet-experience-operator',
      owner,
    })

    if (
      params.operator &&
      smartAccount.address.toLowerCase() !== params.operator.toLowerCase()
    ) {
      // Checked BEFORE anything is broadcast, so this costs the player a pend
      // rather than a reverted mint. Loud, because it means a grant exists on an
      // operator we can no longer sign as — an ops problem, not a player problem.
      return {
        kind: 'unavailable',
        error: `grant is held by ${params.operator} but delivery signs as ${smartAccount.address}`,
      }
    }

    const { data } = buildAdminMintCall(params.player, params.tokenId)

    let userOpHash: string
    try {
      const sent = await smartAccount.sendUserOperation({
        calls: [{ to: params.collection as Address, value: 0n, data }],
        network: 'base',
        ...(process.env.CDP_PAYMASTER_URL ? { paymasterUrl: process.env.CDP_PAYMASTER_URL } : {}),
      })
      userOpHash = sent.userOpHash as string
    } catch (err) {
      // Sponsorship is resolved inside sendUserOperation (prepareUserOperation),
      // which is also where the hash is created — so a denial throws here, with
      // no hash and nothing broadcast. Unambiguously safe to treat as "did not
      // happen"; the account holds no ETH of its own, so there is no self-funded
      // fallback that could have landed.
      return { kind: 'unsponsored', error: err instanceof Error ? err.message : String(err) }
    }

    // Persist BEFORE the wait. Everything after this point may time out, and a
    // hash we never recorded is a delivery we can never reconcile.
    if (params.onBroadcast) await params.onBroadcast(userOpHash).catch(() => {})

    try {
      const result = await smartAccount.waitForUserOperation({
        userOpHash: userOpHash as Hex,
        waitOptions: { timeoutSeconds: 60 },
      })
      const status = (result as { status?: string }).status
      if (status === 'complete') {
        const txHash = (result as { transactionHash?: string }).transactionHash ?? ''
        return { kind: 'delivered', txHash, userOpHash }
      }
      return { kind: 'reverted', userOpHash, error: `userOp status: ${status ?? 'unknown'}` }
    } catch {
      // Timed out. The op may still land. Do NOT retry — reconcile.
      return { kind: 'indeterminate', userOpHash }
    }
  } catch (err) {
    return { kind: 'unavailable', error: err instanceof Error ? err.message : String(err) }
  } finally {
    await lock.release()
  }
}
