import { NextRequest, NextResponse } from 'next/server'
import { verifyPrivilegedSession } from '@/lib/curator'
import {
  getAllCreatorLists,
  saveCreatorList,
  deleteCreatorList,
  slugify,
} from '@/lib/creatorLists'

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
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    slug?: string
    name?: string
    addresses?: unknown[]
    signature?: string
    timestamp?: number
    signerAddress?: string
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const err = await verifyPrivilegedSession(body)
  if (err) return NextResponse.json({ error: err.error }, { status: err.status })

  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }
  if (!Array.isArray(body.addresses)) {
    return NextResponse.json({ error: 'addresses[] required' }, { status: 400 })
  }

  let slug = body.slug?.trim() || slugify(body.name)
  if (!slug) {
    return NextResponse.json({ error: 'name produces an empty slug' }, { status: 400 })
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
      return NextResponse.json(
        { error: 'A list with that name already exists. Pass slug to update.' },
        { status: 409 },
      )
    }
  }

  const addresses = body.addresses.filter((a): a is string => typeof a === 'string')
  const saved = await saveCreatorList({ slug, name: body.name, addresses })
  return NextResponse.json({ list: saved })
}

// Curator-gated. Auth in the body since DELETE bodies are valid HTTP
// (and our /api/featured DELETE follows the same shape). slug in the
// query string keeps the URL self-describing in server logs.
export async function DELETE(req: NextRequest) {
  const slug = new URL(req.url).searchParams.get('slug')
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 })

  const body = (await req.json().catch(() => null)) as {
    signature?: string
    timestamp?: number
    signerAddress?: string
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const err = await verifyPrivilegedSession(body)
  if (err) return NextResponse.json({ error: err.error }, { status: err.status })

  const removed = await deleteCreatorList(slug)
  return NextResponse.json({ removed })
}
