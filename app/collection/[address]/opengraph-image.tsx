import { ImageResponse } from 'next/og'
import { isAddress } from '@/lib/address'
import { shortAddress } from '@/lib/inprocess'
import {
  fetchInprocessCollection,
  isKnownIndexed,
  type InprocessCollectionDetail,
} from '@/lib/inprocessCollection'
import { shareImageSource } from '@/lib/media/shareImage'
import { getCollectionMeta as getKvCollectionMeta } from '@/lib/kv'
import { isCollectionHidden } from '@/lib/hiddenCollections'
import { stripHiddenDeployerIdentity } from '@/lib/hiddenDeployer'
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
// optimizer 413's on sources past its 50MB body cap (see MomentImage
// proxy mode).

export const size = SHARE_CARD_SIZE
export const contentType = SHARE_CARD_CONTENT_TYPE

interface Props {
  params: Promise<{ address: string }>
}

// In Process's collection detail, normalized (lib/inprocessCollection) so
// `creator` is the {address, username} object this card renders. `kvMeta` is
// the in-flight KV read, consulted only on a miss (see expectIndexed).
async function fetchCollection(
  address: string,
  kvMeta: Promise<{ createdAt?: number } | null>,
): Promise<InprocessCollectionDetail | null> {
  const { detail } = await fetchInprocessCollection(address, {
    caller: 'collection-og-image',
    // 24h cache — see opengraph-image.tsx in moment route for rationale.
    // Collection metadata is similarly long-lived; the extra freshness of
    // a 5min TTL isn't worth the inprocess fetch traffic.
    revalidate: 86400,
    expectIndexed: () => kvMeta.then(isKnownIndexed),
  })
  return detail
}

export default async function Image({ params }: Props) {
  const { address } = await params

  let title = `Collection ${shortAddress(address)}`
  let creator = ''
  let imageUrl: string | undefined

  if (isAddress(address)) {
    // Fail CLOSED to the bare default card: isCollectionHidden deliberately
    // throws on a Redis blip (a blip must never briefly reveal hidden
    // content), and a bare card is a better degradation than a 500'd image.
    // The other two fetches catch internally, so the hidden check is the
    // only thrower this catch sees.
    try {
      // Resolve name + cover the same way the page header does: KV (written
      // at deploy time, fast, canonical for collections we deployed) wins,
      // inprocess is the fallback for collections we didn't. Keeps the card
      // in sync with what the page shows.
      const kvP = getKvCollectionMeta(address)
      const [rowRaw, kv, hidden] = await Promise.all([
        fetchCollection(address, kvP),
        kvP,
        isCollectionHidden(address),
      ])
      // Creator-hidden collection → default card only (shortAddress title,
      // already in the URL): no name, no creator, no cover. Mirrors the
      // profile opengraph-image's hidden handling.
      if (!hidden) {
        // Null a hidden-identity deployer's @handle before the share card renders it.
        const row = await stripHiddenDeployerIdentity(rowRaw)
        title = kv?.name ?? row?.metadata?.name ?? title
        if (row?.creator) {
          creator = row.creator.username || shortAddress(row.creator.address)
        }
        // Full-bleed cover when one resolves; shareImageSource keeps
        // shareImageUrl's guards (attacker data:-URI drop, SSRF host check)
        // and serves the disk-cached downscaled variant inline when one
        // exists, so a heavy cover can't stall Satori's mid-render fetch.
        // No cover → shareCard renders the branded fallback below.
        imageUrl = await shareImageSource(kv?.image ?? row?.metadata?.image)
      }
    } catch {
      // Bare card (shortAddress title, no cover) — never a leak, never a 500.
    }
  }

  return new ImageResponse(shareCard({ label: 'COLLECTION', title, creator, imageUrl }), {
    ...SHARE_CARD_SIZE,
  })
}
