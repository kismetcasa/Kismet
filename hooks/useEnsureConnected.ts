'use client'

import { useCallback } from 'react'
import { useConfig, useConnect } from 'wagmi'
import { getAccount } from '@wagmi/core'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import type { Address } from 'viem'
import { isCoinbaseWebView, isPotentialMiniAppEnv } from '@/lib/miniAppEnv'

/**
 * Resolve a connected wallet address, connecting on demand.
 *
 * Inside an embedded wallet host (Farcaster Mini App or Coinbase WebView) the
 * usable wallet is the host wallet, wired through the non-RainbowKit
 * `farcaster`/`injected` connector (see lib/wagmi.ts). RainbowKit's
 * `openConnectModal` can't connect it — and is `undefined` while wagmi is
 * mid-auto-connect (status 'connecting'/'reconnecting'), so the old
 * `openConnectModal?.()` fallback was a silent no-op there. We connect that
 * connector directly and return the fresh address (read from the store, since
 * React hasn't re-rendered within the same tap). On web we keep the modal.
 */
export function useEnsureConnected(): () => Promise<Address | null> {
  const config = useConfig()
  const { connectAsync, connectors } = useConnect()
  const { openConnectModal } = useConnectModal()

  return useCallback(async (): Promise<Address | null> => {
    // Authoritative read — reflects a wallet connected earlier this tap too.
    const current = getAccount(config)
    if (current.status === 'connected' && current.address) return current.address

    const hostId = isPotentialMiniAppEnv() ? 'farcaster' : isCoinbaseWebView() ? 'injected' : null
    const connector = hostId ? connectors.find((c) => c.id === hostId) : undefined
    if (connector) {
      try {
        return (await connectAsync({ connector })).accounts[0] ?? null
      } catch {
        // Host wallet declined / unavailable (Base App and other hosts where
        // the eth_accounts handoff doesn't fire). Swallowing this used to make
        // the collect/mint tap a silent no-op — the only escape was knowing to
        // tap your own name in the nav. Fall through to the picker instead, so
        // recovery happens at the moment of intent.
        openConnectModal?.()
        return null
      }
    }

    // Regular web: hand off to the picker, let the user retry.
    openConnectModal?.()
    return null
  }, [config, connectAsync, connectors, openConnectModal])
}
