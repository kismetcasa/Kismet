import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { authorizeProfileOwner } from '@/lib/profileOwner'
import { expandToFidSiblings } from '@/lib/addressUnion'
import { errorResponse } from '@/lib/apiResponse'
import { inprocessUrl, resolveUri } from '@/lib/inprocess'
import { fetchCreatorFromTimeline, getKvCreatorAddress } from '@/lib/momentDetail'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashAverageRgb } from '@/lib/media/thumbhash'
import { isCollected } from '@/lib/collected'
import { extractPalette, paletteFromColor, themeGeometry } from '@/lib/colorExtract'
import { getProfileTheme, setProfileTheme, clearProfileTheme, type ProfileTheme, type ThemeMotion } from '@/lib/profileTheme'

// sharp (palette extraction) requires the Node runtime.
export const runtime = 'nodejs'

interface MomentMeta {
  name?: string
  image?: string
  animation_url?: string
  content?: { mime?: string; uri?: string }
  kismet_thumbhash?: string
}

// Fetch the moment's metadata + creator. Metadata from the exact-token /moment
// endpoint (reliable for any token); creator prefers the KV minter EOA — the
// real artist recorded at mint, reliable regardless of collection size — and
// falls back to timeline attribution for non-Kismet mints. Set-time only.
async function fetchMoment(
  collectionAddress: string,
  tokenId: string,
): Promise<{ metadata: MomentMeta; creator: string | null } | null> {
  try {
    const [res, kvCreator, timelineCreator] = await Promise.all([
      fetch(inprocessUrl('/moment', { collectionAddress, tokenId, chainId: '8453' }), {
        headers: { Accept: 'application/json' },
        next: { revalidate: 60 },
      }),
      getKvCreatorAddress(collectionAddress, tokenId),
      fetchCreatorFromTimeline(collectionAddress, tokenId),
    ])
    if (!res.ok) return null
    const data = (await res.json().catch(() => null)) as { metadata?: MomentMeta } | null
    if (!data) return null
    const creator = (kvCreator ?? timelineCreator?.address)?.toLowerCase() ?? null
    return { metadata: data.metadata ?? {}, creator }
  } catch {
    return null
  }
}

// Restrict theme sources to the owner's own mints OR collected moments, both
// unioned across FC sibling wallets (expandToFidSiblings includes the canonical).
async function ownsMoment(
  canonical: string,
  collectionAddress: string,
  tokenId: string,
  creator: string | null,
): Promise<boolean> {
  const siblings = (await expandToFidSiblings(canonical)).map((a) => a.toLowerCase())
  if (creator && siblings.includes(creator)) return true // minted by them
  for (const s of siblings) if (await isCollected(s, collectionAddress, tokenId)) return true
  return false
}

// Coerce a client-supplied motion object into the stored shape: only literal
// `true` enables an effect (so the default is always off), and hueRange is
// clamped to a sane band, kept only when hue is on. Returns undefined when
// nothing is enabled, so an all-off theme stores no motion field. Shared by
// POST (carry prefs across a moment change) and PATCH (toggle them).
function sanitizeMotion(raw: unknown): ThemeMotion | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  const out: ThemeMotion = {}
  if (m.bloom === true) out.bloom = true
  if (m.mesh === true) out.mesh = true
  if (m.hue === true) {
    out.hue = true
    const r = typeof m.hueRange === 'number' && Number.isFinite(m.hueRange) ? Math.round(m.hueRange) : 20
    out.hueRange = Math.min(360, Math.max(10, r))
  }
  if (m.live === true) out.live = true
  return Object.keys(out).length ? out : undefined
}

// POST { collectionAddress, tokenId, motion? } — owner-only. Validate ownership,
// fetch the moment's media, extract the palette, store the theme. `motion` lets
// the client carry the owner's existing motion prefs across a source change.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')
  const auth = await authorizeProfileOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { collectionAddress?: unknown; tokenId?: unknown; motion?: unknown } | null
  const collectionAddress = body?.collectionAddress
  const tokenId = body?.tokenId
  if (!collectionAddress || !isAddress(collectionAddress)) return errorResponse(400, 'Invalid collectionAddress')
  if (!isValidTokenId(tokenId)) return errorResponse(400, 'Invalid tokenId')

  const moment = await fetchMoment(collectionAddress, tokenId)
  if (!moment) return errorResponse(404, 'Moment not found')
  if (!(await ownsMoment(auth.canonical, collectionAddress, tokenId, moment.creator))) {
    return errorResponse(403, 'You can only theme from your own mints or collected moments')
  }

  const md = moment.metadata
  const resolved = resolveMomentMedia(md)
  const mediaType: ProfileTheme['mediaType'] =
    resolved.kind === 'gif' ? 'gif' : resolved.kind === 'video' ? 'video' : 'image'
  const isAnimated = mediaType !== 'image'

  // Palette source: a video's poster, or frame 1 of a gif / the still image —
  // sharp can't decode a video stream, but it reads a gif's first frame fine.
  const extractRaw = resolved.kind === 'video'
    ? resolved.poster ?? md.image
    : resolved.src ?? resolved.poster ?? md.image
  const extractUrl = extractRaw ? resolveUri(extractRaw) : ''
  // Backdrop still: a NON-animated frame only (never the video/gif src), so the
  // V3 still layer can't animate when the owner hasn't enabled the live backdrop.
  // resolveMomentMedia's `poster` is already guaranteed non-animated, so we use
  // it directly (NOT md.image, which for a poster-less gif IS the gif). May be
  // empty for such a gif — then the still layer is skipped and the palette
  // gradient carries the backdrop until `live` plays it.
  const stillRaw = resolved.kind === 'image' ? resolved.src ?? md.image : resolved.poster
  const stillUrl = stillRaw ? resolveUri(stillRaw) : ''

  let palette = extractUrl ? await extractPalette(extractUrl) : null
  if (!palette && md.kismet_thumbhash) {
    const rgb = thumbhashAverageRgb(md.kismet_thumbhash)
    if (rgb) palette = paletteFromColor(rgb)
  }
  if (!palette) return errorResponse(422, "Couldn't read colors from this moment")

  // Carry the owner's motion prefs across a source change, but drop `live` when
  // the new source is a still image — there's nothing to play, and the panel
  // hides that toggle for image themes, so a stale live:true would be unclearable.
  let motion = sanitizeMotion(body?.motion)
  if (mediaType === 'image' && motion?.live) {
    const next = { ...motion }
    delete next.live
    motion = Object.keys(next).length ? next : undefined
  }

  const ref = `${collectionAddress.toLowerCase()}:${tokenId}`
  const theme: ProfileTheme = {
    momentRef: ref,
    momentName: md.name?.trim() || undefined,
    mediaType,
    mediaUrl: stillUrl,
    animationUrl: isAnimated && resolved.src ? resolveUri(resolved.src) : undefined,
    thumbhash: md.kismet_thumbhash,
    palette,
    geometry: themeGeometry(ref, auth.canonical),
    motion,
    updatedAt: Date.now(),
  }
  await setProfileTheme(auth.canonical, theme)
  return NextResponse.json({ theme })
}

// PATCH { motion?, primaryIndex? } — owner-only. Partial update of the existing
// theme without re-extracting the palette: toggle/adjust ambient motion (the
// toggles + hue slider), and/or re-pick which palette color is the accent
// (primaryIndex into the contrast-safe ringStops). Only the fields present in
// the body change, so a re-pick can't wipe motion and vice-versa. 404 when
// there's no theme to patch. One small GET + SET, only on an owner action.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')
  const auth = await authorizeProfileOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { motion?: unknown; primaryIndex?: unknown } | null
  const existing = await getProfileTheme(auth.canonical)
  if (!existing) return errorResponse(404, 'No theme to update')

  const theme: ProfileTheme = { ...existing, updatedAt: Date.now() }
  if (body && 'motion' in body) theme.motion = sanitizeMotion(body.motion)
  const idx = body?.primaryIndex
  if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < existing.palette.ringStops.length) {
    // Re-pick the accent from the already-clamped ring colors (contrast-safe),
    // leaving the rest of the palette + the backdrop untouched.
    theme.palette = { ...existing.palette, primary: existing.palette.ringStops[idx] }
  }
  await setProfileTheme(auth.canonical, theme)
  return NextResponse.json({ theme })
}

// DELETE — owner-only. Clear the theme (profile reverts to the brand default).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')
  const auth = await authorizeProfileOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)
  await clearProfileTheme(auth.canonical)
  return NextResponse.json({ theme: null })
}
