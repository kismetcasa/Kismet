import { ImageResponse } from 'next/og'
import { isAddress, isValidTokenId } from '@/lib/address'
import { shortAddress } from '@/lib/inprocess'
import { fetchMomentDetail } from '@/lib/momentDetail'
import { shareImageSource } from '@/lib/media/shareImage'
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
// ("VIDEO" / "WRITING" / "ARTWORK").

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE

interface Props {
  params: Promise<{ address: string; tokenId: string }>
}

export default async function Image({ params }: Props) {
  const { address, tokenId } = await params

  let title = `#${tokenId}`
  let creator = ''
  let label = 'ARTWORK'
  let imageUrl: string | undefined

  if (isAddress(address) && isValidTokenId(tokenId)) {
    // fetchMomentDetail stitches the creator field via the timeline
    // endpoint (inprocess /moment doesn't return one). Without that
    // enrichment, detail.creator is always undefined here and the
    // "by <creator>" line at the bottom of the share card never
    // renders.
    const detail = await fetchMomentDetail(address, tokenId)
    // Creator-hidden moment → default card only (label + #tokenId, both
    // already in the URL): no name, no creator, no artwork. Mirrors the
    // profile opengraph-image's hidden handling — the URL stays fetchable
    // for crawlers that cached it, but leaks nothing the page withholds.
    if (detail && !detail.hidden) {
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
      // shareImageSource applies shareImageUrl's guards (gateway mapping,
      // attacker data:-URI drop, the legacy animation_url-in-meta.image
      // bug) and then, when /api/img's disk cache already holds the
      // cover's downscaled variant — true for every heavy proxy-class
      // cover like the Patron scans — inlines it as a small jpeg so
      // Satori never re-downloads a multi-MB original mid-render (the
      // failure that blanked this class's Farcaster embeds).
      imageUrl = await shareImageSource(detail.metadata?.image, detail.metadata?.animation_url)
    }
  }

  return new ImageResponse(shareCard({ label, title, creator, imageUrl }), {
    ...SHARE_CARD_SIZE,
  })
}
