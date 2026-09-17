'use client'

/**
 * Phase 2 client grant — the user grants a bounded Spend Permission to KISMET's
 * autonomous spender (NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS), per the Base
 * "Use Spend Permissions" doc. One approval; thereafter the server spender
 * collects within the allowance with no further taps. Browser-only.
 *
 * The @base-org/account/spend-permission barrel is LAZY-imported inside each
 * call so its browser-only requestSpendPermission/requestRevoke never enter the
 * server compile graph (keeps `next build` warning-free). This module is
 * 'use client' and only mounted ssr:false, so it always runs in the browser.
 */

import type { ProviderInterface } from '@base-org/account'
import { getAccount } from '@wagmi/core'
import { wagmiConfig } from '@/lib/wagmi'
import { USDC_BASE, NATIVE_ETH_SENTINEL } from '@/lib/zoraMint'
import type { StoredSpendPermission } from './serverExecutor'
import { isGrantEnded } from './permission'

const BASE_CHAIN_ID = 8453

/** The Kismet autonomous spender address (a server-controlled key / CDP wallet).
 *  Empty when unconfigured — the panel then shows "not yet available". */
export const SCOUT_SPENDER = (process.env.NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS ?? '') as `0x${string}`

export type BudgetCurrency = 'eth' | 'usdc'
export type ScoutPermission = StoredSpendPermission

/** New grants carry a finite `end`. The SDK's default is "never", which is why a
 *  stranded grant has to be chased by the revoke machinery at all; a bounded
 *  lifetime caps that exposure. scoutBudgetStatus reports an ended grant
 *  inactive (the SDK itself throws for one), and the panel then says to set it
 *  up again. */
const GRANT_LIFETIME_DAYS = 365
/** The SDK's "never" end (2^48 − 1) — what grants made before the finite
 *  lifetime carry. */
export const ETERNITY_END = 281474976710655
/** A matching grant is reused only with at least this much lifetime left. */
const REUSE_MIN_REMAINING_S = 30 * 86_400

const spendPerm = () => import('@base-org/account/spend-permission')

async function connected(): Promise<{ provider: ProviderInterface; account: `0x${string}` }> {
  const acct = getAccount(wagmiConfig)
  if (!acct.connector || !acct.address) throw new Error('Connect your Base Account first')
  const provider = (await acct.connector.getProvider()) as unknown as ProviderInterface
  return { provider, account: acct.address }
}

/** Grant (or re-grant) the bounded budget to the scout spender. One signature. */
export async function grantScoutBudget(
  p: {
    currency: BudgetCurrency
    /** Allowance per period, base units (wei / USDC-6). */
    allowance: bigint
    periodInDays: number
  },
  /** `reuse: false` forces a fresh grant — after a turn-off whose spender-side
   *  revoke is still in flight, a matching grant that reads active now would be
   *  revoked under the new agent moments later. */
  opts: { reuse?: boolean } = {},
): Promise<ScoutPermission> {
  if (!SCOUT_SPENDER) throw new Error('Agent Collect is not available yet')
  const { requestSpendPermission, fetchPermissions, getPermissionStatus } = await spendPerm()
  const { provider, account } = await connected()
  const token = p.currency === 'eth' ? NATIVE_ETH_SENTINEL : USDC_BASE
  const periodSeconds = Math.max(1, Math.floor(p.periodInDays * 86_400))

  // Idempotent: reuse an existing ACTIVE permission to this spender matching the
  // token + allowance + period, so a retry after a failed save (or an identical
  // re-save) doesn't mint a duplicate permission or re-prompt the wallet.
  // Only a grant that still has a comfortable finite lifetime qualifies: an
  // eternal grant from before GRANT_LIFETIME_DAYS is replaced on the next save
  // (the config route stashes the old one for a spender-side revoke), and a
  // grant close to its end is renewed rather than reused, so "set it up again"
  // near expiry actually renews.
  const nowSec = Math.floor(Date.now() / 1000)
  if (opts.reuse !== false) {
    try {
      const perms = await fetchPermissions({ account, chainId: BASE_CHAIN_ID, spender: SCOUT_SPENDER, provider })
      for (const perm of perms) {
        const d = perm.permission
        if (d.token.toLowerCase() !== token.toLowerCase()) continue
        if (d.allowance !== p.allowance.toString() || d.period !== periodSeconds) continue
        if (d.end >= ETERNITY_END || d.end - nowSec < REUSE_MIN_REMAINING_S) continue
        if ((await getPermissionStatus(perm)).isActive) return perm
      }
    } catch {
      /* fall through to a fresh grant */
    }
  }

  return requestSpendPermission({
    account,
    spender: SCOUT_SPENDER,
    token,
    chainId: BASE_CHAIN_ID,
    allowance: p.allowance,
    periodInDays: p.periodInDays,
    end: new Date(Date.now() + GRANT_LIFETIME_DAYS * 86_400_000),
    provider,
  })
}

/** Live status of a granted budget (remaining this period, next reset, active).
 *  An ended grant is answered here as inactive: on-chain it reverts
 *  (AfterSpendPermissionEnd) and the SDK throws for it, which would leave the
 *  panel with no status and no "set it up again". */
export async function scoutBudgetStatus(permission: ScoutPermission) {
  if (isGrantEnded(permission)) {
    const end = permission.permission.end
    return {
      remainingSpend: 0n,
      nextPeriodStart: new Date(end * 1000),
      isRevoked: false,
      isExpired: true,
      isActive: false,
      isApprovedOnchain: false,
      currentPeriod: { start: end, end, spend: 0n },
    }
  }
  const { getPermissionStatus } = await spendPerm()
  return getPermissionStatus(permission)
}

/** Revoke the budget on-chain (user-approved). The installed @base-org/account
 *  2.5.10 requestRevoke takes the object form `{ provider, permission }`. */
export async function revokeScoutBudget(permission: ScoutPermission): Promise<void> {
  const { requestRevoke } = await spendPerm()
  const { provider } = await connected()
  await requestRevoke({ provider, permission })
}
