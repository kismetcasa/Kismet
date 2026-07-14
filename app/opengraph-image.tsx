import { ImageResponse } from 'next/og'
import {
  shareCard,
  SHARE_CARD_SIZE,
  SHARE_CARD_CONTENT_TYPE,
} from '@/lib/shareCard'

// Site-wide default share card. The homepage — the most-shared URL — had NO
// og:image at all: Farcaster casts worked (the Mini App embed image lives in
// metadata.other), but X / Discord / iMessage / Slack read og:image and
// rendered the link imageless. Next uses the closest segment's opengraph-image
// for routes without their own, so this also becomes the default for /mint,
// /market, /agent — while moment / collection / profile / learn keep their
// dedicated cards (their own files/images win).

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE
export const alt = 'Kismet — discover, collect, and mint onchain art on Base'

export default function Image() {
  return new ImageResponse(
    shareCard({
      label: 'ONCHAIN ART',
      title: 'Discover, collect & mint',
      creator: 'kismet.art',
    }),
    { ...SHARE_CARD_SIZE },
  )
}
