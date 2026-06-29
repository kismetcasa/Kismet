import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
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
