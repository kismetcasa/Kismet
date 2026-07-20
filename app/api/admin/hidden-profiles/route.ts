import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import {
  addHiddenProfile,
  removeHiddenProfile,
  listHiddenProfiles,
} from '@/lib/hidden-profiles'
import {
  expandToFidSiblings,
  getHiddenIdentityClosure,
  resolveCanonicalProfile,
} from '@/lib/addressUnion'
import { ADMIN_ADDRESS } from '@/lib/config'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { recordAdminAction } from '@/lib/adminAudit'
import { errorResponse } from '@/lib/apiResponse'

async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-hidden-profiles:${ip}`, 20, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

/** GET — without params, list all admin-hidden profile addresses (sorted).
 *  With ?address=0x…, answer the SIBLING-AWARE status question the
 *  dashboard needs: is this identity hidden, and via WHICH listed entry?
 *  The enforcement gate hides a profile when ANY of its FID-sibling
 *  wallets is listed, so a raw-membership check at a sibling URL would
 *  read "visible" while the page 404s — and unhide would have no way to
 *  target the actual entry. matchedAddress is that entry. Admin-only. */
export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const address = new URL(req.url).searchParams.get('address')
  if (address !== null) {
    if (!isAddress(address)) return errorResponse(400, 'valid address required')
    const lower = address.toLowerCase()
    const [{ canonicalAddress }, listed] = await Promise.all([
      resolveCanonicalProfile(lower),
      listHiddenProfiles(),
    ])
    const hiddenSet = new Set(listed)
    // The identity's wallet set: queried + canonical + both sibling
    // expansions (canonical's too, covering FID-keyed identities whose
    // currentAddress drifted out of the verified set). First listed match
    // is the entry an unhide must remove.
    const identity = new Set<string>([lower, canonicalAddress.toLowerCase()])
    for (const s of await expandToFidSiblings(lower)) identity.add(s.toLowerCase())
    if (canonicalAddress.toLowerCase() !== lower) {
      for (const s of await expandToFidSiblings(canonicalAddress)) identity.add(s.toLowerCase())
    }
    const matchedAddress = [...identity].find((a) => hiddenSet.has(a)) ?? null
    return NextResponse.json({ hidden: matchedAddress !== null, matchedAddress })
  }

  const addresses = await listHiddenProfiles()
  return NextResponse.json({ addresses })
}

/** POST — hide {address}'s profile: the profile page 404s for everyone
 *  but the owner, and their identity drops out of the profile API, batch
 *  resolver, search, and share cards. Their CONTENT keeps its existing
 *  visibility — pair with hidden-users to strip that too. Admin-only. */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { address?: string } | null
  if (!body) return errorResponse(400, 'Invalid body')

  if (!body.address || !isAddress(body.address)) {
    return errorResponse(400, 'valid address required')
  }

  // Sibling-aware admin guard: the enforcement gate is sibling-aware, so
  // hiding ANY wallet of the admin's Farcaster identity would take the
  // admin's own profile down — not just the exact ADMIN_ADDRESS the lib's
  // own guard checks. Checked here (not in lib/hidden-profiles) because
  // the sibling expansion lives in addressUnion, which the lib can't
  // import without a cycle; this route is the only writer.
  if (
    ADMIN_ADDRESS &&
    (await expandToFidSiblings(body.address)).some((s) => s.toLowerCase() === ADMIN_ADDRESS)
  ) {
    return errorResponse(400, 'Cannot hide the admin profile')
  }

  try {
    await addHiddenProfile(body.address)
  } catch (e) {
    return errorResponse(400, e instanceof Error ? e.message : 'Add failed')
  }
  await recordAdminAction('profile.hide', { actor: auth.signer, target: body.address.toLowerCase() })
  // Own-layer sibling-closure refresh so search/batch/API reads through
  // this layer see the hide immediately; RSC pages catch up via the
  // closure's short TTL (direct-URL hides are already instant there).
  getHiddenIdentityClosure.invalidate()
  return NextResponse.json({ ok: true })
}

/** DELETE — un-hide {address}'s profile. Identity surfaces return for
 *  everyone. Other moderation lists (hidden-users, blacklists) are NOT
 *  affected — those are independent and stay as set. */
export async function DELETE(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { address?: string } | null
  if (!body) return errorResponse(400, 'Invalid body')

  if (!body.address || !isAddress(body.address)) {
    return errorResponse(400, 'valid address required')
  }
  await removeHiddenProfile(body.address)
  getHiddenIdentityClosure.invalidate()
  await recordAdminAction('profile.unhide', { actor: auth.signer, target: body.address.toLowerCase() })
  return NextResponse.json({ ok: true })
}
