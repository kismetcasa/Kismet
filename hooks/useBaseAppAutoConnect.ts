'use client'

import { useEffect, useRef } from 'react'
import { useConnect } from 'wagmi'
import { isCoinbaseWebView } from '@/lib/miniAppEnv'

// Auto-connect the Base App's injected wallet on first open. A Coinbase WebView
// injects a wallet that wagmi/RainbowKit discovery can't surface and wouldn't
// auto-connect anyway (see isCoinbaseWebView in lib/miniAppEnv and the
// injected() connector in lib/wagmi.ts); wagmi's reconnect-on-mount covers
// return visits, so this only has to handle the first open.
export function useBaseAppAutoConnect(): void {
  const { connect, connectors } = useConnect()
  const attemptedRef = useRef(false)

  useEffect(() => {
    if (attemptedRef.current || !isCoinbaseWebView()) return
    attemptedRef.current = true
    const injected = connectors.find((c) => c.id === 'injected')
    if (injected) connect({ connector: injected })
  }, [connect, connectors])
}

/**
 * Mount-only wrapper around the hook. Drop a single instance inside the
 * WagmiProvider tree to enable Base App auto-connect.
 */
export function BaseAppAutoConnect(): null {
  useBaseAppAutoConnect()
  return null
}
