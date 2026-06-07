'use client'

/**
 * In-session collect (Mode A): the user is in Kismet, asks to collect one or a
 * basket of moments, and it goes through their Kismet collecting sub-account
 * with NO per-collect popup (after the one-time sub-account + budget setup).
 *
 * Flow: connect → prepare the batch server-side (reusing /api/agent/
 * prepare-collect-batch, which resolves live sale + builds the exact mint
 * calldata incl. the builder code + Zora referral) → send the batch from the
 * sub-account (popup-less, auto-funded within the Spend Permission) → record
 * each collect on the existing on-chain-verified /api/collect.
 *
 * Recipient: the sub-account is the SENDER (pays via the Spend Permission +
 * holds the USDC approve), but mintTo is the user's UNIVERSAL Base Account, so
 * collected NFTs land in the user's main collection and show on their profile.
 * prepare-collect-batch takes `account` (sender) + `recipient` (mintTo) and uses
 * `recipient` for the per-wallet eligibility check + the /api/collect record.
 */

import type { AgentCall, AgentRecordHint } from '@/lib/agent/types'
import {
  connectCollectingAccount,
  sendCollectCallsFromSubAccount,
  waitForCollectTxHash,
} from './baseAccount'

export interface CollectItemRef {
  collection?: string
  tokenId?: string
  url?: string
}

export interface InSessionCollectResult {
  txHash: `0x${string}`
  summary: string
  collected: number
  skipped: Array<{ collection: string; tokenId: string; reason: string }>
}

interface BatchEnvelope {
  calls?: AgentCall[]
  records?: AgentRecordHint[]
  summary?: string
  skipped?: Array<{ collection: string; tokenId: string; reason: string }>
  error?: string
}

export async function collectInSession(items: CollectItemRef[]): Promise<InSessionCollectResult> {
  if (items.length === 0) throw new Error('Nothing to collect')

  const { universal, subAccount } = await connectCollectingAccount()

  // 1. Prepare the batch: the sub-account SENDS + pays (account), the user's
  //    universal Base Account RECEIVES (recipient = mintTo), so collected NFTs
  //    land in the user's main collection and show on their profile.
  const res = await fetch('/api/agent/prepare-collect-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, account: subAccount, recipient: universal }),
  })
  const env = (await res.json().catch(() => ({}))) as BatchEnvelope
  if (!res.ok) throw new Error(env.error ?? 'Could not prepare the collect')
  if (!env.calls || env.calls.length === 0) throw new Error('None of these are currently collectable')

  // 2. One popup-less batch from the sub-account, auto-funded within the budget.
  const bundleId = await sendCollectCallsFromSubAccount(subAccount, env.calls)
  const txHash = await waitForCollectTxHash(bundleId)

  // 3. Record each collect (idempotent, on-chain-verified). Best-effort: the
  //    mints already happened on-chain regardless of recording.
  await Promise.all(
    (env.records ?? []).map((r) =>
      fetch(r.url, {
        method: r.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...r.bodyTemplate, txHash }),
      }).catch(() => undefined),
    ),
  )

  return {
    txHash,
    summary: env.summary ?? 'Collected',
    collected: env.records?.length ?? 0,
    skipped: env.skipped ?? [],
  }
}
