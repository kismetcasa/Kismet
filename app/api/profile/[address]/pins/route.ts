import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { authorizeProfileOwner } from '@/lib/profileOwner'
import { errorResponse } from '@/lib/apiResponse'
import {
  addPin,
  removePin,
  ensureViewModeForPinChange,
  getAllPinsChecked,
  resolvePublicViewMode,
  resolveShowcaseScopes,
  isPinCategory,
} from '@/lib/showcase'

// The pins-unknown payload, shared by every degraded path below so they can't
// drift: no pins, and the fail-private curated view.
const EMPTY_PINS = { mints: [], collected: [], listings: [] } as const

// GET /api/profile/[address]/pins — public. Returns the owner's pinned
// showcase refs per category, newest-pinned first, plus the RESOLVED
// public-view mode ('full' profile with pins first vs 'curated' showcase;
// stored choice, else derived — see lib/showcase) — the client picks the
// visitor render mode the moment this payload lands, so both travel in the
// one Tier-1 fetch. Served fresh (uncached, like /api/featured) so a
// just-pinned moment or a just-flipped mode is visible to other viewers
// immediately — three small ZRANGEs and a GET.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')

  // Identity scope resolved ONCE and threaded into both calls (lib/showcase):
  // pins live under `fid:<n>` for an FC user, so this read no longer depends on
  // the page having redirected to whatever address is canonical today — the old
  // read-the-path-address / write-the-canonical split is what let an unpin ZREM
  // a key the read never looked at. The keys can't be known before the identity
  // is, so this is one dependent lookup; mode resolution then shares the pins
  // read (checked, so a failed read fails private instead of deriving 'full'
  // off missing data) and both issue same-tick, keeping the rest one round trip.
  const scopes = await resolveShowcaseScopes(address).catch(() => null)
  if (!scopes) {
    // Identity unknown right now. Serve the SAME fail-private degradation this
    // route already produces when the pin reads themselves fail — no pins, the
    // curated view — rather than a 500. The client's catch falls back to exactly
    // this payload anyway, so the 500 would only add noise on a public path.
    return NextResponse.json({ pins: EMPTY_PINS, publicView: 'curated' })
  }
  const pinsRead = getAllPinsChecked(address, scopes)
  const publicView = await resolvePublicViewMode(address, pinsRead, scopes)
  const pins = await pinsRead
  return NextResponse.json({ pins: pins ?? EMPTY_PINS, publicView })
}

// Writes FAIL CLOSED when the identity can't be resolved: lib/showcase keys pin
// sets by identity, so a write that guessed the address form could land under a
// keying the read never looks at — the silent no-op this feature was fixed for.
// 503 (not 500) so the client reverts its optimistic state and the user retries,
// matching the earnings-visibility toggle's contract.
const IDENTITY_UNAVAILABLE = 'Identity lookup unavailable — try again shortly'

interface PinBody {
  category?: unknown
  collectionAddress?: unknown
  tokenId?: unknown
}

function parsePinBody(
  body: PinBody | null,
): { category: 'mints' | 'collected' | 'listings'; collectionAddress: string; tokenId: string } | { error: string } {
  if (!body) return { error: 'Invalid body' }
  const { category, collectionAddress, tokenId } = body
  if (!isPinCategory(category)) return { error: 'Invalid category' }
  if (!collectionAddress || !isAddress(collectionAddress)) return { error: 'Invalid collectionAddress' }
  if (!isValidTokenId(tokenId)) return { error: 'Invalid tokenId' }
  return { category, collectionAddress, tokenId }
}

// POST /api/profile/[address]/pins — owner-only. Pin one moment into a
// category. Auth is the user session cookie (same model as /api/moment/hide),
// so it's one tap with no per-action wallet signature.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')

  const auth = await authorizeProfileOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const parsed = parsePinBody(await req.json().catch(() => null))
  if ('error' in parsed) return errorResponse(400, parsed.error)

  const scopes = await resolveShowcaseScopes(auth.canonical).catch(() => null)
  if (!scopes) return errorResponse(503, IDENTITY_UNAVAILABLE)

  // Lock the unset profile's mode to what its pins derive to BEFORE this pin
  // changes that basis — a first-ever pin under the 'full' default must mean
  // "float this first", never "flip me to showcase-only". See lib/showcase.
  await ensureViewModeForPinChange(auth.canonical, scopes)
  const ok = await addPin(parsed.category, auth.canonical, parsed.collectionAddress, parsed.tokenId, scopes)
  if (!ok) return errorResponse(409, 'Pin limit reached — unpin one first')
  return NextResponse.json({ pinned: true })
}

// DELETE /api/profile/[address]/pins — owner-only. Unpin. Mirrors POST shape,
// and answers `removed`: whether a ref was actually taken out of the pin set.
// removePin sweeps every key form, so false means the ref was pinned under none
// of them — an idempotent repeat, not an error. It is reported rather than
// swallowed because answering a silent no-op as a flat success is exactly how
// the address-keying bug stayed invisible (the client showed the pin gone and
// the next load brought it back).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')

  const auth = await authorizeProfileOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const parsed = parsePinBody(await req.json().catch(() => null))
  if ('error' in parsed) return errorResponse(400, parsed.error)

  const scopes = await resolveShowcaseScopes(auth.canonical).catch(() => null)
  if (!scopes) return errorResponse(503, IDENTITY_UNAVAILABLE)

  // Same prelude as POST: a legacy profile unpinning its last pin stays
  // 'curated' (grandfathered) rather than silently resolving to 'full'.
  await ensureViewModeForPinChange(auth.canonical, scopes)
  const removed = await removePin(
    parsed.category,
    auth.canonical,
    parsed.collectionAddress,
    parsed.tokenId,
    scopes,
  )
  return NextResponse.json({ pinned: false, removed })
}
