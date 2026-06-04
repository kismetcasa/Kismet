import { createConfig, http, type CreateConnectorFn } from 'wagmi'
import { createClient } from 'viem'
import { base, mainnet } from 'wagmi/chains'
import { connectorsForWallets, getDefaultWallets } from '@rainbow-me/rainbowkit'
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector'
import { isPotentialMiniAppEnv } from '@/lib/miniAppEnv'
import { publicRpcUrl } from '@/lib/chains'

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
// regular-web UX is unchanged: same modal, same wallet options. (That list
// already includes Base Account, and wagmi's EIP-6963 discovery — on by
// default — picks up the Base App's injected provider, so the Base App's
// "standard web app" wallet path is fully covered without a bespoke
// connector here.)
const { wallets } = getDefaultWallets()
const rainbowKitConnectors = connectorsForWallets(wallets, {
  appName: 'Kismet',
  projectId: projectId ?? 'placeholder-build-only',
})

// Max time we'll wait for a Farcaster Mini App host to answer a
// non-interactive connection-probe RPC before treating it as unavailable.
// Genuine hosts (Farcaster web, FC iOS) answer their postMessage bridge in
// a few ms, so this never trips for them. Belt-and-suspenders fallback
// for an unknown embedded WebView that looks like a Mini App env but
// doesn't speak the protocol — the Base App used to be the headline case
// before lib/miniAppEnv.ts learned to short-circuit Coinbase WebViews
// directly.
//
// Why it matters: the connector's eth_accounts call rides a Comlink
// postMessage bridge with no timeout of its own. On a dead bridge it never
// resolves, and because wagmi's reconnect-on-mount awaits connectors
// serially, an unbounded call on the first connector pins the entire
// wallet state in 'connecting'/'reconnecting' forever — the wallet button
// never settles and nothing can sign. Bounding the probe makes
// isAuthorized() resolve to false (its own try/catch swallows the
// rejection) and connect() reject (caught by reconnect), so wagmi falls
// through to the remaining connectors and reaches 'disconnected'.
const HOST_RPC_TIMEOUT_MS = 1500

// Only the non-interactive lifecycle RPCs the connector fires during
// reconnect-on-mount get time-bounded — these are the calls that hang
// forever on a dead bridge. Interactive methods (eth_sendTransaction,
// wallet_sendCalls, personal_sign, eth_signTypedData*, and the
// user-prompting wallet_switchEthereumChain) are deliberately EXCLUDED:
// they legitimately take seconds while the host shows its confirm sheet and
// waits for the human, so bounding them would fire a spurious "host did not
// respond" mid-signature even though the transaction goes on to succeed.
const TIME_BOUNDED_METHODS = new Set([
  'eth_accounts', // isAuthorized() probe — the dead-bridge culprit
  'eth_requestAccounts', // connect() — auto-resolved by a live host
  'eth_chainId', // getChainId() — instant on a live host
])

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Wrap an EIP-1193 provider so the non-interactive connection-probe
// requests in TIME_BOUNDED_METHODS are time-bounded, while interactive
// requests (signing, sending, chain switch) pass through untouched. All
// other members pass straight through, bound to the original provider so
// `this` stays correct — notably the `on`/`removeListener` event-emitter
// methods the Farcaster connector asserts exist before subscribing.
function timeBoundProvider<T extends object>(provider: T): T {
  return new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (prop === 'request' && typeof value === 'function') {
        const request = value as (...args: unknown[]) => Promise<unknown>
        return (...args: unknown[]) => {
          const arg = args[0]
          const method =
            typeof arg === 'object' && arg !== null
              ? (arg as { method?: unknown }).method
              : undefined
          const result = request.apply(target, args)
          if (typeof method === 'string' && TIME_BOUNDED_METHODS.has(method)) {
            return withTimeout(
              result,
              HOST_RPC_TIMEOUT_MS,
              'Farcaster Mini App host did not respond',
            )
          }
          return result
        }
      }
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

// farcasterMiniApp() with its host RPC calls time-bounded. We spread the
// inner connector and override only getProvider; wagmi's setup() spreads
// our object in turn, so the final connector's this-based methods
// (isAuthorized → getAccounts → getProvider, and connect → getProvider)
// all resolve to the wrapped provider.
function farcasterMiniAppTimeBounded(): CreateConnectorFn {
  const inner = farcasterMiniApp()
  const wrapped = ((params: Parameters<typeof inner>[0]) => {
    const connector = inner(params)
    return {
      ...connector,
      getProvider: async (parameters?: { chainId?: number }) =>
        timeBoundProvider(await connector.getProvider(parameters)),
    }
  }) satisfies typeof inner
  return wrapped
}

export const wagmiConfig = createConfig({
  chains: [base, mainnet],
  // Farcaster connector FIRST (when present) so wagmi's reconnect-on-mount
  // tries it before any RainbowKit wallet. We only register it in embedded
  // contexts (iframe / RN WebView) that are NOT a Coinbase WebView — a
  // regular browser tab is never a Farcaster host, and the Base App (which
  // dropped the Mini App spec in April 2026) is a Coinbase WebView that
  // looks embedded but auto-connects via its injected provider through
  // wagmi's EIP-6963 discovery. isPotentialMiniAppEnv() short-circuits
  // both cases to false, so the FC connector is omitted and the standard
  // web wallet path runs without a guaranteed-unauthorized probe burning
  // the 1.5s timeout. SSR also returns false (no window) so the server
  // build simply omits the FC connector — the client config is
  // authoritative for runtime connection behavior.
  connectors: [
    ...(isPotentialMiniAppEnv() ? [farcasterMiniAppTimeBounded()] : []),
    ...rainbowKitConnectors,
  ],
  // `client` factory (not `transports`) because Multicall3 batching is
  // a viem Client option, not an http transport option. Both supported chains
  // get multicall batching: Base drives mints/collects, and mainnet now serves
  // protocol reads (collect/list eligibility) in addition to ENS — viem's ENS
  // actions are unaffected by batching. Per-chain RPC URL comes from the chain
  // registry (NEXT_PUBLIC_*_RPC_URL).
  client({ chain }) {
    return createClient({
      chain,
      transport: http(publicRpcUrl(chain.id), { batch: true }),
      batch: { multicall: true },
    })
  },
  ssr: true,
})
