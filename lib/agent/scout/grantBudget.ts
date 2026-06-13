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
import { USDC_BASE } from '@/lib/zoraMint'
import type { StoredSpendPermission } from './serverExecutor'

/** ERC-7528 native-asset sentinel (ETH budget); USDC budgets use USDC_BASE. */
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as const
const BASE_CHAIN_ID = 8453

/** The Kismet autonomous spender address (a server-controlled key / CDP wallet).
 *  Empty when unconfigured — the panel then shows "not yet available". */
export const SCOUT_SPENDER = (process.env.NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS ?? '') as `0x${string}`

export type BudgetCurrency = 'eth' | 'usdc'
export type ScoutPermission = StoredSpendPermission

const spendPerm = () => import('@base-org/account/spend-permission')

async function connected(): Promise<{ provider: ProviderInterface; account: `0x${string}` }> {
  const acct = getAccount(wagmiConfig)
  if (!acct.connector || !acct.address) throw new Error('Connect your Base Account first')
  const provider = (await acct.connector.getProvider()) as unknown as ProviderInterface
  return { provider, account: acct.address }
}

/** Grant (or re-grant) the bounded budget to the scout spender. One signature. */
export async function grantScoutBudget(p: {
  currency: BudgetCurrency
  /** Allowance per period, base units (wei / USDC-6). */
  allowance: bigint
  periodInDays: number
}): Promise<ScoutPermission> {
  if (!SCOUT_SPENDER) throw new Error('Agent Collect is not available yet')
  const { requestSpendPermission, fetchPermissions, getPermissionStatus } = await spendPerm()
  const { provider, account } = await connected()
  const token = p.currency === 'eth' ? NATIVE_ETH : USDC_BASE
  const periodSeconds = Math.max(1, Math.floor(p.periodInDays * 86_400))

  // Idempotent: reuse an existing ACTIVE permission to this spender matching the
  // token + allowance + period, so a retry after a failed save (or an identical
  // re-save) doesn't mint a duplicate permission or re-prompt the wallet.
  try {
    const perms = await fetchPermissions({ account, chainId: BASE_CHAIN_ID, spender: SCOUT_SPENDER, provider })
    for (const perm of perms) {
      const d = perm.permission
      if (d.token.toLowerCase() !== token.toLowerCase()) continue
      if (d.allowance !== p.allowance.toString() || d.period !== periodSeconds) continue
      if ((await getPermissionStatus(perm)).isActive) return perm
    }
  } catch {
    /* fall through to a fresh grant */
  }

  return requestSpendPermission({
    account,
    spender: SCOUT_SPENDER,
    token,
    chainId: BASE_CHAIN_ID,
    allowance: p.allowance,
    periodInDays: p.periodInDays,
    provider,
  })
}

/** Live status of a granted budget (remaining this period, next reset, active). */
export async function scoutBudgetStatus(permission: ScoutPermission) {
  const { getPermissionStatus } = await spendPerm()
  return getPermissionStatus(permission)
}

/** Revoke the budget on-chain (user-approved). 2.4.0's requestRevoke takes
 *  `{ provider, permission }` (the latest docs show a positional form). */
export async function revokeScoutBudget(permission: ScoutPermission): Promise<void> {
  const { requestRevoke } = await spendPerm()
  const { provider } = await connected()
  await requestRevoke({ provider, permission })
}
