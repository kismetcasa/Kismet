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
const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.MAINNET_RPC_URL ?? process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
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

// ── Display name for the agent summaries: Basename first, then ENS ──────────
//
// A Basename (alice.base.eth) is the user's Base-native identity, so the one
// line the user reads before approving names counterparties by it when it
// exists. Resolution is ENSIP-19 (L2 primary names): the mainnet Universal
// Resolver's `reverse(address, coinType)` with Base's coinType — viem's
// documented `getEnsName({ coinType: toCoinType(base.id) })` — which resolves
// the name set on Base's reverse registrar and checks it forward-resolves
// back. Falls back to the verified mainnet ENS name above.
//
// Cosmetic, so strictly bounded: cached per address (1h; 5min for a miss or
// failure), and a lookup that hasn't answered within NAME_BUDGET_MS returns
// null NOW (the lookup keeps running and fills the cache for next time). The
// summary always prints the short address beside the name, so a missing name
// costs nothing and a name can never replace the address.

const NAME_TTL = 3600
const NAME_FAIL_TTL = 300
const NAME_BUDGET_MS = 1500
const BASE_COIN_TYPE = toCoinType(base.id)

export async function getDisplayName(address: string): Promise<string | null> {
  const key = `kismetart:name:${address.toLowerCase()}`
  try {
    const cached = await redis.get<string>(key)
    if (cached !== null) return cached === '' ? null : cached
  } catch {
    // Cache unreadable — resolve anyway (bounded below).
  }
  const lookup = resolveDisplayName(address).then(async (name) => {
    await redis.set(key, name ?? '', { ex: name ? NAME_TTL : NAME_FAIL_TTL }).catch(() => {})
    return name
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), NAME_BUDGET_MS)
  })
  try {
    return await Promise.race([lookup, budget])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolveDisplayName(address: string): Promise<string | null> {
  const addr = address as `0x${string}`
  try {
    const basename = await mainnetClient.getEnsName({ address: addr, coinType: BASE_COIN_TYPE })
    if (basename) return basename
  } catch {
    // No Basename (or the gateway failed) — try ENS.
  }
  let ens = await getCachedEns(address)
  if (ens === undefined) {
    await resolveEnsAndCache(address)
    ens = await getCachedEns(address)
  }
  return ens ?? null
}
