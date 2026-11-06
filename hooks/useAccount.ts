'use client'

import { useSyncExternalStore } from 'react'
import { useAccount as useWagmiAccount } from 'wagmi'

// wagmi's useAccount, reporting the account the server rendered — none —
// until the component reading it has hydrated (React error #418).
//
// The server never knows the wallet, so every page is rendered disconnected.
// wagmi reconnects once the root has mounted (lib/wagmi `ssr: true`), but a
// page's own content streams in behind a Suspense boundary (its loading.tsx)
// and can hydrate after that, and wagmi hands a hydrating component the same
// live account as a mounted one (its server snapshot IS its client snapshot).
// In a wallet's own browser, whose injected wallet connects as the page
// mounts (hooks/useBaseAppAutoConnect), the owner's view of their profile or
// artwork then hydrated over the visitor's HTML, and React threw the page's
// HTML away to render it again. Here a hydrating component reads what the
// server had and renders the real account right after; one mounted after a
// navigation reads it at once. eslint.config.mjs routes every useAccount
// here.

const noSubscription = () => () => {}

/** True once this component has hydrated, or when it mounted on the client. */
function useHydrated(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false)
}

/** What wagmi reports with no wallet connected (@wagmi/core getAccount). */
const SERVER_ACCOUNT = {
  address: undefined,
  addresses: undefined,
  chain: undefined,
  chainId: undefined,
  connector: undefined,
  isConnected: false,
  isConnecting: false,
  isDisconnected: true,
  isReconnecting: false,
  status: 'disconnected',
} as const satisfies ReturnType<typeof useWagmiAccount>

export function useAccount(parameters?: Parameters<typeof useWagmiAccount>[0]): ReturnType<typeof useWagmiAccount> {
  const account = useWagmiAccount(parameters)
  return useHydrated() ? account : SERVER_ACCOUNT
}
