import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

// Prefers a server-only BASE_RPC_URL, falling back to NEXT_PUBLIC_BASE_RPC_URL
// (the same env var the wagmi config reads on the client) so server-side reads
// use a configured paid RPC instead of Base's public endpoint. Falls through
// to undefined/public when both are unset —
// transport: http() with no URL hits mainnet.base.org which rate-limits
// aggressively under load and surfaces as "over rate limit" errors in
// the airdrop authorize precheck and similar paths.
//
// Cached at module scope: viem's client is stateless and undici already
// keeps sockets alive across `fetch()` calls, so re-creating the client
// per request was pure allocation overhead.
function createClient() {
  return createPublicClient({
    chain: base,
    // Prefer a server-only key (BASE_RPC_URL) for server-side reads so the
    // paid endpoint isn't the NEXT_PUBLIC_ one inlined into the client bundle.
    // Falls back to the public var when unset (current behavior → non-breaking).
    // Mirrors MAINNET_RPC_URL's server-only pattern for ENS in /api/profile.
    transport: http(process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL),
  })
}

let cached: ReturnType<typeof createClient> | undefined

export function serverBaseClient() {
  if (cached) return cached
  cached = createClient()
  return cached
}

/**
 * RPC options for @base-org/account spend-permission calls (getPermissionStatus,
 * prepareSpendCallData). The SDK's node build defaults to viem's URL-less
 * `http()` transport — i.e. the public mainnet.base.org endpoint that rate-limits
 * aggressively under load (the exact failure mode the comment above describes for
 * our own reads). Autonomous spending must not depend on a shared public RPC, so
 * every server-side SDK call passes this: the configured paid endpoint when set,
 * else undefined (SDK default — unchanged dev behavior).
 */
export function sdkRpcOptions(): { rpcUrl: string } | undefined {
  const url = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL
  return url ? { rpcUrl: url } : undefined
}
