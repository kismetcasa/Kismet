import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { PLATFORM_COLLECTION } from '@/lib/config'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
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
