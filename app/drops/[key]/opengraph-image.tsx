import { ImageResponse } from 'next/og'
import { displayNameFor } from '@/lib/displayName'
import { shareImageSource } from '@/lib/media/shareImage'
import { isEntityKey, normalizeEntityKey, swarmGatewayUrl } from '@/lib/drops'
import { getDropRecord, isDropsEnabled } from '@/lib/dropsStore'
import { shareCard, SHARE_CARD_SIZE, SHARE_CARD_CONTENT_TYPE } from '@/lib/shareCard'

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE

/**
 * A drop's share card — the card a cast of the drop page renders, with the
 * Claim button (app/drops/[key]/page.tsx). The artwork is read through
 * Swarm's public gateway: an https URL lib/media/shareImage fetches with its
 * bounds and re-encodes, so the card never depends on Satori loading it.
 * Anything missing gets the bare branded card, never a 500.
 */
export default async function Image({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  let title = 'Kismet'
  let creator = ''
  let imageUrl: string | undefined
  try {
    const drop = isEntityKey(key) && isDropsEnabled() ? await getDropRecord(normalizeEntityKey(key)) : null
    if (drop) {
      title = drop.title
      ;[creator, imageUrl] = await Promise.all([displayNameFor(drop.artist), shareImageSource(swarmGatewayUrl(drop.swarmRef))])
    }
  } catch {
    // The bare card.
  }
  return new ImageResponse(shareCard({ label: 'FREE CLAIM DROP', title, creator, imageUrl }), { ...SHARE_CARD_SIZE })
}
