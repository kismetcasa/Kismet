import { ImageResponse } from 'next/og'
import { isAddress } from '@/lib/address'
import { INPROCESS_API, shortAddress } from '@/lib/inprocess'
import {
  shareCard,
  SHARE_CARD_SIZE,
  SHARE_CARD_CONTENT_TYPE,
} from '@/lib/shareCard'

// Dynamic share-card fallback for collections. Mirrors the moment-page
// counterpart — branded card with name + creator, used by share crawlers
// when the collection has no real cover image (text-mint auto-deploy
// stores SVG data URIs that shareImageUrl drops, plus any collection
// without a cover ever set). When a real cover exists, generateMetadata
// puts it first in openGraph.images and crawlers prefer it.

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE

interface Props {
  params: Promise<{ address: string }>
}

interface CollectionRow {
  metadata?: { name?: string; description?: string }
  creator?: { address: string; username?: string | null }
}

async function fetchCollection(address: string): Promise<CollectionRow | null> {
  try {
    const url = new URL(`${INPROCESS_API}/collection`)
    url.searchParams.set('collectionAddress', address)
    url.searchParams.set('chainId', '8453')
    // 24h cache — see opengraph-image.tsx in moment route for rationale.
    // Collection metadata is similarly long-lived; the extra freshness of
    // a 5min TTL isn't worth the inprocess fetch traffic.
    const res = await fetch(url.toString(), { next: { revalidate: 86400 } })
    if (!res.ok) return null
    return (await res.json()) as CollectionRow
  } catch {
    return null
  }
}

export default async function Image({ params }: Props) {
  const { address } = await params

  let title = `Collection ${shortAddress(address)}`
  let creator = ''

  if (isAddress(address)) {
    const row = await fetchCollection(address)
    if (row?.metadata?.name) title = row.metadata.name
    if (row?.creator) {
      creator = row.creator.username || shortAddress(row.creator.address)
    }
  }

  return new ImageResponse(shareCard({ label: 'COLLECTION', title, creator }), {
    ...SHARE_CARD_SIZE,
  })
}
