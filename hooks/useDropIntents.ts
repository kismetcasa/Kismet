'use client'

import { useCallback } from 'react'
import { KISMET_INTENT_DOMAIN, type IntentEnvelope } from '@/lib/intent'
import {
  buildClaimDropMessage,
  buildOpenDropMessage,
  CLAIM_DROP_TYPES,
  OPEN_DROP_TYPES,
  type OpenDropFields,
} from '@/lib/drops'
import { useSignTypedData } from '@/hooks/useWallet'
import { useEnsureBase } from '@/lib/useEnsureBase'

/**
 * Wallet prompts for claim drops: one EIP-712 signature to open a drop, one
 * to claim it. Neither is a transaction — no gas, no fee, no ETH needed —
 * and both use the mint intent's domain (Kismet, Base) and server-issued
 * single-use nonce, verified by lib/intentAuth.verifyTypedIntent.
 *
 * The wallet is moved to Base first: some wallets refuse to sign typed data
 * whose domain chainId differs from the active chain.
 */
async function fetchIntentNonce(): Promise<{ nonce: string; expiresAt: number }> {
  const res = await fetch('/api/auth/intent-nonce', { method: 'POST' })
  if (!res.ok) throw new Error('Could not start the signature — try again')
  return (await res.json()) as { nonce: string; expiresAt: number }
}

export function useDropIntents() {
  const { signTypedDataAsync } = useSignTypedData()
  const ensureBase = useEnsureBase()

  const signOpenDrop = useCallback(
    async (account: string, fields: OpenDropFields): Promise<IntentEnvelope> => {
      await ensureBase()
      const { nonce, expiresAt } = await fetchIntentNonce()
      const signature = await signTypedDataAsync({
        domain: KISMET_INTENT_DOMAIN,
        types: OPEN_DROP_TYPES,
        primaryType: 'OpenDrop',
        message: buildOpenDropMessage(account, fields, nonce, expiresAt),
      })
      return { signature, nonce, expiresAt }
    },
    [ensureBase, signTypedDataAsync],
  )

  const signClaimDrop = useCallback(
    async (account: string, dropKey: string): Promise<IntentEnvelope> => {
      await ensureBase()
      const { nonce, expiresAt } = await fetchIntentNonce()
      const signature = await signTypedDataAsync({
        domain: KISMET_INTENT_DOMAIN,
        types: CLAIM_DROP_TYPES,
        primaryType: 'ClaimDrop',
        message: buildClaimDropMessage(account, dropKey, nonce, expiresAt),
      })
      return { signature, nonce, expiresAt }
    },
    [ensureBase, signTypedDataAsync],
  )

  return { signOpenDrop, signClaimDrop }
}
