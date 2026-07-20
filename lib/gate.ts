import { isAddress } from '@/lib/address'
import { isFlagSet } from './gateFlags'
import { redis } from './redis'
import { hasValidPass } from './pass-validity'
import { getCollectionMeta } from './kv'
import { ADMIN_ADDRESS } from './config'

const KEY_ENABLED = 'kismetart:gate:enabled'
const KEY_PASS_COLLECTION = 'kismetart:gate:pass-collection'
const KEY_PAUSED = 'kismetart:platform:paused'

export interface GateConfig {
  enabled: boolean
  /** Address of the dedicated Pass collection. Holding any tokenId minted
   *  into this collection (with valid provenance) grants creator access. */
  passCollection: string | null
  /** Emergency kill switch. Enforced server-side on every relayed, platform-
   *  gas-sponsored write the server can hard-stop: mint + write (lib/mint-proxy),
   *  distribute + distribute-all, and moment/update-uri. Direct-from-wallet
   *  create surfaces via /api/platform-status, where the client disables its
   *  deploy button (CreateCollectionForm) — the on-chain deploy can't be
   *  server-gated, so the button is the stop. Still NOT a stop-EVERYTHING
   *  switch: collect / airdrop only RECORD an already-on-chain action (blocking
   *  them loses data without stopping anything), and listing fills are
   *  peer-to-peer with no platform spend — so neither is gated; the autonomous
   *  agent has its own fail-closed scout-killswitch. Admin bypasses so the
   *  unpause toggle can be verified. */
  paused: boolean
}

// isFlagSet (Upstash '1'-string vs numeric-1 normalization) lives in
// lib/gateFlags so the verify harness can unit-test it — gate.ts itself pulls
// in redis/kv and can't be loaded under --experimental-strip-types.

// In-process cache for gate config. Avoids 3 Redis reads on every gated
// request (getGateConfig is called once each by hasGateAccess,
// isPlatformPausedFor, and the caller directly — 9 Redis reads per request
// without caching). More importantly, provides last-known-good semantics on
// Redis error: gate stays enforced at its prior state rather than failing
// open (enabled:false) which would admit all callers during an outage.
const CONFIG_CACHE_TTL_MS = 15_000
let _configCache: { value: GateConfig; expiresAt: number } | null = null

export async function getGateConfig(): Promise<GateConfig> {
  if (_configCache && Date.now() < _configCache.expiresAt) {
    return _configCache.value
  }
  try {
    const [enabled, collectionRaw, paused] = await Promise.all([
      redis.get<string | number>(KEY_ENABLED),
      redis.get<string>(KEY_PASS_COLLECTION),
      redis.get<string | number>(KEY_PAUSED),
    ])
    const passCollection =
      typeof collectionRaw === 'string' && isAddress(collectionRaw)
        ? collectionRaw.toLowerCase()
        : null
    const config: GateConfig = {
      enabled: isFlagSet(enabled),
      passCollection,
      paused: isFlagSet(paused),
    }
    _configCache = { value: config, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS }
    return config
  } catch {
    // Last-known-good: gate stays in its prior enforced state during a
    // transient Redis outage. Only falls back here if no cached value
    // exists (cold start with Redis already down).
    if (_configCache) return _configCache.value
    // Cold start + Redis unreachable: there is no last-known-good to trust.
    // Fail the emergency kill-switch CLOSED (paused:true) so an Upstash outage
    // coinciding with a fresh-instance boot can't silently neutralize an active
    // pause. paused:true makes mint-proxy 503 every non-admin mint/write
    // server-side, and makes /api/platform-status report paused so the client
    // disables its create button for the window — admin still bypasses — and it
    // self-heals the instant a real read repopulates the cache. enabled stays
    // false here, so hasGateAccess ADMITS; the *pause* is what denies. We don't
    // fabricate an enabled gate (no trustworthy passCollection), and pause is
    // the one piece of state with no on-chain backstop, so it's the one we fail
    // closed.
    return { enabled: false, passCollection: null, paused: true }
  }
}

export async function setGateConfig(config: GateConfig): Promise<void> {
  await Promise.all([
    redis.set(KEY_ENABLED, config.enabled ? '1' : '0'),
    config.passCollection
      ? redis.set(KEY_PASS_COLLECTION, config.passCollection.toLowerCase())
      : redis.del(KEY_PASS_COLLECTION),
    config.paused ? redis.set(KEY_PAUSED, '1') : redis.del(KEY_PAUSED),
  ])
  // Invalidate so the next read picks up the admin's change within one
  // request rather than waiting up to CONFIG_CACHE_TTL_MS.
  _configCache = null
}

/**
 * Returns true if `address` may perform a platform action targeting
 * `targetCollection`. Admin is always exempt. Minting INTO the pass collection
 * is governed by on-chain ADMIN on the pass collection (mint-proxy's
 * checkSmartWalletAdmin), so any wallet the platform has granted ADMIN there
 * can issue passes and everyone else is rejected on-chain; minting into any
 * OTHER collection defers to the provenance-aware validity ledger.
 *
 * Mint-proxy wires this in *addition* to main's existing on-chain Zora
 * ADMIN check (`checkSmartWalletAdmin`) — so the caller must (a) hold a
 * Pass (platform policy) AND (b) have on-chain admin on the target
 * (contract policy). Gate disabled = the platform-policy layer is a no-op.
 */
export async function hasGateAccess(
  targetCollection: string,
  address: string,
): Promise<boolean> {
  const addrLower = address.toLowerCase()
  if (ADMIN_ADDRESS && addrLower === ADMIN_ADDRESS) return true

  const config = await getGateConfig()
  if (!config.enabled || !config.passCollection) return true
  // Minting INTO the pass collection is governed by on-chain ADMIN on the pass
  // collection itself, enforced on this exact path by mint-proxy's
  // checkSmartWalletAdmin (the only caller that can reach this branch; the
  // collections route never targets the pass collection). Issuing a pass means
  // setupNewToken, which Zora gates on ADMIN regardless, so a platform-admin-
  // only block here was a redundant override of that on-chain truth that also
  // locked out a delegated pass-issuer. Defer to the single on-chain source:
  // any wallet the platform has granted ADMIN on the pass collection (via the
  // authorize/authorized-creators flow) can issue passes; every other wallet,
  // including mere pass-holders, is still rejected by checkSmartWalletAdmin.
  // Admin bypasses above.
  if (targetCollection.toLowerCase() === config.passCollection) return true

  return hasValidPass(config.passCollection, addrLower)
}

/** Returns true if the platform is paused AND the caller is not admin.
 *  Admin always bypasses so they can verify recovery / test the unpause
 *  flow without lifting the pause first. */
export async function isPlatformPausedFor(address: string): Promise<boolean> {
  if (ADMIN_ADDRESS && address.toLowerCase() === ADMIN_ADDRESS) return false
  const config = await getGateConfig()
  return config.paused
}

/** Raw platform-pause flag with no admin bypass — backs the public
 *  status endpoint that powers client-side "paused" affordances (e.g.
 *  disabling the create-collection button). Admin exemption for those
 *  surfaces is applied client-side via the admin context. */
export async function isPlatformPaused(): Promise<boolean> {
  const config = await getGateConfig()
  return config.paused
}

// Resolved display name of the configured pass collection, cached in-process.
// The pass collection and its name are stable, so this avoids a KV read on
// every /api/pass-validity poll; keyed by collection so an admin switch is
// picked up, and TTL'd so a rename converges. Backs the gate UI's
// "collect from <name>" copy and the gated-out 403 messages. Returns null when
// the name is unknown or is just the address placeholder, so callers fall back
// to a generic label.
let _nameCache: { collection: string; name: string | null; expiresAt: number } | null = null
const PASS_NAME_TTL_MS = 10 * 60 * 1000

export async function getPassCollectionName(passCollection: string): Promise<string | null> {
  const lower = passCollection.toLowerCase()
  if (_nameCache && _nameCache.collection === lower && Date.now() < _nameCache.expiresAt) {
    return _nameCache.name
  }
  let name: string | null = null
  try {
    const meta = await getCollectionMeta(lower)
    const n = meta?.name?.trim()
    // Ignore the address-as-name placeholder (a collection registered without
    // a name stores its address there) — better a generic label than a hex.
    name = n && n.length > 0 && n.toLowerCase() !== lower ? n : null
  } catch {
    // leave null; the UI falls back to a generic label
  }
  _nameCache = { collection: lower, name, expiresAt: Date.now() + PASS_NAME_TTL_MS }
  return name
}
