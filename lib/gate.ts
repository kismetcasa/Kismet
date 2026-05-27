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
  /** Emergency kill switch — when true, every gated mutating action
   *  (mint, write) is rejected for non-admin callers. Admin still
   *  bypasses so the unpause toggle can be verified. */
  paused: boolean
}

// Upstash's REST client sends string args to SET unchanged but JSON-parses
// GET results, so the flag stored as '1' comes back as the number 1 — a
// strict `=== '1'` would always be false and the toggle would never persist.
// Normalize both representations.
function isFlagSet(raw: string | number | null): boolean {
  return String(raw) === '1'
}

export async function getGateConfig(): Promise<GateConfig> {
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
    return {
      enabled: isFlagSet(enabled),
      passCollection,
      paused: isFlagSet(paused),
    }
  } catch {
    return { enabled: false, passCollection: null, paused: false }
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
