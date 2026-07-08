import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { verifyAdminSession } from '@/lib/curator'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'
import { ADMIN_ADDRESS } from '@/lib/config'
import { getFidByAddress, getVerifiedAddressesByFidChecked } from '@/lib/farcasterProfile'
import { getHiddenIdentityClosure } from '@/lib/addressUnion'
import { deleteProfileRow, deleteFidProfile, getFidProfile } from '@/lib/profile'
import { clearProfileTheme } from '@/lib/profileTheme'
import { clearAllPins } from '@/lib/showcase'
import { deleteCollected } from '@/lib/collected'
import { deleteNotificationData } from '@/lib/notifications'
import { clearEarningsVisibility } from '@/lib/earningsVisibility'
import { purgeFollowEdges } from '@/lib/follows'
import { deleteScout } from '@/lib/agent/scout/store'
import { removeHiddenProfile } from '@/lib/hidden-profiles'

/**
 * POST — HARD, IRREVERSIBLE erase of a profile identity and everything the
 * user authored on Kismet. Distinct from hide (which suppresses a retained
 * identity): this DELETES the stored data. The wallet keeps its on-chain
 * holdings, and reconnecting rebuilds a fresh, empty profile — so erase is
 * for squatters / inactive-or-dead malicious actors, hide for active users
 * you may want to restore.
 *
 * Sibling-aware: a Farcaster identity is one profile across all its verified
 * wallets, so the footprint is the queried address + its FID's verified
 * wallets + the FID's currentAddress (which may have drifted out of the
 * verified set). The footprint is resolved through the CHECKED Farcaster
 * path and FAILS CLOSED: a transient FC outage 503s rather than silently
 * collapsing to the queried wallet and doing a partial erase reported as
 * success.
 *
 * PURGES (per affected wallet, best-effort so one subsystem failure can't
 * strand the rest; every op is an idempotent delete/srem, so re-running is
 * safe):
 *   - profile row + FID row + search-index membership + auth nonce
 *   - profile theme, showcase pins, collected ZSET, earnings-public pin
 *   - notification inbox + prefs
 *   - social graph edges (bidirectional — removed from every counterpart)
 *   - the Scout agent record (policy, artist labels, and the stored Spend
 *     Permission signature — so the coordinator can't keep spending), plus
 *     its reverse watcher-index membership
 *   - hidden-profiles membership (identity-scoped — the profile is gone, so
 *     a recreated one starts un-hidden)
 *
 * DELIBERATELY LEFT (erase cannot / must not touch these):
 *   - On-chain content + its meta (moment-meta / moment-content /
 *     collection-meta) — the tokens persist on-chain and are viewed by real
 *     collectors; deleting our copy only orphans live content.
 *   - Financial ledgers (earnings ledger, splits:by-recipient) — these
 *     route OTHER users' royalties; wiping them corrupts co-artists' payouts.
 *   - ADDRESS-SCOPED BANS (hidden-users, action blacklist, pass blacklist) —
 *     these enforce on the WALLET regardless of whether a profile exists, so
 *     erasing must NOT lift them: a malicious actor's content stays stripped
 *     and their actions stay blocked even after their identity is purged.
 *   - Farcaster identity — external; we can't delete someone's FC account,
 *     so an FC-verified user's name re-resolves. Use hide for that residue
 *     (the dashboard offers a one-click "also hide" after an FC erase).
 *
 * Admin-only, rate-limited. The admin's own identity (and its FID-verified
 * wallets) is guarded against self-erase.
 */
export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`admin-erase-profile:${getClientIp(req)}`, 10, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { address?: string } | null
  if (!body?.address || !isAddress(body.address)) {
    return errorResponse(400, 'valid address required')
  }
  const queried = body.address.toLowerCase()

  // Resolve the identity's full wallet footprint through the CHECKED FC path
  // so a transient outage fails closed instead of partial-erasing. getFidByAddress
  // returns null on transient failure (vs { fid: null } for a definitive non-FC
  // address); getVerifiedAddressesByFidChecked returns null on transient failure
  // (vs { addresses } definitively).
  const lookup = await getFidByAddress(queried)
  if (lookup === null) {
    return errorResponse(503, 'Could not resolve the identity right now — retry')
  }
  const fid = lookup.fid
  const wallets = new Set<string>([queried])
  if (fid != null) {
    const checked = await getVerifiedAddressesByFidChecked(fid)
    if (checked === null) {
      return errorResponse(503, 'Could not resolve the identity right now — retry')
    }
    for (const a of checked.addresses) wallets.add(a.toLowerCase())
    // currentAddress can drift out of the verified set — include it so its
    // address-keyed row is purged too.
    const fidProfile = await getFidProfile(fid)
    if (fidProfile?.currentAddress) wallets.add(fidProfile.currentAddress.toLowerCase())
  }

  // Self-erase guard, sibling-aware — the admin identity must never be
  // erasable via any of its wallets.
  if (ADMIN_ADDRESS && wallets.has(ADMIN_ADDRESS)) {
    return errorResponse(400, 'Cannot erase the admin profile')
  }

  const addresses = [...wallets]

  // Per-wallet purge. Everything is best-effort so a single subsystem hiccup
  // can't half-erase and 500; the admin can safely re-run (every op is an
  // idempotent delete/srem).
  await Promise.all(
    addresses.flatMap((addr) => [
      deleteProfileRow(addr).catch(() => {}),
      clearProfileTheme(addr).catch(() => {}),
      clearAllPins(addr).catch(() => {}),
      deleteCollected(addr).catch(() => {}),
      deleteNotificationData(addr).catch(() => {}),
      clearEarningsVisibility(addr, fid).catch(() => {}),
      purgeFollowEdges(addr).catch(() => {}),
      deleteScout(addr).catch(() => {}),
      removeHiddenProfile(addr).catch(() => {}),
    ]),
  )
  if (fid != null) await deleteFidProfile(fid).catch(() => {})

  // We removed entries from hidden-profiles → refresh the sibling-closure
  // memo so search/batch reads reflect the erase on the next request.
  getHiddenIdentityClosure.invalidate()

  return NextResponse.json({ ok: true, erased: { addresses, fid: fid ?? null } })
}
