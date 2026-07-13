/**
 * Spend-Permission server executor (Phase 2, autonomous) — the unattended half
 * of the ScoutExecutor seam. The user grants a bounded Spend Permission to
 * KISMET's spender (client-side `requestSpendPermission`); here the spender pulls
 * EXACTLY one collect's cost from the user's Base Account and mints to the user,
 * within the on-chain allowance, with no per-collect approval.
 *
 * Server-safe: imports only the node-bundle spend-permission utils
 * (getPermissionStatus / prepareSpendCallData — confirmed present in
 * @base-org/account/spend-permission's node build) + the shared collectBatch
 * builders. No browser provider, no headless wallet SDK.
 *
 * SDK API: calls use the installed @base-org/account@2.5.7 POSITIONAL form —
 * `getPermissionStatus(permission)`, `prepareSpendCallData(permission, amount)`
 * (verified against the installed d.ts signature
 * `(permission, amount, recipient?, options?)`). Some Base docs show an object
 * form; the installed package is positional, so the positional calls below are
 * correct for this version — re-verify on any SDK bump. The flow + semantics:
 * status-check → prepare [approveWithSignature?, spend] → submit FROM the spender
 * (the spender executes both, per the docs).
 */

import { getPermissionStatus, prepareSpendCallData } from '@base-org/account/spend-permission'
import type { Address, Hex } from 'viem'
import { redis } from '@/lib/redis'
import { readMintFeeWithBound, USDC_BASE, NATIVE_ETH_SENTINEL } from '@/lib/zoraMint'
import { fetchEligibleTokens } from '@/lib/saleConfig'
import { serverBaseClient } from '@/lib/rpc'
import { buildCollectBatchPlan, type BatchCollectItem } from '@/lib/agent/collectBatch'
import { composeScoutCollect } from './serverCollect'
import type { ScoutSpender, SpenderCall } from './spender'
import type { Candidate, Scout } from './engine'
import type { ScoutExecutor } from './executor'

/** The stored Spend Permission (granted client-side, persisted in ScoutRecord).
 *  Typed from the SDK so we never deep-import its internal type. */
export type StoredSpendPermission = Parameters<typeof getPermissionStatus>[0]
type SdkSpendCall = Awaited<ReturnType<typeof prepareSpendCallData>>[number]

const toSpenderCall = (c: SdkSpendCall): SpenderCall => ({
  to: c.to as Address,
  data: c.data as Hex,
  value: BigInt(c.value),
})

const ERC1155_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/** Recipient's current balance of a drop token. Returns null on read failure so
 *  the caller can decide (here: proceed on the caller's quantity, still bounded by
 *  the on-chain per-wallet cap + allowance). */
async function readOwnedBalance(account: Address, collection: Address, tokenId: bigint): Promise<bigint | null> {
  try {
    return (await serverBaseClient().readContract({
      address: collection,
      abi: ERC1155_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [account, tokenId],
    })) as bigint
  } catch {
    return null
  }
}

/**
 * Execute ONE collect through the bounded permission. The mint is built first so
 * the spend amount EXACTLY matches what the mint consumes (ETH msg.value or the
 * USDC the minter pulls); `usdcAllowance: 0n` forces a fresh per-collect approve
 * so the spender holds funds only transiently. Returns the mint tx hash.
 */
export async function collectViaSpendPermission(params: {
  permission: StoredSpendPermission
  spender: ScoutSpender
  /** mintTo — the user's Base Account. */
  recipient: Address
  item: BatchCollectItem
  /** The recipient's target editions of THIS drop (maxEditionsPerDrop). When set,
   *  the mint quantity is re-clamped against a balance read taken INSIDE the lock,
   *  closing the TOCTOU where the caller sized quantity off a pre-lock balance and a
   *  concurrent path minted in between (coordinator vs on-open overshooting the
   *  target). Omit to skip the re-check. */
  editionTarget?: bigint
}): Promise<{ txHash: Hex }> {
  const { permission, spender, recipient, editionTarget } = params
  let item = params.item

  // Defense-in-depth at the SINGLE spend choke-point (both the on-open executor
  // and the drop coordinator funnel through here). By construction the permission
  // was granted BY this recipient FOR this currency — but a wiring bug or a future
  // refactor must never (a) pull from a permission whose granting account isn't the
  // mint recipient (would move a DIFFERENT user's funds) or (b) pull in a token that
  // doesn't match what the mint consumes (would pull the wrong asset — and on the
  // non-atomic EOA path strand it after a mint revert). Assert both, fail-closed.
  const grant = permission.permission
  if (grant.account && grant.account.toLowerCase() !== recipient.toLowerCase()) {
    throw new Error('Spend permission account does not match the mint recipient — refusing to spend')
  }
  const expectedToken = item.currency === 'eth' ? NATIVE_ETH_SENTINEL : USDC_BASE
  if (grant.token && grant.token.toLowerCase() !== expectedToken.toLowerCase()) {
    throw new Error(
      `Spend permission token (${grant.token}) does not match the drop currency (${item.currency}) — refusing to spend`,
    )
  }

  // Per (recipient, drop) lock. The drop coordinator and the on-open run loop can
  // both target the SAME user + token at once; and — critically — the ONLY
  // cross-run dedup is an on-chain balanceOf read, which is BLIND to a spender op
  // that has been broadcast but not yet mined. So a submit still in flight (or a
  // CDP wait that timed out "may still land") would let a concurrent/next run read
  // balance 0 and double-spend an open edition (no per-wallet cap to backstop it).
  // We therefore HOLD this lock for its full TTL and NEVER release it early: the
  // TTL must comfortably exceed the worst-case submit+confirm time (spender-mutex
  // wait + user-op wait), so the lock outlives the op's landing, by which point
  // balanceOf dedups the retry. A completed OR failed collect keeps the lock only
  // until expiry — harmless: the same (recipient, drop) is by then already
  // collected (balance-deduped) or self-heals on a later run once the lock lapses.
  // SET-NX; on lock-store failure we proceed unlocked (the on-chain allowance still
  // bounds spend). Expiry is the sole release — there is deliberately no finally.
  const lockKey = `kismetart:scout-collect:${recipient.toLowerCase()}:${item.collection.toLowerCase()}:${item.tokenId}`
  let acquired: unknown
  let storeUp = true
  try {
    acquired = await redis.set(lockKey, '1', { nx: true, ex: 300 })
  } catch {
    storeUp = false // lock store down → proceed; the on-chain allowance still bounds spend
  }
  if (storeUp && acquired !== 'OK') throw new Error('A collect for this drop is already in progress')

  // TOCTOU clamp: re-read the recipient's balance INSIDE the lock and trim the
  // mint to the remaining edition headroom. The caller sized `quantity` from a
  // balance read taken BEFORE this lock; a concurrent run could have minted since.
  // A failed read (null) proceeds on the caller's quantity — the on-chain per-wallet
  // cap + allowance still bound it.
  if (editionTarget !== undefined) {
    const owned = await readOwnedBalance(recipient, item.collection, item.tokenId)
    if (owned !== null) {
      const headroom = editionTarget - owned
      if (headroom <= 0n) throw new Error('Recipient already at the edition target for this drop')
      if (item.quantity > headroom) item = { ...item, quantity: headroom }
    }
  }

  const plan = buildCollectBatchPlan({ account: spender.address, recipient, items: [item], usdcAllowance: 0n })
  const cost = item.currency === 'eth' ? plan.totalNativeValue : plan.totalUsdcCost
  if (cost < 0n) throw new Error('Invalid negative cost')

  // A FREE drop (cost 0) needs no spend — just mint (the spender pays only gas).
  // A PAID drop pulls EXACTLY the cost from the bounded permission first, within
  // the live on-chain allowance (fail-closed). The run loop already bailed if the
  // permission was inactive, so we only re-check the allowance headroom here.
  let spendCalls: SpenderCall[] = []
  if (cost > 0n) {
    const status = await getPermissionStatus(permission)
    if (!status.isActive) throw new Error('Spend permission is not active')
    if (status.remainingSpend < cost) throw new Error('Spend permission allowance exhausted this period')
    spendCalls = (await prepareSpendCallData(permission, cost)).map(toSpenderCall)
  }
  return await spender.sendCalls(composeScoutCollect(spendCalls, plan.calls))
}

/**
 * Adapt the custody-agnostic ScoutExecutor seam (executor.ts) to the
 * Spend-Permission spender. Reads the protocol mint fee on-chain for ETH items
 * (USDC ignores it); quantity is 1 per autonomous collect.
 */
export function createSpendPermissionExecutor(cfg: {
  permission: StoredSpendPermission
  spender: ScoutSpender
  recipient: Address
}): ScoutExecutor {
  return {
    async collect(scout: Scout, candidate: Candidate) {
      const collection = candidate.collection as Address
      const tokenId = BigInt(candidate.tokenId)
      const client = serverBaseClient()
      // Editions to hold of each drop before stopping (default 1 = one of each).
      const editions = BigInt(Math.max(1, Math.floor(scout.policy.maxEditionsPerDrop ?? 1)))

      // RE-RESOLVE the price + eligibility ON-CHAIN (never trust the discovered
      // price): so spend() pulls EXACTLY what the mint consumes. A stale/wrong
      // price would otherwise over-charge (excess stuck in the spender) or strand
      // funds on a reverting mint. Eligibility is checked for the recipient (the
      // mintTo / per-wallet-limit subject), mirroring prepare-collect-batch. The
      // `editions` threshold makes this the authoritative "already collected"
      // guard — the recipient already holding >= editions skips the drop, even
      // for open editions (no per-wallet cap) with zero index lag.
      const [token] = await fetchEligibleTokens(client, collection, [tokenId], candidate.currency, cfg.recipient, editions)
      if (!token) throw new Error('Sold out, not mintable, or already at your edition cap')

      // Re-enforce the user's per-item price cap against the ON-CHAIN price. The
      // engine's earlier gate (evaluateCandidate) ran against the cached
      // discovery price, which a watched artist can raise AFTER it's indexed;
      // this executor then spends the freshly-resolved on-chain price, so the
      // cap must be re-checked here or it's bypassable on the on-open run path
      // (the drop-coordinator path already gates on the on-chain price). Mirrors
      // engine.ts evaluateCandidate: compare pricePerToken (excl. mint fee).
      let maxItemPrice: bigint
      try {
        maxItemPrice = BigInt(scout.policy.maxItemPrice)
      } catch {
        // Unparseable cap → fail CLOSED (refuse) rather than spend uncapped. The
        // PUT route validates maxItemPrice as a positive integer string, so this
        // is a defense-in-depth backstop that should never fire in practice.
        throw new Error('Invalid per-item price cap')
      }
      if (token.pricePerToken > maxItemPrice) {
        throw new Error('Drop price exceeds your per-item price cap')
      }

      // Same viem PublicClient variance cast the prepare-collect-batch route uses.
      const mintFee =
        candidate.currency === 'eth'
          ? await readMintFeeWithBound(client as Parameters<typeof readMintFeeWithBound>[0], collection)
          : 0n

      // How many editions to mint THIS run. Top up toward the target, bounded by
      // the drop's per-wallet cap. An ATOMIC spender (CDP smart account) fills it
      // in one op; a non-atomic EOA stays at 1/run (a mint revert after spend()
      // would strand funds), so multi-edition accrues across runs. Finally clamp
      // to what the remaining allowance affords, so one collect never overshoots
      // the budget (else the whole drop would skip on the allowance check).
      let quantity = editions - token.ownedBalance // >= 1n (>= editions was filtered out)
      if (token.maxPerAddress > 0n) {
        const headroom = token.maxPerAddress - token.ownedBalance
        if (headroom < quantity) quantity = headroom
      }
      if (!cfg.spender.atomic) quantity = 1n
      if (quantity > 1n) {
        const perEdition = token.pricePerToken + (candidate.currency === 'eth' ? mintFee : 0n)
        if (perEdition > 0n) {
          const affordable = (await getPermissionStatus(cfg.permission)).remainingSpend / perEdition
          if (affordable < quantity) quantity = affordable
        }
      }
      if (quantity < 1n) quantity = 1n // attempt one; the allowance check is the final guard

      const item: BatchCollectItem = {
        collection,
        tokenId,
        quantity,
        currency: candidate.currency,
        pricePerToken: token.pricePerToken,
        mintFee,
        comment: '',
      }
      // Pass the edition target so collectViaSpendPermission re-clamps against an
      // in-lock balance read (the `editions`/quantity above were sized from a
      // pre-lock fetchEligibleTokens read — see the TOCTOU note there).
      const { txHash } = await collectViaSpendPermission({ ...cfg, item, editionTarget: editions })
      return { txHash, quantity }
    },
  }
}
