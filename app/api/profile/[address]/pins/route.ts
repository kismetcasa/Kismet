import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { getSessionAddress } from '@/lib/session'
import { resolveCanonicalProfile } from '@/lib/addressUnion'
import { errorResponse } from '@/lib/apiResponse'
import { addPin, removePin, getAllPins, isPinCategory } from '@/lib/showcase'

// GET /api/profile/[address]/pins — public. Returns the owner's pinned
// showcase refs per category, newest-pinned first. Served fresh (uncached,
// like /api/featured) so a just-pinned moment is visible to other viewers
// immediately — it's three small ZRANGEs.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')

  // The profile page redirects to the canonical address, so callers reach
  // this with the canonical key already — no per-request resolution needed
  // on the hot read path.
  const pins = await getAllPins(address)
  return NextResponse.json({ pins })
}

interface PinBody {
  category?: unknown
  collectionAddress?: unknown
  tokenId?: unknown
}

// Authorize the caller as the profile owner. Pins are canonical-keyed, so
// equality is checked on canonical addresses: an FC user signing from any
// verified wallet edits the one showcase that backs their profile.
async function authorizeOwner(
  req: NextRequest,
  pathAddress: string,
): Promise<{ canonical: string } | { error: string; status: number }> {
  const session = await getSessionAddress(req)
  if (!session) return { error: 'Sign in to continue', status: 401 }

  const [sessionCanon, pathCanon] = await Promise.all([
    resolveCanonicalProfile(session),
    resolveCanonicalProfile(pathAddress),
  ])
  if (
    sessionCanon.canonicalAddress.toLowerCase() !==
    pathCanon.canonicalAddress.toLowerCase()
  ) {
    return { error: 'You can only edit your own profile', status: 403 }
  }
  return { canonical: pathCanon.canonicalAddress }
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

  const auth = await authorizeOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const parsed = parsePinBody(await req.json().catch(() => null))
  if ('error' in parsed) return errorResponse(400, parsed.error)

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

  const auth = await authorizeOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const parsed = parsePinBody(await req.json().catch(() => null))
  if ('error' in parsed) return errorResponse(400, parsed.error)

  await removePin(parsed.category, auth.canonical, parsed.collectionAddress, parsed.tokenId)
  return NextResponse.json({ pinned: false })
}
