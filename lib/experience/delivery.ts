import 'server-only'
import { concat, encodeFunctionData, type Address, type Hex } from 'viem'
import { COLLECTION_ABI } from '../collections'
import { BUILDER_DATA_SUFFIX } from '../builderCode'
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
 * `readDeliveryOutcome` asks CDP for THAT userOp's own status instead, and only
 * a definitive `failed` (or a never-broadcast attempt) authorises another mint.
 * Blind retry is the single action that can mint twice for one payment.
 *
 * ── Why the userOp receipt, and not the player's balance ──
 *
 * An earlier version answered "did our mint land?" by reading the player's
 * balance of the drawn edition and comparing it to a floor captured before the
 * attempt. That measures the EDITION, not the mint: every solvent machine
 * carries an unlimited floor piece that a multi-pull draws several times over,
 * and a sibling unit's mint of the same edition raised the balance past this
 * unit's floor — so a unit whose own userOp never landed was closed as
 * delivered, and the player was quietly shorted one artwork. A userOp hash is
 * ours alone; its status cannot be moved by any other mint.
 */

export type DeliveryOutcome =
  /** Confirmed on-chain. */
  | { kind: 'delivered'; txHash: string; userOpHash: string }
  /** Sponsorship refused / spender unusable — nothing was broadcast. */
  | { kind: 'unsponsored'; error: string }
  /** Broadcast and reverted. The prize is wrong (grant gone, minted out); the
   *  caller may redraw. */
  | { kind: 'reverted'; userOpHash: string; error: string }
  /** Broadcast, outcome unknown. MUST be reconciled against the userOp's own
   *  status (readDeliveryOutcome) before any further mint is attempted. */
  | { kind: 'indeterminate'; userOpHash: string }
  /** Could not even start (misconfiguration). */
  | { kind: 'unavailable'; error: string }

/** What a userOp's status means for the claim that broadcast it. Pure, so the
 *  oracle can pin every branch; `readDeliveryOutcome` is the CDP read around it.
 *
 *  Only `complete` is a landed mint. `failed` and `dropped` are terminal
 *  without one, so the obligation is still open and a re-attempt is safe. Every
 *  other value — `pending`, `signed`, `broadcast`, or a status this code does
 *  not know — is treated as still in flight: not delivered, and NOT safe to
 *  re-broadcast, because the first one may yet land. */
export function deliveryStateFromStatus(status: string | undefined): 'landed' | 'failed' | 'pending' {
  if (status === 'complete') return 'landed'
  if (status === 'failed' || status === 'dropped') return 'failed'
  return 'pending'
}

export type DeliveryReceipt =
  | { kind: 'landed'; txHash: string }
  | { kind: 'failed' }
  | { kind: 'pending' }
  /** CDP could not be asked (unconfigured, unreachable, or the op is unknown to
   *  it). Callers keep the claim pending — never deliver or re-mint on this. */
  | { kind: 'unknown' }

/** The one signing identity: the named CDP smart account, resolved by name so
 *  its address survives restarts. Shared by the send and the receipt read so
 *  the two can never look at different accounts. Throws on any failure; both
 *  callers map that to their own fail-closed outcome. */
async function resolveSigner() {
  const apiKeyId = process.env.CDP_API_KEY_ID
  const apiKeySecret = process.env.CDP_API_KEY_SECRET
  const walletSecret = process.env.CDP_WALLET_SECRET
  if (!apiKeyId || !apiKeySecret || !walletSecret) throw new Error('CDP credentials not configured')
  const { CdpClient } = await import('@coinbase/cdp-sdk')
  const cdp = new CdpClient({
    apiKeyId,
    apiKeySecret,
    walletSecret,
    // Pointable at a stand-in for the end-to-end harness, exactly as the RPC
    // and Redis URLs are. Unset in production, so the SDK's own default holds.
    ...(process.env.CDP_API_BASE_PATH ? { basePath: process.env.CDP_API_BASE_PATH } : {}),
  })
  const owner = await cdp.evm.getOrCreateAccount({
    name: process.env.CDP_XP_OWNER_NAME || 'kismet-experience-owner',
  })
  return cdp.evm.getOrCreateSmartAccount({
    name: process.env.CDP_XP_ACCOUNT_NAME || 'kismet-experience-operator',
    owner,
  })
}

/**
 * What became of a userOp this module broadcast. The only honest answer to
 * "did our mint land?" after an indeterminate send — asked of the operation
 * itself, by its hash, so no other mint of the same edition can answer for it.
 * Never throws: an unreachable or unconfigured CDP is `unknown`, and callers
 * leave the claim pending on it rather than assume either direction.
 */
export async function readDeliveryOutcome(params: { userOpHash: string }): Promise<DeliveryReceipt> {
  try {
    const smartAccount = await resolveSigner()
    const op = await smartAccount.getUserOperation({ userOpHash: params.userOpHash as Hex })
    const state = deliveryStateFromStatus(op.status)
    if (state === 'landed') return { kind: 'landed', txHash: op.transactionHash ?? '' }
    return { kind: state }
  } catch {
    return { kind: 'unknown' }
  }
}

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

/**
 * Mint the prize. Single-flight per CLAIM, using the same token-CAS lock the
 * stats rebuild and distribute-all already share, so a claim adopted by resume
 * while its original play is somehow still alive cannot produce two userOps for
 * one obligation.
 *
 * Per claim, not per (collection, tokenId, player): two units of one capsule
 * that both draw the floor piece are two obligations and deserve two mints. A
 * lock keyed on the piece made the second wait on the first and pend as
 * "already in flight" — a needless stall, and the trigger for the balance
 * mis-attribution described at the top of this file.
 */
export async function deliverPrize(params: {
  /** `${machineId}:${txHash}:${unitIndex}` — the obligation being paid. */
  claimKey: string
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
  if (!process.env.CDP_API_KEY_ID || !process.env.CDP_API_KEY_SECRET || !process.env.CDP_WALLET_SECRET) {
    return { kind: 'unavailable', error: 'CDP credentials not configured' }
  }

  const lockKey = `kismetart:xp:deliver:${params.claimKey.toLowerCase()}`
  const lock = await acquireLock(lockKey, 120).catch(() => ({ acquired: false, release: async () => {} }))
  if (!lock.acquired) {
    return { kind: 'unavailable', error: 'delivery already in flight for this claim' }
  }

  try {
    const smartAccount = await resolveSigner()

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
      // Timed out, or the status read failed mid-wait. The op may still land.
      // Do NOT retry — the caller pends, and resume asks readDeliveryOutcome.
      return { kind: 'indeterminate', userOpHash }
    }
  } catch (err) {
    return { kind: 'unavailable', error: err instanceof Error ? err.message : String(err) }
  } finally {
    await lock.release()
  }
}
