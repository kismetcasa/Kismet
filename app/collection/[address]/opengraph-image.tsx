import { ImageResponse } from 'next/og'
import { isAddress } from '@/lib/address'
import { inprocessUrl, shortAddress } from '@/lib/inprocess'
import { shareImageUrl } from '@/lib/media/shareImage'
import { getCollectionMeta as getKvCollectionMeta } from '@/lib/kv'
import {
  shareCard,
  SHARE_CARD_SIZE,
  SHARE_CARD_CONTENT_TYPE,
} from '@/lib/shareCard'

// Canonical share-card for collections — og:image, twitter:image (both
// auto-wired via the file convention) and the Farcaster embed all resolve
// here. When a cover resolves it renders full-bleed; otherwise it falls
// back to a branded card with name + creator. Satori rasterizes any-size
// source into the bounded 1200x800 PNG, which is why crawlers point here
// instead of at the raw cover: X drops images >5MB and the next/image
// optimizer 413's on sources >4MB (see MomentImage proxy mode).

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE

interface Props {
  params: Promise<{ address: string }>
}

interface CollectionRow {
  metadata?: { name?: string; description?: string; image?: string }
  creator?: { address: string; username?: string | null }
}

async function fetchCollection(address: string): Promise<CollectionRow | null> {
  try {
    const url = inprocessUrl('/collection', { collectionAddress: address, chainId: '8453' })
    // 24h cache — see opengraph-image.tsx in moment route for rationale.
    // Collection metadata is similarly long-lived; the extra freshness of
    // a 5min TTL isn't worth the inprocess fetch traffic.
    const res = await fetch(url, { next: { revalidate: 86400 }, signal: AbortSignal.timeout(8_000) })
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
  let imageUrl: string | undefined

  if (isAddress(address)) {
    // Resolve name + cover the same way the page header does: KV (written
    // at deploy time, fast, canonical for collections we deployed) wins,
    // inprocess is the fallback for collections we didn't. Keeps the card
    // in sync with what the page shows.
    const [row, kv] = await Promise.all([
      fetchCollection(address),
      getKvCollectionMeta(address),
    ])
    title = kv?.name ?? row?.metadata?.name ?? title
    if (row?.creator) {
      creator = row.creator.username || shortAddress(row.creator.address)
    }
    // Full-bleed cover when one resolves; shareImageUrl drops data: URIs
    // and SSRF-guards the host. No cover → shareCard renders the branded
    // fallback with the title + creator below.
    imageUrl = shareImageUrl(kv?.image ?? row?.metadata?.image)
  }

  return new ImageResponse(shareCard({ label: 'COLLECTION', title, creator, imageUrl }), {
    ...SHARE_CARD_SIZE,
  })
}
