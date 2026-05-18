import { ImageResponse } from 'next/og'
import { isAddress } from '@/lib/address'
import { INPROCESS_API, shortAddress } from '@/lib/inprocess'

// Dynamic share-card fallback for collections. Mirrors the moment-page
// counterpart — branded card with name + creator, used by share crawlers
// when the collection has no real cover image (text-mint auto-deploy
// stores SVG data URIs that shareImageUrl drops, plus any collection
// without a cover ever set). When a real cover exists, generateMetadata
// puts it first in openGraph.images and crawlers prefer it.

// 1200x800 is 3:2 — exact match for the Farcaster Mini App embed image
// spec. See moment/[address]/[tokenId]/opengraph-image.tsx for the
// rationale on serving the same image to FC + OG crawlers.
export const size = { width: 1200, height: 800 }
export const contentType = 'image/png'

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

  let name = `Collection ${shortAddress(address)}`
  let creator = ''

  if (isAddress(address)) {
    const row = await fetchCollection(address)
    if (row?.metadata?.name) name = row.metadata.name
    if (row?.creator) {
      creator = row.creator.username || shortAddress(row.creator.address)
    }
  }

  const displayName = name.length > 50 ? `${name.slice(0, 47)}…` : name

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundImage: 'linear-gradient(135deg, #1a1a1a 0%, #0a0a0a 100%)',
          padding: '72px',
          justifyContent: 'space-between',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ fontSize: 28, letterSpacing: 6, color: '#666' }}>
            KISMET ART
          </div>
          <div style={{ fontSize: 20, letterSpacing: 4, color: '#444' }}>
            COLLECTION
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              fontSize: 80,
              lineHeight: 1.1,
              color: '#efefef',
              letterSpacing: -1,
              maxWidth: 1000,
            }}
          >
            {displayName}
          </div>
          {creator && (
            <div
              style={{
                fontSize: 32,
                color: '#888',
                marginTop: 32,
              }}
            >
              by {creator}
            </div>
          )}
        </div>
      </div>
    ),
    { ...size },
  )
}
