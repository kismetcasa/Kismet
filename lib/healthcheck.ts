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

/**
 * Boot-time drift detector for the inprocess `/smartwallet` lookup.
 *
 * The per-creator inprocess smart wallet (resolved from a creator's EOA) is
 * the account inprocess EXECUTES `/moment/create` as — confirmed on-chain it
 * holds ADMIN(0) on Kismet collections, while the operator wallet does not. So
 * this lookup underpins deploy-time relay authorization and the mint preflight;
 * when it silently breaks, deploys skip the relay's ADMIN grant and mints
 * revert weeks later with opaque errors.
 *
 * That is exactly the 2026 regression: inprocess renamed the query param
 * `artist_wallet` → `walletAddress` (their docs still say `artist_wallet`),
 * our code lagged, every lookup 400'd, and authorization silently dropped.
 * This probe resolves a known EOA (`ADMIN_ADDRESS`) at boot and logs LOUDLY if
 * it can't — so the next API drift surfaces here in seconds, not in a
 * creator's failed mint. Non-fatal; a no-op when `ADMIN_ADDRESS` isn't a valid
 * address (dev / fork). Never throws — the instrumentation hook treats it as
 * observability, not a deploy gate.
 */
export async function assertSmartWalletResolves(): Promise<void> {
  if (!ADMIN_ADDRESS || !isAddress(ADMIN_ADDRESS)) return
  let result: SmartWalletResult
  try {
    result = await resolveSmartWallet(ADMIN_ADDRESS)
  } catch (err) {
    console.error(
      `[healthcheck] /smartwallet resolve THREW for ${ADMIN_ADDRESS} — inprocess lookup down or its API changed. ` +
        `Deploy-time relay authorization can silently skip and mints revert. Verify lib/resolveSmartWallet.ts against ` +
        `the LIVE api.inprocess.world/api/smartwallet (the docs are stale: the live param is walletAddress).`,
      err instanceof Error ? err.message : String(err),
    )
    return
  }
  if (!result || 'notFound' in result) {
    console.error(
      `[healthcheck] /smartwallet resolve FAILED for ${ADMIN_ADDRESS} (result=${JSON.stringify(result)}). ` +
        `Likely an inprocess API drift (query param / URL). Deploy-time relay authorization will silently skip and ` +
        `mints will revert. Live param is walletAddress (NOT the docs' artist_wallet); the resolver sends both.`,
    )
    return
  }
  console.log(`[healthcheck] OK: /smartwallet resolves (${ADMIN_ADDRESS} → ${result.address})`)
}
