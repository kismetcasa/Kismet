import { ImageResponse } from 'next/og'
import {
  shareCard,
  SHARE_CARD_SIZE,
  SHARE_CARD_CONTENT_TYPE,
} from '@/lib/shareCard'
import { getGuide } from '../guides'

// Share card for each /learn/[slug] guide — og:image + twitter:image via the
// file convention, Farcaster embed + Article schema image point here
// explicitly. Guides are static data, so this renders the branded text card
// with the guide's title; an unknown slug falls back to the hub title (the
// page itself 404s, so that card is never actually shared).

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE

interface Props {
  params: Promise<{ slug: string }>
}

export default async function Image({ params }: Props) {
  const { slug } = await params
  const guide = getGuide(slug)
  return new ImageResponse(
    shareCard({
      label: 'GUIDE',
      title: guide?.title ?? 'Onchain art, minting, and collecting',
      creator: 'Kismet',
    }),
    { ...SHARE_CARD_SIZE },
  )
}
