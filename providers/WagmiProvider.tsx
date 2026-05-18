'use client'

import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { base } from 'wagmi/chains'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { wagmiConfig } from '@/lib/wagmi'
import { AdminProvider } from '@/contexts/AdminContext'
import { SharedVideoProvider } from '@/providers/SharedVideoProvider'

import '@rainbow-me/rainbowkit/styles.css'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          initialChain={base}
          theme={darkTheme({
            // Match Kismet's brand accent (logo violet, also the first
            // stop of .accent-grad). Keeps RainbowKit's connect-wallet
            // modal in the same palette as the rest of the app. Dark
            // foreground still has ample contrast on this pastel violet.
            accentColor: '#bf81f2',
            accentColorForeground: '#0d0d0d',
            borderRadius: 'none',
            fontStack: 'system',
          })}
        >
          <AdminProvider>
            <SharedVideoProvider>{children}</SharedVideoProvider>
          </AdminProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
