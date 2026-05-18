import { ImageResponse } from 'next/og'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API, shortAddress, type MomentDetail } from '@/lib/inprocess'

// Dynamic share-card fallback for moments. Next.js auto-injects this
// route's URL into og:image so any share where generateMetadata didn't
// set its own openGraph.images (text moments, video moments where
// poster extraction failed, legacy moments with broken meta.image)
// still renders a branded card on Twitter/Discord/iMessage instead of
// falling back to summary text. Moments with real posters keep their
// real image as the share card — that URL appears first in the
// metadata and crawlers prefer it.

// 1200x800 is 3:2 — exact match for the Farcaster Mini App embed image
// spec (3:2 ratio, 600x400 min, 3000x2000 max). Twitter / Facebook /
// Discord all accept any aspect ratio and crop client-side, so this
// works for both surfaces without a separate route.
export const size = { width: 1200, height: 800 }
export const contentType = 'image/png'

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

  let name = `#${tokenId}`
  let creator = ''
  let label = 'MOMENT'

  if (isAddress(address) && isValidTokenId(tokenId)) {
    const detail = await fetchDetail(address, tokenId)
    if (detail) {
      if (detail.metadata?.name) name = detail.metadata.name
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

  // Truncate to keep within the 1200x800 frame at our chosen font size.
  // Satori doesn't handle text-overflow gracefully; we cap up front.
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
            {label}
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
