import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { fetchMomentDetail } from '@/lib/momentDetail'
import { SITE_URL } from '@/lib/siteUrl'
import {
  momentPreviewSource,
  momentPosterUri,
  readPreview,
  warmMomentPreview,
  PREVIEW_CONTENT_TYPE,
} from '@/lib/media/animatedPreview'

// warmMomentPreview shells out to native ffmpeg — needs the Node runtime.
export const runtime = 'nodejs'
// The handler only reads moment detail + the on-disk preview cache; any ffmpeg
// warm it kicks runs in the background. Generous bound for the detail fetch.
export const maxDuration = 30

// Animated Farcaster embed thumbnail for a video/gif moment. generateMetadata
// only points fc:miniapp.imageUrl here once the preview is cached, so the
// common path is a fast cache read. Any other case — not a video/gif, no
// fetchable source, or a cache miss (cold pod / eviction) — 302s to the static
// /opengraph-image card (kicking a background warm on a miss) so the embed
// always resolves to a valid image and never blocks on a transcode.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string; tokenId: string }> },
) {
  const { address, tokenId } = await params
  // Lowercased to match the canonical moment URL (page.tsx alternates.canonical).
  const staticCard = `${SITE_URL}/artwork/${address.toLowerCase()}/${tokenId}/opengraph-image`
  // no-store on the redirect: the common path only points imageUrl here when the
  // preview is cached, so a 302 means a cold edge case (e.g. evicted between
  // metadata gen and this fetch) — must not be cached, or a stale 302 would
  // pin the card to the static image after the preview warms. The static
  // target carries its own long cache once followed.
  const fallback = () =>
    new NextResponse(null, {
      status: 302,
      headers: { Location: staticCard, 'Cache-Control': 'no-store' },
    })

  if (!isAddress(address) || !isValidTokenId(tokenId)) return fallback()

  let detail
  try {
    detail = await fetchMomentDetail(address, tokenId)
  } catch {
    return fallback()
  }
  // Withheld moment → static route (which renders the neutral hidden card).
  if (!detail || detail.hidden) return fallback()

  const src = momentPreviewSource(detail.metadata)
  if (!src) return fallback()

  // Cache read only — never block Farcaster's fetch on ffmpeg. readPreview
  // serves the current recipe when present and falls back to the previous
  // generation, so a recipe bump keeps every working embed animating while
  // the regenerate is pending. A total miss (cold pod, eviction, or a
  // not-yet-warm moment) kicks a background warm and shows the static card
  // now; the next scrape animates once the preview lands.
  const preview = await readPreview(src)
  if (!preview) {
    warmMomentPreview(src, momentPosterUri(detail.metadata))
    return fallback()
  }

  return new Response(new Uint8Array(preview), {
    status: 200,
    headers: {
      'Content-Type': PREVIEW_CONTENT_TYPE,
      'Content-Length': String(preview.byteLength),
      // Content-addressed source ⇒ the preview never changes. Immutable +
      // 1-year so Farcaster's fetch and any CDN serve repeats without work.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
