'use client'

import { useCallback } from 'react'
import { useAccount, useConfig, useConnect } from 'wagmi'
import { getAccount } from '@wagmi/core'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import type { Address } from 'viem'
import { isCoinbaseWebView, isPotentialMiniAppEnv } from '@/lib/miniAppEnv'

/**
 * Resolve a connected wallet address, connecting on demand.
 *
 * The historical fallback for an unconnected wallet — `openConnectModal?.()`
 * — breaks inside an embedded wallet host (a Farcaster Mini App or a Coinbase
 * WebView) for two reasons:
 *
 *   1. RainbowKit only defines `openConnectModal` while wagmi.status is
 *      'disconnected'. During the host-wallet auto-connect window (status
 *      'connecting' / 'reconnecting' — exactly when an eager user first taps
 *      Collect) it is `undefined`, so `openConnectModal?.()` is a silent
 *      no-op and the button looks dead. See hooks/useWalletRecovery.
 *   2. Even once defined, RainbowKit's picker lists web wallets only; the
 *      host wallet is wired through the non-RainbowKit `farcaster` /
 *      `injected` connector (see lib/wagmi.ts), so the modal can't connect
 *      the one wallet that actually works in this context.
 *
 * Inside a host we therefore connect that connector directly and await it,
 * then read the address straight from the wagmi store (the React
 * `useAccount` value won't have re-rendered yet within the same tap) so the
 * caller can proceed in the same gesture. On regular web we keep the
 * RainbowKit modal and return null — the user picks a wallet and taps again.
 */
export function useEnsureConnected(): () => Promise<Address | null> {
  const { address } = useAccount()
  const config = useConfig()
  const { connectAsync, connectors } = useConnect()
  const { openConnectModal } = useConnectModal()

  return useCallback(async (): Promise<Address | null> => {
    // Already connected — prefer the React value, fall back to the store for
    // the just-connected case where React hasn't re-rendered yet.
    if (address) return address
    const current = getAccount(config)
    if (current.status === 'connected' && current.address) return current.address

    // Embedded host: connect the host wallet's dedicated connector directly.
    // Both gates are mutually exclusive (a Coinbase WebView short-circuits
    // isPotentialMiniAppEnv to false), matching lib/wagmi.ts's connector set.
    const hostConnectorId = isPotentialMiniAppEnv()
      ? 'farcaster'
      : isCoinbaseWebView()
        ? 'injected'
        : null
    if (hostConnectorId) {
      const connector = connectors.find((c) => c.id === hostConnectorId)
      if (connector) {
        try {
          const res = await connectAsync({ connector })
          return res.accounts[0] ?? null
        } catch {
          // Host wallet declined / unavailable — return null rather than
          // dispatching an unsigned write; the caller stays put.
          return null
        }
      }
    }

    // Regular web: hand off to the wallet picker and let the user retry.
    openConnectModal?.()
    return null
  }, [address, config, connectAsync, connectors, openConnectModal])
}
