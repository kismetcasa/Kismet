'use client'

import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { base } from 'wagmi/chains'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { wagmiConfig } from '@/lib/wagmi'
import { AdminProvider } from '@/contexts/AdminContext'
import { WalletConnectKeepalive } from '@/hooks/useWalletConnectKeepalive'
import { BaseAppAutoConnect } from '@/hooks/useBaseAppAutoConnect'

import '@rainbow-me/rainbowkit/styles.css'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <WalletConnectKeepalive />
      <QueryClientProvider client={queryClient}>
        {/* Must be inside QueryClientProvider — connect() is a react-query mutation. */}
        <BaseAppAutoConnect />
        <RainbowKitProvider
          initialChain={base}
          theme={darkTheme({
            // Match the Kismet brand accent (magenta — middle stop of
            // .accent-grad). Keeps RainbowKit's connect-wallet modal in
            // the same palette as the rest of the app. Dark foreground
            // gets ~9:1 contrast on this pastel.
            accentColor: '#ff87ce',
            accentColorForeground: '#0d0d0d',
            borderRadius: 'none',
            fontStack: 'system',
          })}
        >
          <AdminProvider>{children}</AdminProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
