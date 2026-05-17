import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { base, mainnet } from 'wagmi/chains'
import { http } from 'wagmi'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

// Warn-and-continue rather than throw: Next.js prerenders the root
// layout's Providers tree during `Collecting page data`, and env vars
// aren't always populated at that step. Throwing here would kill the
// build for any route that touches the layout. A placeholder keeps
// build green; if the real ID is genuinely missing in prod, RainbowKit
// surfaces the misconfig the moment a wallet UI mounts.
if (!projectId) {
  console.warn(
    '[wagmi] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID not set — wallet connect will not work at runtime',
  )
}

export const wagmiConfig = getDefaultConfig({
  appName: 'Kismet',
  projectId: projectId ?? 'placeholder-build-only',
  chains: [base, mainnet],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    // Mainnet is included solely for client-side ENS resolution via useEnsName
    [mainnet.id]: http(process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
  },
  ssr: true,
})
