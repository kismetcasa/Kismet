import { after } from 'next/server'
import { createPublicClient, http, toCoinType } from 'viem'
import { base, mainnet } from 'viem/chains'
import { normalize } from 'viem/ens'
import { redis } from '@/lib/redis'

// Shared ENS reverse-resolution cache, used by both /api/profile/[address]
// (single) and /api/profiles (batch) so the two never diverge on how a
// raw address resolves to a verified .eth name.

// Prefer a configured RPC URL (Alchemy / Infura) to avoid rate limits on
// the public default. MAINNET_RPC_URL is the server-only override; falls
// back to NEXT_PUBLIC_MAINNET_RPC_URL (shared with the client-side ENS
// lookup in lib/wagmi.ts) when unset, then to viem's public default.
// Bounded: a reverse lookup can fan out to CCIP-read gateways named by
// on-chain resolver data, so no single request may hang the caller.
const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.MAINNET_RPC_URL ?? process.env.NEXT_PUBLIC_MAINNET_RPC_URL, { timeout: 8_000 }),
})

const ENS_TTL = 3600      // 1 hour for resolved names
const ENS_FAIL_TTL = 300  // 5 minutes for failures / confirmed no-ENS

export async function getCachedEns(address: string): Promise<string | null | undefined> {
  const key = `kismetart:ens:${address.toLowerCase()}`
  try {
    const cached = await redis.get<string>(key)
    if (cached === null) return undefined          // cache miss
    return cached === '' ? null : cached           // '' = confirmed no ENS
  } catch {
    return undefined
  }
}

export async function resolveEnsAndCache(address: string): Promise<void> {
  const key = `kismetart:ens:${address.toLowerCase()}`
  try {
    const name = await mainnetClient.getEnsName({ address: address as `0x${string}` })
    if (!name) {
      await redis.set(key, '', { ex: ENS_TTL }).catch(() => {})
      return
    }
    // ENS spec (Primary Names docs) requires forward-verification: anyone can
    // set a reverse record pointing to any name they don't control. Only
    // display the name when it also forward-resolves back to this address.
    const forward = await mainnetClient.getEnsAddress({ name: normalize(name) })
    const verified = forward?.toLowerCase() === address.toLowerCase()
    await redis.set(key, verified ? name : '', { ex: ENS_TTL }).catch(() => {})
  } catch {
    await redis.set(key, '', { ex: ENS_FAIL_TTL }).catch(() => {})
  }
}

// ── Display name for the agent summaries: Base primary name first, then ENS ─
//
// The one line the user reads before approving names counterparties by their
// Base-native identity when it exists: the ENSIP-19 primary name for Base's
// coinType (a Basename like alice.base.eth, or any name whose Base address
// record points back at them). viem's `getEnsName({ coinType:
// toCoinType(base.id) })` asks the mainnet Universal Resolver
// (`reverseWithGateways`), which follows the CCIP-read hops to Base's reverse
// registrar and checks the name forward-resolves to the address. Falls back to
// the verified mainnet ENS name above.
//
// Only a name that is already ENS-normalized is displayed (isDisplayableName):
// a reverse record is set by its owner and a label can be arbitrary bytes at
// the registry, so an un-normalized name could carry spaces, quotes or a
// newline into the summary line. The mainnet path is protected the same way
// (resolveEnsAndCache normalizes before the forward check).
//
// Cosmetic, so bounded: cached per address (1h for a name or a confirmed
// none; 5min after a failed lookup), de-duplicated while in flight, and a
// lookup that hasn't answered within NAME_BUDGET_MS answers null NOW while the
// lookup continues after the response to fill the cache. The summary always
// prints the short address beside the name, so a missing name costs nothing
// and a name can never replace the address.

const NAME_TTL = 3600
const NAME_FAIL_TTL = 300
const NAME_BUDGET_MS = 1500
const NAME_MAX = 64
const BASE_COIN_TYPE = toCoinType(base.id)
const inFlight = new Map<string, Promise<string | null>>()

/** ENS-normalized, single-token, bounded — and free of the summary line's own
 *  punctuation, which ENS normalization permits. */
export function isDisplayableName(name: string): boolean {
  if (!name || name.length > NAME_MAX || /[\s“”„‟"'()→⇒]/.test(name)) return false
  try {
    return normalize(name) === name
  } catch {
    return false
  }
}

export async function getDisplayName(address: string): Promise<string | null> {
  const lc = address.toLowerCase()
  const key = `kismetart:name:${lc}`
  try {
    const cached = await redis.get<string>(key)
    if (cached !== null) return cached === '' ? null : cached
  } catch {
    // Cache unreadable — resolve anyway (bounded below).
  }
  let lookup = inFlight.get(lc)
  if (!lookup) {
    lookup = resolveDisplayName(address)
      .then(async ({ name, confirmed }) => {
        await redis.set(key, name ?? '', { ex: name || confirmed ? NAME_TTL : NAME_FAIL_TTL }).catch(() => {})
        return name
      })
      .finally(() => inFlight.delete(lc))
    inFlight.set(lc, lookup)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), NAME_BUDGET_MS)
  })
  try {
    const name = await Promise.race([lookup, budget])
    if (name === null && inFlight.has(lc)) {
      // Budget hit: keep the lookup alive past the response so it fills the
      // cache (outside a request scope — scripts — the promise simply runs).
      try {
        after(() => lookup)
      } catch {
        /* not inside a request */
      }
    }
    return name
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** `confirmed` is false when a lookup errored (so the miss is cached briefly);
 *  true when both sources answered, even with no name. */
async function resolveDisplayName(address: string): Promise<{ name: string | null; confirmed: boolean }> {
  const addr = address as `0x${string}`
  let confirmed = true
  try {
    // viem answers null (not an error) for "no name"; a thrown error is transport.
    const basename = await mainnetClient.getEnsName({ address: addr, coinType: BASE_COIN_TYPE })
    if (basename) return { name: isDisplayableName(basename) ? basename : null, confirmed: true }
  } catch {
    confirmed = false
  }
  let ens = await getCachedEns(address)
  if (ens === undefined) {
    await resolveEnsAndCache(address)
    ens = await getCachedEns(address)
  }
  if (ens === undefined) confirmed = false
  return { name: ens ?? null, confirmed }
}
