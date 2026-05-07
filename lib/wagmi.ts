import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { base, mainnet } from 'wagmi/chains'
import { http } from 'wagmi'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
if (!projectId) {
  // Fail fast at module load with an actionable message rather than the
  // cryptic RainbowKit error that surfaces deep in prerender otherwise.
  throw new Error(
    'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required. Get one at https://cloud.walletconnect.com',
  )
}

export const wagmiConfig = getDefaultConfig({
  appName: 'Kismet Art',
  projectId,
  chains: [base, mainnet],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    // Mainnet is included solely for client-side ENS resolution via useEnsName
    [mainnet.id]: http(process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
  },
  ssr: true,
})
