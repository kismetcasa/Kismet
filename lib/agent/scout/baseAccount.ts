'use client'

/**
 * Mode A wiring — in-session, popup-less collecting via a Base Sub Account.
 *
 * Uses the WAGMI-CONNECTED provider (not a standalone SDK). The Base Account
 * wallet is configured with `subAccounts` on the wagmi `baseAccount` connector
 * in lib/wagmi.ts, so the user's single wagmi session already owns the
 * collecting sub-account and a connected EIP-1193 provider. We read that
 * provider + the universal/sub addresses from the wagmi config singleton
 * (`getAccount`), so there is no second SDK session and no double connect.
 *
 * Verified against the installed @base-org/account@2.4.0 types (the
 * authoritative source; docs.base.org blocks automated fetch):
 *   - requestSpendPermission / getPermissionStatus / fetchPermissions /
 *     requestRevoke (@base-org/account/spend-permission) — each takes the
 *     connected `provider: ProviderInterface`.
 *   - getCryptoKeyAccount (the non-extractable browser key that signs the
 *     sub-account, Mode A: no Kismet-held key) is wired as the connector's
 *     `toOwnerAccount` in lib/wagmi.ts.
 *
 * Model (see AGENT_SUBACCOUNT_DESIGN.md): the user's universal Base Account owns
 * a "Kismet collecting" sub-account; a USDC Spend Permission caps the budget;
 * the sub-account auto-funds from the parent within that cap (connector
 * `funding: 'spend-permissions'`) and signs collects with the browser key — no
 * per-collect popup.
 *
 * RUNTIME-PENDING (type-verified, needs a live wallet smoke test): on-connect
 * sub-account provisioning surfacing as accounts[1], wallet_sendCalls
 * auto-funding within the permission, and paymaster/gas. These are standard SDK
 * behaviors but can't be exercised in CI (no browser/wallet/RPC).
 *
 * Build-warning note: `next build` prints "Attempted import error:
 * 'requestSpendPermission'/'requestRevoke' is not exported from
 * '@base-org/account/spend-permission'". This is BENIGN. `@base-org/account`'s
 * package exports resolve `./spend-permission` per condition: the `browser`
 * condition serves `index.js` (an un-bundled barrel that DOES `export *` these
 * functions — confirmed present at runtime), while the `node` condition serves
 * `index.node.js`, a bundle where the package's build dropped these two
 * `export const`s (they appear as bare `withTelemetry(...)` expressions). This
 * module is `'use client'` and only ever runs in the browser (AutoCollectPanel
 * is mounted via next/dynamic ssr:false), so it always hits the working browser
 * barrel; the warning comes only from Next's server-graph compile pass, which
 * never executes this code. `fetchPermissions`/`getPermissionStatus` are
 * unaffected because they survive both bundles.
 */

import {
  fetchPermissions,
  getPermissionStatus,
  requestRevoke,
  requestSpendPermission,
} from '@base-org/account/spend-permission'
import type { ProviderInterface } from '@base-org/account'
import { getAccount } from '@wagmi/core'
import { wagmiConfig } from '@/lib/wagmi'
import { USDC_BASE } from '@/lib/zoraMint'
import type { AgentCall } from '@/lib/agent/types'

const BASE_CHAIN_ID = 8453
const BASE_CHAIN_HEX = '0x2105' as const // 8453

/** The granted Spend Permission shape, derived from the SDK so we don't depend
 *  on a deep type import. */
export type CollectingBudget = Awaited<ReturnType<typeof requestSpendPermission>>
export type CollectingBudgetStatus = Awaited<ReturnType<typeof getPermissionStatus>>

export interface CollectingAccounts {
  /** The user's main Base Account — their identity/profile address. */
  universal: `0x${string}`
  /** The Kismet collecting sub-account (owned by `universal`). */
  subAccount: `0x${string}`
}

/** The wagmi-connected EIP-1193 provider + the universal/sub addresses for the
 *  active session. With the connector's `subAccounts` config and
 *  `defaultAccount: 'universal'`, wagmi reports accounts as [universal, sub]. */
async function getConnected(): Promise<{
  provider: ProviderInterface
  universal: `0x${string}`
  subAccount?: `0x${string}`
}> {
  const acct = getAccount(wagmiConfig)
  if (!acct.connector || !acct.address) throw new Error('No Base Account connected')
  const provider = (await acct.connector.getProvider()) as unknown as ProviderInterface
  return { provider, universal: acct.address, subAccount: acct.addresses?.[1] }
}

/** Resolve the collecting sub-account (provisioned on-connect). Prefers the
 *  address wagmi already surfaced; falls back to asking the provider directly
 *  (creation:'on-connect' provisions it on the first accounts request). */
export async function connectCollectingAccount(): Promise<CollectingAccounts> {
  const { provider, universal, subAccount } = await getConnected()
  if (subAccount) return { universal, subAccount }
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as `0x${string}`[]
  const sub = accounts[1]
  if (!sub) throw new Error('Kismet collecting account was not provisioned')
  return { universal, subAccount: sub }
}

/** Grant the collecting budget: a USDC Spend Permission from the universal
 *  account to the sub-account (one signature). */
export async function grantCollectingBudget(params: {
  universal: `0x${string}`
  subAccount: `0x${string}`
  /** USDC allowance per period, base units (6dp). */
  allowance: bigint
  periodInDays: number
  end?: Date
}): Promise<CollectingBudget> {
  const { provider } = await getConnected()
  return requestSpendPermission({
    account: params.universal,
    spender: params.subAccount,
    token: USDC_BASE,
    chainId: BASE_CHAIN_ID,
    allowance: params.allowance,
    periodInDays: params.periodInDays,
    ...(params.end ? { end: params.end } : {}),
    provider,
  })
}

/** Find an existing collecting budget (Spend Permission) for this pair, if any. */
export async function findCollectingBudget(
  universal: `0x${string}`,
  subAccount: `0x${string}`,
): Promise<CollectingBudget | null> {
  const { provider } = await getConnected()
  const perms = await fetchPermissions({
    account: universal,
    chainId: BASE_CHAIN_ID,
    spender: subAccount,
    provider,
  })
  return perms[0] ?? null
}

/** Live status of a budget: remaining allowance this period, next reset, etc. */
export async function getCollectingBudgetStatus(budget: CollectingBudget): Promise<CollectingBudgetStatus> {
  return getPermissionStatus(budget)
}

/** Revoke the collecting budget on-chain (the user can also do this at
 *  account.base.app). */
export async function revokeCollectingBudget(budget: CollectingBudget): Promise<`0x${string}`> {
  const { provider } = await getConnected()
  return requestRevoke({ provider, permission: budget })
}

/** Send a prepared collect batch FROM the sub-account — popup-less; the SDK
 *  auto-funds from the parent within the Spend Permission. Returns the EIP-5792
 *  bundle id. */
export async function sendCollectCallsFromSubAccount(
  subAccount: `0x${string}`,
  calls: readonly AgentCall[],
): Promise<string> {
  const { provider } = await getConnected()
  const result = (await provider.request({
    method: 'wallet_sendCalls',
    params: [
      {
        version: '2.0.0',
        chainId: BASE_CHAIN_HEX,
        from: subAccount,
        atomicRequired: true,
        calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value })),
      },
    ],
  })) as string | { id: string }
  return typeof result === 'string' ? result : result.id
}

/** Poll the EIP-5792 bundle until it lands; returns the on-chain tx hash that
 *  /api/collect verifies. */
export async function waitForCollectTxHash(bundleId: string, timeoutMs = 60_000): Promise<`0x${string}`> {
  const { provider } = await getConnected()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = (await provider.request({
      method: 'wallet_getCallsStatus',
      params: [bundleId],
    })) as { status?: number; receipts?: Array<{ transactionHash?: `0x${string}` }> } | null
    // EIP-5792 status codes: 100 pending, 200 confirmed, 400/500/600 failed.
    if (res?.status === 200) {
      const txHash = res.receipts?.[0]?.transactionHash
      if (txHash) return txHash
    }
    if (res?.status === 400 || res?.status === 500 || res?.status === 600) {
      throw new Error('Collect did not complete on-chain')
    }
    await new Promise((r) => setTimeout(r, 1_500))
  }
  throw new Error('Timed out waiting for the collect to confirm')
}
