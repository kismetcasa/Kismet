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
  isPinCategory,
} from '@/lib/showcase'

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

  // The profile page redirects to the canonical address, so callers reach
  // this with the canonical key already — no per-request resolution needed
  // on the hot read path. Mode resolution shares this pins read (checked, so
  // a failed read fails private instead of deriving 'full' off missing data);
  // both issued same-tick, so auto-pipelining keeps it one round trip.
  const pinsRead = getAllPinsChecked(address)
  const publicView = await resolvePublicViewMode(address, pinsRead)
  const pins = await pinsRead
  return NextResponse.json({
    pins: pins ?? { mints: [], collected: [], listings: [] },
    publicView,
  })
}

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

  // Lock the unset profile's mode to what its pins derive to BEFORE this pin
  // changes that basis — a first-ever pin under the 'full' default must mean
  // "float this first", never "flip me to showcase-only". See lib/showcase.
  await ensureViewModeForPinChange(auth.canonical)
  const ok = await addPin(parsed.category, auth.canonical, parsed.collectionAddress, parsed.tokenId)
  if (!ok) return errorResponse(409, 'Pin limit reached — unpin one first')
  return NextResponse.json({ pinned: true })
}

// DELETE /api/profile/[address]/pins — owner-only. Unpin. Mirrors POST shape.
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

  // Same prelude as POST: a legacy profile unpinning its last pin stays
  // 'curated' (grandfathered) rather than silently resolving to 'full'.
  await ensureViewModeForPinChange(auth.canonical)
  await removePin(parsed.category, auth.canonical, parsed.collectionAddress, parsed.tokenId)
  return NextResponse.json({ pinned: false })
}
