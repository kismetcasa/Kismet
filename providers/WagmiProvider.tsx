'use client'

import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { WagmiProvider } from 'wagmi'
import { base } from 'wagmi/chains'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { wagmiConfig } from '@/lib/wagmi'
import { AdminProvider } from '@/contexts/AdminContext'

import '@rainbow-me/rainbowkit/styles.css'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          initialChain={base}
          theme={darkTheme({
            accentColor: '#7C3AED',
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
