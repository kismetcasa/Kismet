'use client'

/**
 * Mode A wiring — in-session, popup-less collecting via a Base Sub Account.
 *
 * Verified against the installed @base-org/account@2.4.0 type definitions (the
 * authoritative source; docs.base.org blocks automated fetch). The exact calls
 * used here are typed against that package:
 *   - createBaseAccountSDK({ subAccounts }) → { getProvider, subAccount }
 *   - getCryptoKeyAccount() — the non-extractable browser key that signs the
 *     sub-account (Mode A: no Kismet-held key)
 *   - requestSpendPermission / getPermissionStatus / fetchPermissions /
 *     requestRevoke (@base-org/account/spend-permission)
 *
 * Model (see AGENT_SUBACCOUNT_DESIGN.md): the user's universal Base Account owns
 * a "Kismet collecting" sub-account; a USDC Spend Permission caps the budget;
 * the sub-account auto-funds from the parent within that cap and signs collects
 * with the browser key — no per-collect popup.
 *
 * RUNTIME-PENDING (type-verified, needs a live wallet smoke test): on-connect
 * sub-account provisioning, wallet_sendCalls auto-funding within the permission,
 * and paymaster/gas. These are standard SDK behaviors but can't be exercised in
 * CI (no browser/wallet/RPC).
 */

import { createBaseAccountSDK, getCryptoKeyAccount } from '@base-org/account'
import {
  fetchPermissions,
  getPermissionStatus,
  requestRevoke,
  requestSpendPermission,
} from '@base-org/account/spend-permission'
import { USDC_BASE } from '@/lib/zoraMint'
import type { AgentCall } from '@/lib/agent/types'

const BASE_CHAIN_ID = 8453
const BASE_CHAIN_HEX = '0x2105' as const // 8453
const APP_NAME = 'Kismet'

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

let sdkSingleton: ReturnType<typeof createBaseAccountSDK> | null = null

/** The Base Account SDK configured for Kismet's collecting sub-account. */
export function getCollectingSdk(): ReturnType<typeof createBaseAccountSDK> {
  if (sdkSingleton) return sdkSingleton
  const paymasterUrl = process.env.NEXT_PUBLIC_PAYMASTER_URL
  sdkSingleton = createBaseAccountSDK({
    appName: APP_NAME,
    appLogoUrl: process.env.NEXT_PUBLIC_FARCASTER_ICON_URL ?? null,
    appChainIds: [BASE_CHAIN_ID],
    subAccounts: {
      // Provision the collecting sub-account on connect, signed by a
      // non-extractable browser key (Mode A — no Kismet-held key). Keep the
      // universal account primary so the user's identity/profile is unchanged.
      creation: 'on-connect',
      defaultAccount: 'universal',
      // Auto-fund the sub-account from the parent within the granted Spend
      // Permission — this is what makes collecting popup-less.
      funding: 'spend-permissions',
      toOwnerAccount: getCryptoKeyAccount,
    },
    ...(paymasterUrl ? { paymasterUrls: { [BASE_CHAIN_ID]: paymasterUrl } } : {}),
  })
  return sdkSingleton
}

/** Connect the Base Account and resolve the collecting sub-account (created
 *  on-connect). Returns both addresses. */
export async function connectCollectingAccount(): Promise<CollectingAccounts> {
  const sdk = getCollectingSdk()
  const provider = sdk.getProvider()
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as `0x${string}`[]
  const universal = accounts[0]
  if (!universal) throw new Error('No Base Account connected')
  const sub = await sdk.subAccount.get()
  if (!sub?.address) throw new Error('Kismet collecting account was not provisioned')
  return { universal, subAccount: sub.address }
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
  const sdk = getCollectingSdk()
  return requestSpendPermission({
    account: params.universal,
    spender: params.subAccount,
    token: USDC_BASE,
    chainId: BASE_CHAIN_ID,
    allowance: params.allowance,
    periodInDays: params.periodInDays,
    ...(params.end ? { end: params.end } : {}),
    provider: sdk.getProvider(),
  })
}

/** Find an existing collecting budget (Spend Permission) for this pair, if any. */
export async function findCollectingBudget(
  universal: `0x${string}`,
  subAccount: `0x${string}`,
): Promise<CollectingBudget | null> {
  const sdk = getCollectingSdk()
  const perms = await fetchPermissions({
    account: universal,
    chainId: BASE_CHAIN_ID,
    spender: subAccount,
    provider: sdk.getProvider(),
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
  const sdk = getCollectingSdk()
  return requestRevoke({ provider: sdk.getProvider(), permission: budget })
}

/** Send a prepared collect batch FROM the sub-account — popup-less; the SDK
 *  auto-funds from the parent within the Spend Permission. Returns the EIP-5792
 *  bundle id. */
export async function sendCollectCallsFromSubAccount(
  subAccount: `0x${string}`,
  calls: readonly AgentCall[],
): Promise<string> {
  const sdk = getCollectingSdk()
  const result = (await sdk.getProvider().request({
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
  const provider = getCollectingSdk().getProvider()
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
