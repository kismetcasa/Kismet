'use client'

import { useCallback } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { createSiweMessage } from 'viem/siwe'
import { base } from 'wagmi/chains'
import { useFarcaster } from '@/providers/FarcasterProvider'

/**
 * Ensures the wallet has a valid Kismet session, prompting one wallet
 * signature if not. Auth state lives in an httpOnly session cookie
 * set by `POST /api/session`; the client never sees the token, so an XSS
 * can't exfiltrate it. Server-controlled TTL via cookie Max-Age — no
 * client-side clock to drift.
 *
 * Two module-level caches scoped per address (so multiple useUploadSession
 * consumers share state):
 * - `validForAddress`: address the cookie was last verified for. Skips the
 *   `GET /api/session` round-trip on repeat calls.
 * - `inFlight`: a single shared Promise for an active sign-in flow. If two
 *   call sites fire `ensureSession()` concurrently (e.g. a user clicks two
 *   mark-read actions in <1s), they coalesce onto the same wallet prompt
 *   instead of triggering two separate signature requests.
 *
 * If a different wallet connects, both caches invalidate on next call and
 * we re-validate against the server.
 */
let validForAddress: string | null = null
let inFlight: { address: string; promise: Promise<void> } | null = null

export function useUploadSession() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { isInMiniApp } = useFarcaster()

  const ensureSession = useCallback(async (): Promise<void> => {
    // Mini App users are already authenticated via Quick Auth — the JWT
    // is auto-attached to every same-origin fetch by
    // FarcasterProvider's interceptor (see providers/FarcasterProvider.tsx),
    // and server-side getSessionAddress() accepts it as a parallel auth
    // path to the cookie. No SIWE signature needed; would just confuse
    // the user with a redundant signing prompt.
    if (isInMiniApp) return

    if (!address) throw new Error('Wallet not connected')
    const lower = address.toLowerCase()

    if (validForAddress === lower) return

    // Coalesce concurrent calls onto a single sign-in flow.
    if (inFlight && inFlight.address === lower) return inFlight.promise

    const promise = (async () => {
      // Validate the existing cookie (if any) on the server. Single round-trip;
      // returns 401 if no cookie or expired.
      const probe = await fetch('/api/session', { method: 'GET', credentials: 'same-origin' })
      if (probe.ok) {
        const data = (await probe.json().catch(() => ({}))) as { address?: string }
        if (data.address?.toLowerCase() === lower) {
          validForAddress = lower
          return
        }
        // Cookie belongs to a different address — drop it and re-auth.
        await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {})
      }

      // No valid session — run the sign-in flow. SIWE message format so
      // the server can bind verification to the host (anti-phishing) and
      // wallets render the domain prominently in the typed signing UI.
      const nonceRes = await fetch(`/api/profile/${address}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce')

      const issuedAt = new Date()
      const message = createSiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to Kismet',
        uri: window.location.origin,
        version: '1',
        chainId: base.id,
        nonce,
        issuedAt,
        // The single-use nonce (server-side, 5-min TTL) is the real replay
        // bound. expirationTime is belt-and-suspenders, set comfortably
        // wider than the nonce TTL so client/server clock skew can't
        // falsely reject a valid sign-in before the nonce itself expires.
        expirationTime: new Date(issuedAt.getTime() + 15 * 60 * 1000),
      })
      const signature = await signMessageAsync({ message })

      const res = await fetch('/api/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; address?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Session creation failed')

      validForAddress = lower
    })()

    inFlight = { address: lower, promise }
    try {
      await promise
    } finally {
      // Clear only if our entry is still the one in flight — guards against
      // a wallet-switch racing with the in-flight clear.
      if (inFlight && inFlight.address === lower && inFlight.promise === promise) {
        inFlight = null
      }
    }
  }, [address, signMessageAsync, isInMiniApp])

  return { ensureSession }
}
