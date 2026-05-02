'use client'

import { useCallback } from 'react'
import { useAccount, useSignMessage } from 'wagmi'

const storageKey = (address: string) => `kismetart:session:${address.toLowerCase()}`
const SESSION_BUFFER_MS = 60_000 // refresh 1 min before expiry

interface StoredSession {
  token: string
  expiresAt: number
}

export function useUploadSession() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const ensureSession = useCallback(async (): Promise<string> => {
    if (!address) throw new Error('Wallet not connected')

    // Return cached session if still valid
    try {
      const raw = localStorage.getItem(storageKey(address))
      if (raw) {
        const stored = JSON.parse(raw) as StoredSession
        if (stored.expiresAt > Date.now() + SESSION_BUFFER_MS) return stored.token
      }
    } catch {}

    // Create a new session — one wallet signature
    const { nonce } = await fetch(`/api/profile/${address}/nonce`).then((r) => r.json())
    const message = `Sign in to Kismet Art\nAddress: ${address.toLowerCase()}\nNonce: ${nonce}`
    const signature = await signMessageAsync({ message })

    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, signature, nonce }),
    })
    const data = await res.json() as { sessionToken?: string; error?: string }
    if (!res.ok) throw new Error(data.error ?? 'Session creation failed')

    const stored: StoredSession = {
      token: data.sessionToken!,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    }
    try {
      localStorage.setItem(storageKey(address), JSON.stringify(stored))
    } catch {}

    return stored.token
  }, [address, signMessageAsync])

  return { ensureSession }
}
