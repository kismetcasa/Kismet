import { NextRequest, NextResponse } from 'next/server'
import { verifyPrivilegedSession } from '@/lib/curator'
import {
  getAllCreatorLists,
  saveCreatorList,
  deleteCreatorList,
  slugify,
} from '@/lib/creatorLists'
import { errorResponse } from '@/lib/apiResponse'

// Public — anyone can read which curated rosters exist. Lists never carry
// private data (just lowercased EOA addresses already on the public chain),
// so there's no draft/published split to enforce here.
export async function GET() {
  const lists = await getAllCreatorLists()
  return NextResponse.json({ lists })
}

// Curator-gated. Upserts by slug:
//   - body.slug provided: write at that slug (creates or updates).
//   - body.slug omitted: derive from body.name. Returns 409 if the derived
//     slug already exists, so the curator has to rename the collision
//     explicitly rather than accidentally overwriting another list.
// Auth is via HttpOnly session cookie set by /api/auth/login.
export async function POST(req: NextRequest) {
  const auth = await verifyPrivilegedSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    slug?: string
    name?: string
    addresses?: unknown[]
    collection?: string
  } | null
  if (!body) return errorResponse(400, 'Invalid request body')

  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return errorResponse(400, 'name required')
  }
  if (!Array.isArray(body.addresses)) {
    return errorResponse(400, 'addresses[] required')
  }

  let slug = body.slug?.trim() || slugify(body.name)
  if (!slug) {
    return errorResponse(400, 'name produces an empty slug')
  }
  // Sanitize an explicitly-passed slug too — accepts whatever the curator
  // typed only after running it through the same normalization the
  // auto-derive path uses. Prevents URL-unsafe slugs from sneaking in.
  if (body.slug) slug = slugify(body.slug) ?? slug

  // Collision rule: if no slug was passed, treat it as a *create* and
  // refuse to silently overwrite. Updates require an explicit slug so
  // the intent is unambiguous.
  if (!body.slug) {
    const all = await getAllCreatorLists()
    if (all.some((l) => l.slug === slug)) {
      return errorResponse(409, 'A list with that name already exists. Pass slug to update.')
    }
  }

  const addresses = body.addresses.filter((a): a is string => typeof a === 'string')
  const collection = typeof body.collection === 'string' ? body.collection : undefined
  const saved = await saveCreatorList({ slug, name: body.name, addresses, collection })
  return NextResponse.json({ list: saved })
}

// Curator-gated. slug in the query string keeps the URL self-describing
// in server logs. Auth via HttpOnly session cookie.
export async function DELETE(req: NextRequest) {
  const auth = await verifyPrivilegedSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const slug = new URL(req.url).searchParams.get('slug')
  if (!slug) return errorResponse(400, 'slug required')

  const removed = await deleteCreatorList(slug)
  return NextResponse.json({ removed })
}
