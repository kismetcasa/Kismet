import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { base, mainnet } from 'wagmi/chains'
import { http } from 'wagmi'

export const wagmiConfig = getDefaultConfig({
  appName: 'Kismet Art',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID!,
  chains: [base, mainnet],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    // Mainnet is included solely for client-side ENS resolution via useEnsName
    [mainnet.id]: http(process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
  },
  ssr: true,
})
