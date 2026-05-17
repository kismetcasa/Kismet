import { ImageResponse } from 'next/og'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API, shortAddress, type MomentDetail } from '@/lib/inprocess'
import {
  shareCard,
  SHARE_CARD_SIZE,
  SHARE_CARD_CONTENT_TYPE,
} from '@/lib/shareCard'

// Dynamic share-card fallback for moments. Next.js auto-injects this
// route's URL into og:image so any share where generateMetadata didn't
// set its own openGraph.images (text moments, video moments where
// poster extraction failed, legacy moments with broken meta.image)
// still renders a branded card on Twitter/Discord/iMessage instead of
// falling back to summary text. Moments with real posters keep their
// real image as the share card — that URL appears first in the
// metadata and crawlers prefer it.

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE

interface Props {
  params: Promise<{ address: string; tokenId: string }>
}

async function fetchDetail(
  address: string,
  tokenId: string,
): Promise<MomentDetail | null> {
  try {
    const url = new URL(`${INPROCESS_API}/moment`)
    url.searchParams.set('collectionAddress', address)
    url.searchParams.set('tokenId', tokenId)
    url.searchParams.set('chainId', '8453')
    // 24h cache — moment metadata is effectively immutable post-mint, so
    // there's no point revalidating frequently. Longer TTL bounds the
    // generator invocation count (each unique URL fires at most once
    // per day), trading "name edit shows up in share cards within 5
    // minutes" for lower upstream load on the inprocess API.
    const res = await fetch(url.toString(), { next: { revalidate: 86400 } })
    if (!res.ok) return null
    return (await res.json()) as MomentDetail
  } catch {
    return null
  }
}

export default async function Image({ params }: Props) {
  const { address, tokenId } = await params

  let title = `#${tokenId}`
  let creator = ''
  let label = 'MOMENT'

  if (isAddress(address) && isValidTokenId(tokenId)) {
    const detail = await fetchDetail(address, tokenId)
    if (detail) {
      if (detail.metadata?.name) title = detail.metadata.name
      if (detail.creator) {
        creator = detail.creator.username || shortAddress(detail.creator.address)
      }
      const mime = detail.metadata?.content?.mime
      if (mime?.startsWith('video/') || detail.metadata?.animation_url) {
        label = 'VIDEO'
      } else if (mime === 'text/plain') {
        label = 'WRITING'
      }
    }
  }

  return new ImageResponse(shareCard({ label, title, creator }), {
    ...SHARE_CARD_SIZE,
  })
}
