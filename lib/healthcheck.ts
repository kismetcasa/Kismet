import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { ADMIN_ADDRESS, PLATFORM_COLLECTION } from '@/lib/config'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { resolveSmartWallet, type SmartWalletResult } from '@/lib/resolveSmartWallet'
import { serverBaseClient } from '@/lib/rpc'

/**
 * Boot-time invariant for production: confirms `OPERATOR_SMART_WALLET`
 * holds ADMIN on `NEXT_PUBLIC_PLATFORM_COLLECTION`. If that grant ever
 * goes missing, every Kismet Casa curated mint silently reverts upstream
 * with a non-actionable "Authorize required" the operator can't fix from
 * a banner. Surfacing the misconfig at boot — rather than at first user
 * mint — closes that detection gap.
 *
 * Skipped (no-op) when:
 *   - OPERATOR_SMART_WALLET is unset (dev / local — the env var is
 *     opt-in for production deployments)
 *   - either env var fails address validation (config typo; logged
 *     loudly but non-fatal so the runtime can still start)
 *
 * Throws on definitive missing-ADMIN. The instrumentation hook catches
 * the throw and logs it — the site stays up, the operator sees the
 * alarm in function logs.
 */
export async function assertPlatformCollectionAuthorized(): Promise<void> {
  const operator = process.env.OPERATOR_SMART_WALLET
  if (!operator) return

  if (!isAddress(operator)) {
    console.error(
      `[healthcheck] OPERATOR_SMART_WALLET=${operator} is not a valid address — skipping check`,
    )
    return
  }
  if (!PLATFORM_COLLECTION || !isAddress(PLATFORM_COLLECTION)) {
    console.error(
      `[healthcheck] PLATFORM_COLLECTION=${PLATFORM_COLLECTION} is not a valid address — skipping check`,
    )
    return
  }

  const client = serverBaseClient()
  let perms: bigint
  try {
    perms = await readPermissions(
      client,
      PLATFORM_COLLECTION as Address,
      0n,
      operator as Address,
    )
  } catch (err) {
    // RPC throw after all retries: log and skip rather than throw. The
    // alternative is to dark the runtime over a transient network blip.
    console.error(
      `[healthcheck] could not read permissions on ${PLATFORM_COLLECTION} after retries — Kismet Casa mints may revert. Investigate logs.`,
      err instanceof Error ? err.message : String(err),
    )
    return
  }
  if (!hasAdminBit(perms)) {
    throw new Error(
      `STARTUP HEALTHCHECK FAILED: OPERATOR_SMART_WALLET=${operator} ` +
        `does not have ADMIN (bit 2) on PLATFORM_COLLECTION=${PLATFORM_COLLECTION}. ` +
        `permissions(0, ${operator}) = ${perms}. ` +
        `Kismet Casa mints will revert. Either grant ADMIN on chain ` +
        `(addPermission(0, ${operator}, 2) from an admin EOA) or update ` +
        `NEXT_PUBLIC_PLATFORM_COLLECTION to a collection where this wallet ` +
        `is admin.`,
    )
  }
  console.log(
    `[healthcheck] OK: OPERATOR_SMART_WALLET has ADMIN on PLATFORM_COLLECTION (perms=${perms})`,
  )
}

// Shared remediation hint for the /smartwallet drift logs below. That lookup
// resolves the per-creator wallet that executes /moment/create (see
// resolveSmartWallet), so a silent break skips deploy-time relay authorization
// and reverts mints — the 2026 regression.
const SMARTWALLET_DRIFT_HINT =
  'Deploy-time relay authorization will silently skip and mints will revert. ' +
  'Check lib/resolveSmartWallet.ts against the LIVE api.inprocess.world/api/smartwallet ' +
  '(docs are stale: the live param is walletAddress, not artist_wallet).'

/**
 * Boot-time drift detector for the inprocess `/smartwallet` lookup: resolve a
 * known EOA (`ADMIN_ADDRESS`) and log LOUDLY if it fails, so an upstream
 * param/URL change surfaces in seconds rather than in a creator's failed mint.
 * Non-fatal; no-op when `ADMIN_ADDRESS` isn't a valid address (dev/fork);
 * never throws.
 */
export async function assertSmartWalletResolves(): Promise<void> {
  if (!ADMIN_ADDRESS || !isAddress(ADMIN_ADDRESS)) return
  let result: SmartWalletResult
  try {
    // skipCache: probe the LIVE endpoint. Without it, ADMIN_ADDRESS (a long-
    // registered account) is served from the durable cache during a systemic
    // /smartwallet outage, so the probe logs OK while the endpoint is 500-ing
    // for every uncached creator — masking the very drift it's meant to detect.
    result = await resolveSmartWallet(ADMIN_ADDRESS, { skipCache: true })
  } catch (err) {
    console.error(
      `[healthcheck] /smartwallet resolve THREW for ${ADMIN_ADDRESS}. ${SMARTWALLET_DRIFT_HINT}`,
      err instanceof Error ? err.message : String(err),
    )
    return
  }
  if (!result || 'notFound' in result) {
    console.error(
      `[healthcheck] /smartwallet resolve FAILED for ${ADMIN_ADDRESS} (result=${JSON.stringify(result)}). ${SMARTWALLET_DRIFT_HINT}`,
    )
    return
  }
  console.log(`[healthcheck] OK: /smartwallet resolves (${ADMIN_ADDRESS} → ${result.address})`)
}
