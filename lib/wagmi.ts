import { createConfig, http, type CreateConnectorFn } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { createClient } from 'viem'
import { base, mainnet } from 'wagmi/chains'
import { connectorsForWallets, getDefaultWallets } from '@rainbow-me/rainbowkit'
import { farcasterMiniApp } from '@farcaster/miniapp-wagmi-connector'
import { isCoinbaseWebView, isPotentialMiniAppEnv } from '@/lib/miniAppEnv'

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
// because we register non-RainbowKit connectors — the Farcaster Mini App
// connector and a plain injected() for Coinbase WebViews — in the connectors
// array below. RainbowKit's wallet list is preserved via getDefaultWallets()
// → connectorsForWallets(), so the regular-web modal is unchanged — and it
// already includes Base Account (Base's other recommended connector), so only
// injected(), for the in-app browser, needs adding here.
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
  // Two non-RainbowKit connectors, each gated to its environment and mutually
  // exclusive (isCoinbaseWebView() implies isPotentialMiniAppEnv() is false):
  //   1. Farcaster Mini App connector FIRST so wagmi's reconnect-on-mount
  //      tries it before any RainbowKit wallet. Registered only in real
  //      embedded Farcaster contexts (iframe / RN WebView); time-bounded so a
  //      dead host bridge can't pin wagmi's serial reconnect on the 1.5s
  //      timeout.
  //   2. injected() for Coinbase WebViews (the Base App + Coinbase Wallet
  //      browser). They dropped the Mini App spec and inject an EIP-1193
  //      provider that is NOT announced over EIP-6963, so RainbowKit's
  //      discovery never surfaces it. This plain connector targets that
  //      window.ethereum; hooks/useBaseAppAutoConnect connects it on mount.
  // Both gates return false during SSR (no window), so the server build omits
  // both — the client config is authoritative at runtime.
  connectors: [
    ...(isPotentialMiniAppEnv() ? [farcasterMiniAppTimeBounded()] : []),
    ...(isCoinbaseWebView() ? [injected()] : []),
    ...rainbowKitConnectors,
  ],
  // `client` factory (not `transports`) because Multicall3 batching is
  // a viem Client option, not an http transport option.
  client({ chain }) {
    if (chain.id === base.id) {
      return createClient({
        chain,
        transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL, { batch: true }),
        batch: { multicall: true },
      })
    }
    // Mainnet is only used for client-side ENS resolution via useEnsName.
    return createClient({
      chain,
      transport: http(process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
    })
  },
  ssr: true,
})
