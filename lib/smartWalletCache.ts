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

const TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days
const key = (eoa: string) => `kismetart:smartwallet:${eoa.toLowerCase()}`

/** Durably-cached smart wallet for this EOA, or null if none / Redis unreachable. */
export async function getCachedSmartWallet(eoa: string): Promise<string | null> {
  try {
    const v = await redis.get<string | null>(key(eoa))
    return typeof v === 'string' && v.length > 0 ? v : null
  } catch {
    return null
  }
}

/** Persist a freshly-resolved smart wallet for this EOA. Never throws. */
export async function setCachedSmartWallet(eoa: string, smartWallet: string): Promise<void> {
  try {
    await redis.set(key(eoa), smartWallet.toLowerCase(), { ex: TTL_SECONDS })
  } catch {
    // Non-fatal: the live resolution already succeeded; persistence is a hedge.
  }
}
