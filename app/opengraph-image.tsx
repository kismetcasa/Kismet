import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ImageResponse } from 'next/og'
import {
  shareCard,
  SHARE_CARD_SIZE,
  SHARE_CARD_CONTENT_TYPE,
} from '@/lib/shareCard'

// Site-wide default share card: the same art the Farcaster Mini App embed
// shows (app/layout.tsx wires NEXT_PUBLIC_FARCASTER_EMBED_IMAGE_URL ??
// /embed-default.png into fc:miniapp), so an apex link pasted on X / Discord /
// iMessage renders the identical card a cast does. Next uses the closest
// segment's opengraph-image for routes without their own, so this is also the
// default for /mint, /market, /agent, /discover — while moment / collection /
// profile / learn keep their dedicated cards (their own files/images win).
//
// The default art is read from public/ off disk rather than self-fetched by
// URL: this route is static, so the read runs on the build machine where the
// repo is guaranteed present — no network in the loop to silently bake the
// fallback. When the env override is set there is no local file, so the URL is
// passed through for Satori to fetch at prerender, mirroring what every
// Farcaster client does with the same value. Either path failing falls back to
// the branded text card (fetch failure additionally bakes the title as alt
// text — see shareCard).

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE
export const alt = 'Kismet — discover, collect, and mint onchain art on Base'

export default async function Image() {
  let imageUrl = process.env.NEXT_PUBLIC_FARCASTER_EMBED_IMAGE_URL
  if (!imageUrl) {
    try {
      const png = await readFile(join(process.cwd(), 'public', 'embed-default.png'))
      imageUrl = `data:image/png;base64,${png.toString('base64')}`
    } catch {
      // Missing file — render the text-only branded card.
    }
  }
  return new ImageResponse(
    shareCard({
      label: 'ONCHAIN ART',
      title: 'Discover, collect & mint',
      creator: 'kismet.art',
      imageUrl,
    }),
    { ...SHARE_CARD_SIZE },
  )
}
