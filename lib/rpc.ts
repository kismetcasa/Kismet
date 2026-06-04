import { createPublicClient, http } from 'viem'
import {
  BASE_CHAIN_ID,
  DEFAULT_CHAIN_ID,
  getChain,
  serverRpcUrl,
  type ChainConfig,
  type SupportedChainId,
} from './chains'

// Server-side public client, one per chain. Prefers a server-only RPC URL
// (BASE_RPC_URL / MAINNET_RPC_URL), falling back to the NEXT_PUBLIC_ one so
// server reads use a configured paid endpoint instead of the public node
// (which rate-limits aggressively under load). See lib/chains.ts serverRpcUrl.
//
// Clients are cached per chain at module scope: viem's client is stateless and
// undici keeps sockets alive across fetch() calls, so re-creating per request
// is pure allocation overhead.
function createClient(cfg: ChainConfig) {
  return createPublicClient({
    chain: cfg.chain,
    transport: http(serverRpcUrl(cfg.chainId)),
  })
}

const cache = new Map<SupportedChainId, ReturnType<typeof createClient>>()

/** Server public client for `chainId` (defaults to Base). Throws on an
 *  unsupported chain so a bad id surfaces immediately rather than reading the
 *  wrong network. */
export function serverClient(chainId: number = DEFAULT_CHAIN_ID) {
  const cfg = getChain(chainId)
  const cached = cache.get(cfg.chainId)
  if (cached) return cached
  const client = createClient(cfg)
  cache.set(cfg.chainId, client)
  return client
}

/** Back-compat alias — the Base server client. Prefer `serverClient(chainId)`
 *  in new code so the read targets the moment's / collection's actual chain. */
export function serverBaseClient() {
  return serverClient(BASE_CHAIN_ID)
}
