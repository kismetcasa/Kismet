import { isAddress } from '@/lib/address'
import { redis } from './redis'
import { hasValidPass } from './pass-validity'
import { ADMIN_ADDRESS } from './config'

const KEY_ENABLED = 'kismetart:gate:enabled'
const KEY_PASS_COLLECTION = 'kismetart:gate:pass-collection'
const KEY_PAUSED = 'kismetart:platform:paused'

export interface GateConfig {
  enabled: boolean
  /** Address of the dedicated Pass collection. Holding any tokenId minted
   *  into this collection (with valid provenance) grants creator access. */
  passCollection: string | null
  /** Emergency kill switch. Enforced server-side only on the relayed creator
   *  writes (mint, write — lib/mint-proxy), which the server can hard-stop.
   *  Direct-from-wallet create surfaces via /api/platform-status, where the
   *  client disables its deploy button (CreateCollectionForm) — the on-chain
   *  deploy can't be server-gated, so the button is the stop. NOT a
   *  stop-everything switch: collect / airdrop / listing flows are not gated by
   *  pause. Admin bypasses so the unpause toggle can be verified. */
  paused: boolean
}

// Upstash's REST client sends string args to SET unchanged but JSON-parses
// GET results, so the flag stored as '1' comes back as the number 1 — a
// strict `=== '1'` would always be false and the toggle would never persist.
// Normalize both representations.
function isFlagSet(raw: string | number | null): boolean {
  return String(raw) === '1'
}

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
 * `targetCollection`. Admin is always exempt. The Pass collection itself is
 * admin-only as a target — non-admins can't mint additional Passes through
 * our API even though Zora's on-chain permissions would also reject them.
 * Otherwise defers to the provenance-aware validity ledger.
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
  if (targetCollection.toLowerCase() === config.passCollection) return false

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
