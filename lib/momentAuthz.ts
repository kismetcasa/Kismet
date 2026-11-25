import type { Address } from 'viem'
import { hasAdminBit, readPermissions } from './permissions'

/**
 * Is `caller` an ADMIN of this moment on chain — ADMIN on the token's own
 * permissions row, OR on tokenId 0 (collection-wide)? That OR is how Zora's
 * 1155 authorizes every admin action on a token, and it is the rule Kismet
 * already applies to each other per-artwork right: metadata and sale edits
 * (useMomentEditPermission), collector files (lib/collectorFileGate), and
 * capsule-machine grants (lib/experience/authority).
 *
 * The "moment admin" leg of /api/distribute and of the raffle-manage gate
 * (lib/raffleAuth). Both used to read In Process's GET /moment admin list,
 * which stopped meaning this on 2026-06-19: the field was renamed
 * (`momentAdmins` → `admins`, so the old read authorized nobody from then
 * on) and its scope became the collection's tokenId-0 ADMIN holders only.
 * That list misses every token-level admin and trails grants and revocations
 * by however far In Process's indexer is behind. Reading the rows the
 * contract reads can't disagree with what the caller can actually do on
 * chain, and no upstream rename can switch it off.
 *
 * Either row granting ADMIN is a yes even if the other can't be read; a no
 * needs both rows read. Throws when it can't decide (readPermissions
 * exhausted its retries without a grant on the other row). Callers answer
 * 502, never a 403 that would tell a real admin they aren't one.
 */
export async function isOnchainMomentAdmin(
  client: Parameters<typeof readPermissions>[0],
  collection: Address,
  tokenId: bigint,
  caller: Address,
): Promise<boolean> {
  // Both rows in parallel, two retries each — this sits on a signed request's
  // critical path, same budget as lib/experience/authority's checks.
  const rows = await Promise.allSettled([
    readPermissions(client, collection, tokenId, caller, { retries: 2 }),
    readPermissions(client, collection, 0n, caller, { retries: 2 }),
  ])
  if (rows.some((r) => r.status === 'fulfilled' && hasAdminBit(r.value))) return true
  const failed = rows.find((r) => r.status === 'rejected')
  if (failed) throw failed.reason
  return false
}
