import { ImageResponse } from 'next/og'
import {
  shareCard,
  SHARE_CARD_SIZE,
  SHARE_CARD_CONTENT_TYPE,
} from '@/lib/shareCard'

// Dedicated share card for /discover — the footer-linked market browser gets
// its own og:image instead of inheriting the site-wide default, so a shared
// filter link previews as the market surface it is. Same shareCard system as
// every other card, so the visual identity can't drift.

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE
export const alt = 'Discover — every mint and resale on Kismet, in chronological order'

export default function Image() {
  return new ImageResponse(
    shareCard({
      label: 'DISCOVER',
      title: 'Every mint & resale',
      creator: 'kismet.art',
    }),
    { ...SHARE_CARD_SIZE },
  )
}
