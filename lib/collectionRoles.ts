import { parseAbi, type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { LRUCache } from '@/lib/lruCache'
import { serverBaseClient } from '@/lib/rpc'

// A collection's contract-level roles, read from the chain. This is where a
// collection's `payout_recipient` comes from now: In Process documented that
// field as "Address to receive sale proceeds", dropped it from its documented
// schema on 2026-03-07, and its replacement detail route returns only `creator`
// (see lib/inprocessCollection.ts). The authoritative source was always the
// contract itself: Zora 1155's public `config` struct, whose `fundsRecipient`
// is the collection-wide proceeds address. `initialize` sets it to the default
// admin and an admin can repoint it (setFundsRecipient), so the chain is the
// only source that cannot drift with an indexer's schema.
const CONFIG_ABI = parseAbi([
  'function config() view returns (address owner, uint96 __gap1, address fundsRecipient, uint96 __gap2, address transferHook, uint96 __gap3)',
])

export interface CollectionRoles {
  /** Current contract owner (the live form of the creation-time default admin). */
  owner?: string
  /** Collection-wide sale-proceeds address. */
  fundsRecipient?: string
}

// Roles change only by an admin transaction, so a few minutes of staleness is
// fine for a header chip. Only successes are cached: a failed read is retried
// on the next request instead of hiding the chip for a TTL.
const cache = new LRUCache<string, { value: CollectionRoles; expiresAt: number }>(1000)
const TTL_MS = 5 * 60 * 1000

// viem's http transport retries (3×, 10 s each) on its own; a page render must
// not wait that long for a display-only chip. The read keeps running in the
// background after the race is lost; its late rejection is swallowed below.
const READ_TIMEOUT_MS = 3_000

const ZERO = '0x0000000000000000000000000000000000000000'

function roleAddress(v: unknown): string | undefined {
  if (typeof v !== 'string' || !isAddress(v)) return undefined
  const lower = v.toLowerCase()
  return lower === ZERO ? undefined : lower
}

/** viem returns a multi-output read as a positional array; accept an object too. */
export function decodeCollectionConfig(raw: unknown): CollectionRoles {
  const arr = Array.isArray(raw) ? raw : null
  const obj = !arr && typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null
  const owner = roleAddress(arr ? arr[0] : obj?.owner)
  const fundsRecipient = roleAddress(arr ? arr[2] : obj?.fundsRecipient)
  return { ...(owner ? { owner } : {}), ...(fundsRecipient ? { fundsRecipient } : {}) }
}

/**
 * Read a collection's `config()` roles. Never throws; null when the read fails,
 * reverts (not a Zora 1155), or exceeds the timeout. `skipCache` is for the
 * stats rebuild, which wants live truth.
 */
export async function readCollectionRoles(
  address: string,
  opts: { skipCache?: boolean; timeoutMs?: number } = {},
): Promise<CollectionRoles | null> {
  if (!isAddress(address)) return null
  const key = address.toLowerCase()
  if (!opts.skipCache) {
    const hit = cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.value
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const read = serverBaseClient()
      .readContract({ address: key as Address, abi: CONFIG_ABI, functionName: 'config' })
      .catch(() => undefined)
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), opts.timeoutMs ?? READ_TIMEOUT_MS)
    })
    const raw = await Promise.race([read, timeout])
    if (raw === undefined) return null
    const value = decodeCollectionConfig(raw)
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS })
    return value
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
