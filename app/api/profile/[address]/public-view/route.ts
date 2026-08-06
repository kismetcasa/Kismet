import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { authorizeProfileOwner } from '@/lib/profileOwner'
import { errorResponse } from '@/lib/apiResponse'
import { setPublicViewMode } from '@/lib/showcase'
import { isPublicViewMode } from '@/lib/showcaseOrder'

// POST /api/profile/[address]/public-view — owner-only. Sets what VISITORS
// see by default on this profile: { mode: 'curated' } (the pinned showcase —
// the default) or { mode: 'full' } (the full profile, pinned items first in
// each section). Session-cookie auth + canonical match, same model as the
// pins route. Read back via GET /api/profile/[address]/pins, which carries
// `publicView` alongside the pin refs.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')

  const auth = await authorizeProfileOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { mode?: unknown } | null
  const mode = body?.mode
  if (!isPublicViewMode(mode)) return errorResponse(400, 'Invalid mode')

  try {
    await setPublicViewMode(auth.canonical, mode)
  } catch {
    // The write didn't land (transient Redis failure) — surface a retryable
    // error so the owner's control reverts its optimistic state.
    return errorResponse(503, 'Could not save — try again shortly')
  }
  return NextResponse.json({ publicView: mode })
}
