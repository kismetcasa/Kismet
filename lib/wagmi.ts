import { createConfig, http } from 'wagmi'
import { base, mainnet } from 'wagmi/chains'
import { connectorsForWallets, getDefaultWallets } from '@rainbow-me/rainbowkit'
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector'

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

// Manual config (rather than RainbowKit's `getDefaultConfig`) is required
// because we need to prepend a non-RainbowKit connector — the Farcaster
// Mini App connector — to the connectors array. RainbowKit's wallet list
// is preserved via getDefaultWallets() → connectorsForWallets() so the
// regular-web UX is unchanged: same modal, same wallet options.
const { wallets } = getDefaultWallets()
const rainbowKitConnectors = connectorsForWallets(wallets, {
  appName: 'Kismet',
  projectId: projectId ?? 'placeholder-build-only',
})

export const wagmiConfig = createConfig({
  chains: [base, mainnet],
  // Farcaster connector FIRST so wagmi's reconnect-on-mount tries it
  // before any RainbowKit wallet. Its `isAuthorized()` returns true
  // only inside a Mini App host (eth_accounts resolves to the host
  // wallet) and false everywhere else, so on regular web wagmi falls
  // through to whichever wallet the user last connected via the
  // RainbowKit modal — no behavior change for existing web users.
  connectors: [farcasterMiniApp(), ...rainbowKitConnectors],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
    // Mainnet is included solely for client-side ENS resolution via useEnsName
    [mainnet.id]: http(process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
  },
  ssr: true,
})
