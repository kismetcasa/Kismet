'use client'

import { useCallback } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import {
  buildIntentMessage,
  buildMintBindings,
  type IntentAction,
  type IntentEnvelope,
  type MintBody,
} from '@/lib/intent'

interface SignMintIntentResult {
  intent: IntentEnvelope
  /** Echoed back so the caller can spread it into the request body
   *  unchanged — they should never construct the envelope themselves. */
  account: string
}

/**
 * Client-side per-action intent signer. Pairs with /api/auth/intent-nonce
 * (issuer) and lib/intentAuth.verifyIntent (server verifier). One wallet
 * prompt produces a signature bound to the exact mint/write body — any
 * field the server cares about (collection, tokenURI, price, splits,
 * payoutRecipient, …) is canonicalized into the signed message via
 * buildMintBindings, so a man-in-the-middle who tampers with the body
 * after signing invalidates the signature.
 *
 * Replay-safe: the nonce is single-use server-side, consumed only after a
 * successful verification. The signature is therefore non-replayable
 * across requests AND non-substitutable across actions (the message
 * embeds the action name).
 */
export function useIntentAuth() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const signMintIntent = useCallback(
    async (
      body: MintBody,
      action: IntentAction = 'mint',
    ): Promise<SignMintIntentResult> => {
      if (!address) throw new Error('Wallet not connected')

      // Fetch a fresh nonce + expiry from the server. The expiry is what
      // the server signed off on; we echo it back unchanged so the server
      // can rebuild the same message during verification.
      const nonceRes = await fetch('/api/auth/intent-nonce', { method: 'POST' })
      if (!nonceRes.ok) throw new Error('Failed to obtain intent nonce')
      const { nonce, expiresAt } = (await nonceRes.json()) as {
        nonce: string
        expiresAt: number
      }

      const bindings = buildMintBindings({ ...body, account: address })
      const message = buildIntentMessage(action, bindings, nonce, expiresAt)
      const signature = await signMessageAsync({ message })

      return {
        intent: { signature, nonce, expiresAt },
        account: address,
      }
    },
    [address, signMessageAsync],
  )

  return { signMintIntent }
}
