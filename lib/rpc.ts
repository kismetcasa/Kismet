import { createPublicClient, http } from 'viem'
import { base, mainnet } from 'viem/chains'

// Honors NEXT_PUBLIC_BASE_RPC_URL (same env var the wagmi config reads on
// the client) so server-side reads use the configured paid RPC instead of
// Base's public endpoint. Falls through to undefined/public when unset —
// transport: http() with no URL hits mainnet.base.org which rate-limits
// aggressively under load and surfaces as "over rate limit" errors in
// the airdrop authorize precheck and similar paths.
export function serverBaseClient() {
  return createPublicClient({
    chain: base,
    transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
  })
}

// Mainnet read client — used for ENS resolution on the server.
export function serverMainnetClient() {
  return createPublicClient({
    chain: mainnet,
    transport: http(process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
  })
}
