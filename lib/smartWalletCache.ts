import { redis } from '@/lib/redis'

// Durable EOA -> inprocess smart-wallet cache (SERVER-ONLY; Upstash Redis).
//
// resolveSmartWallet writes here on every successful live /smartwallet
// resolution and reads here as a FALLBACK when the live lookup transiently
// fails (service down / 5xx / timeout / API drift). Because the deploy-time
// ADMIN grant, the mint preflight, AND the authorize banner all resolve the
// smart wallet through resolveSmartWallet, this single layer keeps all three
// working through an inprocess /smartwallet outage for any creator whose wallet
// was resolved at least once before — restoring the resilience of the original
// (2026-05-07) fixed-address design, which had no live-lookup dependency at all.
//
// The EOA -> smart-wallet mapping is deterministic per inprocess's derivation,
// so it is effectively immutable; the 30-day TTL bounds drift if inprocess ever
// migrates the algorithm, and a successful live resolution overwrites (refreshes)
// the entry. Every access is wrapped so a Redis hiccup can never break wallet
// resolution — this is a resilience layer, never a hard dependency.
//
// The REVERSE index (smart wallet -> owning EOA) exists for the stats rebuild:
// the In•Process feed attributes mints to the on-chain msg.sender — the
// per-creator smart wallet — which is a contract, never an FC verification, so
// the profile read's sibling union can't see it. rebuildStats folds smart-
// wallet-credited scores back onto the owner EOA via this index. Populated
// lazily (each live resolution writes it), so coverage grows with normal mint
// traffic; the rebuild treats a missing entry as "not a known smart wallet".

const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days
const key = (eoa: string) => `kismetart:smartwallet:${eoa.toLowerCase()}`
const ownerKey = (smartWallet: string) =>
  `kismetart:smartwallet-owner:${smartWallet.toLowerCase()}`

/** Durably-cached smart wallet for this EOA, or null if none / Redis unreachable. */
export async function getCachedSmartWallet(eoa: string): Promise<string | null> {
  try {
    const v = await redis.get<string | null>(key(eoa))
    return typeof v === 'string' && v.length > 0 ? v : null
  } catch {
    return null
  }
}

/** Persist a freshly-resolved smart wallet for this EOA (both directions). Never throws. */
export async function setCachedSmartWallet(eoa: string, smartWallet: string): Promise<void> {
  try {
    const sw = smartWallet.toLowerCase()
    const owner = eoa.toLowerCase()
    // Auto-pipelined into one round trip (lib/redis.ts). Not transactional on
    // purpose: each direction is independently useful, and a half-write just
    // self-heals on the next resolution.
    await Promise.all([
      redis.set(key(owner), sw, { ex: TTL_SECONDS }),
      redis.set(ownerKey(sw), owner, { ex: TTL_SECONDS }),
    ])
  } catch {
    // Non-fatal: the live resolution already succeeded; persistence is a hedge.
  }
}

/**
 * Batch reverse lookup: which of these addresses are known inprocess smart
 * wallets, and who owns them. Returns alias→owner (lowercase) for the hits
 * only. One MGET regardless of input size; empty map on Redis failure so the
 * stats rebuild degrades to unmapped attribution rather than aborting.
 */
export async function getSmartWalletOwners(
  addresses: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (addresses.length === 0) return out
  try {
    const owners = await redis.mget<(string | null)[]>(
      ...addresses.map((a) => ownerKey(a)),
    )
    addresses.forEach((a, i) => {
      const owner = owners[i]
      if (typeof owner === 'string' && owner.length > 0) {
        out.set(a.toLowerCase(), owner.toLowerCase())
      }
    })
  } catch {
    // Degrade to no remap.
  }
  return out
}
