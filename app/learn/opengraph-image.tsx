import { ImageResponse } from 'next/og'
import {
  shareCard,
  SHARE_CARD_SIZE,
  SHARE_CARD_CONTENT_TYPE,
} from '@/lib/shareCard'

// Share card for the /learn hub — og:image + twitter:image auto-wired via the
// file convention, and the page's Farcaster embed points here explicitly.
// Static content → text-only branded card (no cover art to render).

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE

export default function Image() {
  return new ImageResponse(
    shareCard({
      label: 'LEARN',
      title: 'Onchain art, minting, and collecting',
      creator: 'Kismet',
    }),
    { ...SHARE_CARD_SIZE },
  )
}
