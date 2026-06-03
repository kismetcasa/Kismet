import { createPublicClient, http, fallback } from 'viem'
import { base } from 'viem/chains'

// Server-side Base client. Prefers a server-only BASE_RPC_URL over the
// NEXT_PUBLIC_ one (so the paid key driving server reads isn't inlined into
// the client bundle), falling through to undefined/public when both are unset
// (http() with no URL hits mainnet.base.org, which rate-limits aggressively
// under load). Adds a second provider for failover when BASE_RPC_URL_FALLBACK
// is set.
//
// Cached at module scope: viem's client is stateless and undici already
// keeps sockets alive across `fetch()` calls, so re-creating the client
// per request was pure allocation overhead.
function createClient() {
  const primary = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL
  // viem `fallback` is deterministic FAILOVER (primary first; advance to the
  // next only on a retryable transport error — 429/timeout/5xx), NOT load-
  // balancing. It deliberately does NOT fail over on contract reverts, so
  // there's no double-execution. Added only when a distinct fallback provider
  // is configured → a single transport (non-breaking) when unset.
  const backup = process.env.BASE_RPC_URL_FALLBACK
  const transport = backup ? fallback([http(primary), http(backup)]) : http(primary)
  return createPublicClient({ chain: base, transport })
}

let cached: ReturnType<typeof createClient> | undefined

export function serverBaseClient() {
  if (cached) return cached
  cached = createClient()
  return cached
}
