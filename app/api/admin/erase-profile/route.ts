import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { verifyAdminSession } from '@/lib/curator'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'
import { ADMIN_ADDRESS } from '@/lib/config'
import {
  expandToFidSiblings,
  getHiddenIdentityClosure,
  resolveCanonicalProfile,
} from '@/lib/addressUnion'
import { deleteProfileRow, deleteFidProfile } from '@/lib/profile'
import { clearProfileTheme } from '@/lib/profileTheme'
import { clearAllPins } from '@/lib/showcase'
import { deleteCollected } from '@/lib/collected'
import { deleteNotificationData } from '@/lib/notifications'
import { clearEarningsVisibility } from '@/lib/earningsVisibility'
import { purgeFollowEdges } from '@/lib/follows'
import { removeHiddenProfile } from '@/lib/hidden-profiles'
import { removeHiddenUser } from '@/lib/hidden-users'
import { removeFromBlacklist } from '@/lib/blacklist'
import { removeFromPassBlacklist } from '@/lib/pass-blacklist'

/**
 * POST — HARD, IRREVERSIBLE erase of a profile identity and everything the
 * user authored or touched on Kismet. Distinct from hide (which suppresses
 * a retained identity): this DELETES the stored data. The wallet keeps its
 * on-chain holdings, and reconnecting rebuilds a fresh, empty profile — so
 * erase is for squatters / inactive-or-dead malicious actors, hide for
 * active users you may want to restore.
 *
 * Sibling-aware: a Farcaster identity is one profile across all its verified
 * wallets, so the footprint is the queried address + its canonical home +
 * every FID sibling. Each affected wallet is purged.
 *
 * PURGES (per affected wallet, best-effort so one subsystem failure can't
 * strand the rest):
 *   - profile row + FID row + search-index membership + auth nonce
 *   - profile theme, showcase pins, collected ZSET, earnings-public pin
 *   - notification inbox + prefs
 *   - social graph edges (bidirectional — removed from every counterpart)
 *   - moderation-list membership (hidden-profiles / hidden-users /
 *     blacklist / pass-blacklist) so no stale tombstone survives
 *
 * DELIBERATELY LEFT (erase cannot / must not touch these):
 *   - On-chain content + its meta (moment-meta / moment-content /
 *     collection-meta) — the tokens persist on-chain and are viewed by real
 *     collectors; deleting our copy only orphans live content.
 *   - Financial ledgers (earnings ledger, splits:by-recipient) — these
 *     route OTHER users' royalties; wiping them corrupts co-artists' payouts.
 *   - Farcaster identity — external; we can't delete someone's FC account,
 *     so an FC-verified user's name re-resolves. Use hide for that residue
 *     (the dashboard offers a one-click "also hide" when the target is FC).
 *
 * Admin-only, rate-limited. The admin's own identity (and its siblings) is
 * guarded against self-erase.
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

  // Resolve the identity's full wallet footprint: queried + canonical + FID
  // siblings (of both, covering an FID whose currentAddress drifted out of
  // the verified set). Non-FC → just the queried address.
  const { canonicalAddress, fid } = await resolveCanonicalProfile(queried)
  const wallets = new Set<string>([queried, canonicalAddress.toLowerCase()])
  for (const s of await expandToFidSiblings(queried)) wallets.add(s.toLowerCase())
  if (canonicalAddress.toLowerCase() !== queried) {
    for (const s of await expandToFidSiblings(canonicalAddress)) wallets.add(s.toLowerCase())
  }

  // Self-erase guard, sibling-aware — the admin identity must never be
  // erasable via any of its wallets.
  if (ADMIN_ADDRESS && wallets.has(ADMIN_ADDRESS)) {
    return errorResponse(400, 'Cannot erase the admin profile')
  }

  const addresses = [...wallets]

  // Per-wallet purge. Everything is best-effort inside its own lib (or
  // caught here) so a single subsystem hiccup can't half-erase and 500;
  // the admin can safely re-run (every op is idempotent delete/srem).
  await Promise.all(
    addresses.flatMap((addr) => [
      deleteProfileRow(addr).catch(() => {}),
      clearProfileTheme(addr).catch(() => {}),
      clearAllPins(addr).catch(() => {}),
      deleteCollected(addr).catch(() => {}),
      deleteNotificationData(addr).catch(() => {}),
      clearEarningsVisibility(addr, fid).catch(() => {}),
      purgeFollowEdges(addr).catch(() => {}),
      removeHiddenProfile(addr).catch(() => {}),
      removeHiddenUser(addr).catch(() => {}),
      removeFromBlacklist(addr).catch(() => {}),
      removeFromPassBlacklist(addr).catch(() => {}),
    ]),
  )
  if (fid != null) await deleteFidProfile(fid).catch(() => {})

  // We removed entries from the hidden-* lists → refresh the sibling-closure
  // memo so search/batch reads reflect the erase on the next request.
  getHiddenIdentityClosure.invalidate()

  return NextResponse.json({ ok: true, erased: { addresses, fid: fid ?? null } })
}
