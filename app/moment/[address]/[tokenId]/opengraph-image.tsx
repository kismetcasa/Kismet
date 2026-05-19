import { ImageResponse } from 'next/og'
import { isAddress, isValidTokenId } from '@/lib/address'
import { inprocessUrl, shortAddress, type MomentDetail } from '@/lib/inprocess'
import { shareImageUrl } from '@/lib/media/shareImage'
import {
  shareCard,
  SHARE_CARD_SIZE,
  SHARE_CARD_CONTENT_TYPE,
} from '@/lib/shareCard'

// Dynamic share-card for moments. Serves two roles:
//
//   1. og:image fallback for Twitter / Discord / iMessage. Those
//      crawlers still prefer the raw poster URL (which appears first
//      in openGraph.images in generateMetadata), so this route only
//      kicks in for text moments, video moments without a separate
//      poster, and any moment whose meta.image was rejected by
//      shareImageUrl.
//
//   2. Canonical Farcaster Mini App embed image. generateMetadata
//      always points fc:miniapp.imageUrl at this route, regardless of
//      whether a poster exists, so every shared moment renders a
//      consistent 1200x800 (3:2) PNG inside Farcaster's strict size +
//      ratio constraints — Twitter/Discord can tolerate the raw URL
//      at any size, but FC's embed validator can't.
//
// When a poster resolves cleanly, this route renders a side-by-side
// card: 800x800 image hero + 400-wide branded text panel. Otherwise
// it falls back to the text-only branded card with a media-type label
// ("VIDEO" / "WRITING" / "MOMENT").

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
    const url = inprocessUrl('/moment', { collectionAddress: address, tokenId, chainId: '8453' })
    // 24h cache — moment metadata is effectively immutable post-mint, so
    // there's no point revalidating frequently. Longer TTL bounds the
    // generator invocation count (each unique URL fires at most once
    // per day), trading "name edit shows up in share cards within 5
    // minutes" for lower upstream load on the inprocess API.
    const res = await fetch(url, { next: { revalidate: 86400 } })
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
  let imageUrl: string | undefined

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
      // Resolve the moment's poster for the hero side of the card.
      // shareImageUrl maps ar:// / ipfs:// to public gateways, drops
      // data: URIs (Satori can't reliably embed them at this scale),
      // and guards against the legacy bug where animation_url leaked
      // into meta.image — for video moments that means we get the
      // separate poster when one exists, and otherwise fall through
      // to the text-only branded "VIDEO" card.
      imageUrl = shareImageUrl(detail.metadata?.image, detail.metadata?.animation_url)
    }
  }

  return new ImageResponse(shareCard({ label, title, creator, imageUrl }), {
    ...SHARE_CARD_SIZE,
  })
}
