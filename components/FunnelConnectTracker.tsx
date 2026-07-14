'use client'

import { useAccountEffect } from 'wagmi'
import { trackFunnel } from '@/lib/funnel'

/**
 * Counts successful wallet connections for the first-party funnel
 * (lib/funnel.ts). Fresh connections only — wagmi's silent auto-reconnect on
 * page load is a returning session, not a conversion, so isReconnected is
 * filtered out. Renders nothing; mounted once inside WagmiProvider.
 */
export function FunnelConnectTracker() {
  useAccountEffect({
    onConnect({ isReconnected }) {
      if (!isReconnected) trackFunnel('connect_success')
    },
  })
  return null
}
