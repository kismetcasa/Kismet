import { ccipRequest, createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import { redis } from '@/lib/redis'
import { isSafePublicHttpsUrl } from '@/lib/safeUrl'

// Shared ENS reverse-resolution cache, used by both /api/profile/[address]
// (single) and /api/profiles (batch) so the two never diverge on how a
// raw address resolves to a verified .eth name.

/**
 * CCIP-Read (EIP-3668) gateway allowlist. viem enables offchain lookups by
 * default: when a resolver reverts with OffchainLookup, the client fetches
 * whatever gateway URLs the CONTRACT names. Any wallet owner can point their
 * own reverse node at a resolver they wrote, so unguarded this let a public
 * /api/profiles request make this server fetch an attacker-chosen URL — the
 * SSRF class lib/safeUrl already closes for avatar and share-card fetches.
 * Offchain names keep working (their gateways are public https); everything
 * else is refused, and a lookup with no acceptable gateway fails like any
 * other RPC error (cached transient, no fetch ever made).
 */
export function selectSafeCcipGateways(urls: readonly string[]): string[] {
  return urls.filter((url) => {
    if (!isSafePublicHttpsUrl(url)) return false
    // The host is checked on the TEMPLATE, but viem fetches the substituted
    // URL — a {sender}/{data} placeholder in the host would let the
    // substitution pick the authority. Real gateways template the path.
    return !/[{}]/.test(new URL(url).hostname)
  })
}

function requestSafeCcipGateways(
  parameters: Parameters<typeof ccipRequest>[0],
): ReturnType<typeof ccipRequest> {
  const urls = selectSafeCcipGateways(parameters.urls)
  if (urls.length === 0) throw new Error('ENS CCIP-Read refused: no public https gateway offered')
  return ccipRequest({ ...parameters, urls })
}

// Prefer a configured RPC URL (Alchemy / Infura) to avoid rate limits on
// the public default. MAINNET_RPC_URL is the server-only override; falls
// back to NEXT_PUBLIC_MAINNET_RPC_URL (shared with the client-side ENS
// lookup in lib/wagmi.ts) when unset, then to viem's public default.
//
// timeout: viem's default is 10s; a wedged public endpoint must not pin a
// bounded inline resolve's background continuation (or a warm) that long.
// Deliberately NOT batched: viem's batch transport sends every call as a
// JSON-RPC array — a lone request included — and not every public endpoint
// accepts arrays. On one that doesn't, every resolution would fail into the
// transient sentinel and no name would ever resolve. The per-request caps in
// /api/profiles already bound the burst batching would have collapsed.
const mainnetClient = createPublicClient({
  chain: mainnet,
  ccipRead: { request: requestSafeCcipGateways },
  transport: http(process.env.MAINNET_RPC_URL ?? process.env.NEXT_PUBLIC_MAINNET_RPC_URL, {
    timeout: 5_000,
  }),
})

// TTLs. A resolved primary name is rare-write (the owner has to re-point
// their reverse record), so it can live a day; "confirmed no ENS" stays at an
// hour so a freshly registered name shows up reasonably fast. A transient RPC
// failure (rate limit, outage) gets a DISTINCT sentinel on a short TTL — long
// enough to throttle a retry storm to ~one attempt per address per window,
// short enough that a blip can't impersonate "this wallet has no ENS" for
// minutes. Same pattern as lib/farcasterProfile's TRANSIENT_SENTINEL: before
// the split, a single 429 during the warm was cached as a confirmed miss and
// every activity row for that sender rendered the bare address for 5 minutes
// with no retry scheduled.
const ENS_NAME_TTL = 24 * 60 * 60 // resolved, forward-verified names
const ENS_NONE_TTL = 60 * 60      // confirmed no ENS / failed forward-verification
const ENS_FAIL_TTL = 30           // transient resolution failure
const FAIL_SENTINEL = '!transient'

const ensKey = (address: string) => `kismetart:ens:${address.toLowerCase()}`

/**
 * Cached read, three-state:
 *   string    — verified primary name; display it.
 *   null      — known: nothing to display right now (confirmed no ENS, failed
 *               forward-verification, or a transient failure inside its
 *               throttle window). Do NOT resolve again; the TTL retries it.
 *   undefined — unknown: nothing cached, or Redis unreachable. The caller may
 *               resolve inline (bounded) or warm in the background.
 */
export async function getCachedEns(address: string): Promise<string | null | undefined> {
  try {
    const cached = await redis.get<string>(ensKey(address))
    if (cached === null) return undefined          // cache miss
    if (cached === '' || cached === FAIL_SENTINEL) return null
    return cached
  } catch {
    return undefined
  }
}

function normalizeOrNull(name: string): string | null {
  try {
    return normalize(name)
  } catch {
    return null
  }
}

/**
 * Resolve reverse + forward-verify, cache the outcome, and RETURN the
 * verified name (null when there is none, verification fails, or the lookup
 * errors) so callers can use the result in the same request instead of only
 * warming for the next one.
 *
 * ENS spec (Primary Names docs) requires forward-verification: anyone can
 * set a reverse record pointing to any name they don't control. Only
 * cache/display the name when it also forward-resolves back to this address.
 */
export async function resolveEnsAndCache(address: string): Promise<string | null> {
  const key = ensKey(address)
  try {
    const name = await mainnetClient.getEnsName({ address: address as `0x${string}` })
    // No reverse record, or one that fails ENSIP-15 normalization: both are
    // properties of the RECORD, not the network, so they cache as a
    // definitive none. A malformed record must not land in the transient
    // sentinel and re-fire the lookup every ENS_FAIL_TTL for as long as it
    // stays malformed.
    const normalized = name ? normalizeOrNull(name) : null
    if (!name || normalized === null) {
      await redis.set(key, '', { ex: ENS_NONE_TTL }).catch(() => {})
      return null
    }
    const forward = await mainnetClient.getEnsAddress({ name: normalized })
    const verified = forward?.toLowerCase() === address.toLowerCase()
    await redis
      .set(key, verified ? name : '', { ex: verified ? ENS_NAME_TTL : ENS_NONE_TTL })
      .catch(() => {})
    return verified ? name : null
  } catch {
    await redis.set(key, FAIL_SENTINEL, { ex: ENS_FAIL_TTL }).catch(() => {})
    return null
  }
}

// Unique marker so a race timeout can never be confused with a resolution
// result (getEnsName returns arbitrary reverse-record strings).
const TIMED_OUT = Symbol('ens-budget-timeout')

/**
 * Bounded inline resolution for cache misses. Races resolveEnsAndCache
 * against `budgetMs`:
 *
 *   - finished in budget → `{ ens }` — the verified name (or null), already
 *     cached, so the very response that hit the cold cache can display it.
 *     Before this existed no first view could EVER show an ENS name: the miss
 *     path only warmed the cache after the response, and the activity panel
 *     never re-resolves within a view.
 *   - budget exceeded → `{ ens: null, pending }` — the resolution keeps
 *     running; the caller must hand `pending` to after() so the runtime keeps
 *     the request context alive until the cache write lands for the next view.
 */
export async function resolveEnsWithBudget(
  address: string,
  budgetMs: number,
): Promise<{ ens: string | null; pending?: Promise<unknown> }> {
  const resolution = resolveEnsAndCache(address)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((r) => {
    timer = setTimeout(() => r(TIMED_OUT), budgetMs)
  })
  const winner = await Promise.race([resolution, timeout]).finally(() => clearTimeout(timer))
  if (winner === TIMED_OUT) return { ens: null, pending: resolution }
  return { ens: winner }
}
