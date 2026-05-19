import type { Metadata } from 'next'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { isAddress, isValidTokenId } from '@/lib/address'
import { resolveUri } from '@/lib/inprocess'
import { shareImageUrl } from '@/lib/media/shareImage'
import { getCollectionMeta as getKvCollectionMeta, getUserCollections } from '@/lib/kv'
import { getMomentContent } from '@/lib/momentContent'
import { isCollectionHidden } from '@/lib/hiddenCollections'
import { PLATFORM_COLLECTION } from '@/lib/config'
import { SESSION_COOKIE, verifySession } from '@/lib/session'
import { fetchMomentDetail, getKvCreatorAddress } from '@/lib/momentDetail'
import { pickFirstNonOperatorAdmin } from '@/lib/momentAuthz'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { SITE_URL } from '@/lib/siteUrl'
import { MomentDetailView } from '@/components/MomentDetailView'

interface Props {
  params: Promise<{ address: string; tokenId: string }>
}

// For the cover token (tokenId='1') of a kismet-tracked collection we have
// the same metadata in KV that we wrote at deploy time. Synthesize a minimal
// fallback so the image, title, and description render instantly while
// inprocess catches up — but only for tokenId=1 since later tokens have
// their own metadata that isn't in KV.
const getFallbackMeta = cache(async (
  address: string,
  tokenId: string,
): Promise<{ name?: string; image?: string; description?: string } | undefined> => {
  if (tokenId !== '1') return undefined
  const kv = await getKvCollectionMeta(address)
  if (!kv) return undefined
  return { name: kv.name, image: kv.image, description: kv.description }
})

// Server-side hydration for the collection chip on the detail panel.
// Without this, MomentDetailView fires a client-side fetch on mount and
// the chip pops in a beat after first paint — particularly noticeable on
// kismet-deployed collections where the data is sitting right next to us
// in KV. Pulled for every tokenId (the chip is shown regardless of which
// token in the collection you're viewing).
//
// Gated to match /api/collections?address=… exactly — without the gate,
// auto-deploy wrappers leak as a clickable collection chip even though
// they're excluded from every other collection-shaped surface (feed,
// profile collections list, search, mint dropdown). addTrackedCollection
// writes collection-meta KV for both create-form AND auto-deploy paths,
// so a bare KV read isn't enough to tell them apart. The client-side
// fetch on mount returns the gated empty stub for auto-deploys, but it
// only overwrites state on a truthy name — so without this gate the
// SSR-hydrated chip persists for the life of the page.
const getInitialCollectionMeta = cache(async (
  address: string,
): Promise<{ name?: string; image?: string } | undefined> => {
  const lowerAddr = address.toLowerCase()
  if (lowerAddr === PLATFORM_COLLECTION.toLowerCase()) return undefined
  const [userCreated, hidden, kv] = await Promise.all([
    getUserCollections(),
    isCollectionHidden(address),
    getKvCollectionMeta(address),
  ])
  if (hidden) return undefined
  if (!userCreated.some((a) => a.toLowerCase() === lowerAddr)) return undefined
  if (!kv?.name && !kv?.image) return undefined
  return { name: kv.name, image: kv.image }
})

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address, tokenId } = await params
  if (!isAddress(address) || !isValidTokenId(tokenId)) {
    return { title: 'Moment — Kismet' }
  }
  const [detail, fallback] = await Promise.all([
    fetchMomentDetail(address, tokenId),
    getFallbackMeta(address, tokenId),
  ])
  const meta = detail?.metadata ?? fallback
  if (!meta) return { title: 'Moment — Kismet' }

  const name = meta.name ?? `#${tokenId}`
  const title = `${name} — Kismet`
  const description = meta.description ?? 'View this moment on Kismet'
  // Guard the share image against the legacy "meta.image is the
  // animation_url" bug — without this, Twitter/Discord/iMessage crawlers
  // would fetch a multi-MB video as the thumbnail and render no preview.
  // fallback (synthesized from KV) has no animation_url; pull from detail.
  const imageUrl = shareImageUrl(meta.image, detail?.metadata?.animation_url)

  // Farcaster Mini App embed. When this URL is shared in a cast, hosts
  // render a rich card and the button launches Kismet directly into
  // this moment's page (action.url) rather than the homepage. The image
  // is the same one OG crawlers use — opengraph-image.tsx serves it at
  // 1200x800 (3:2), exactly the FC spec ratio.
  //
  // Prefer the moment's own poster (if FC's crawler can fetch it without
  // CDN gating); fall back to our branded opengraph-image route which
  // is always reachable. Either URL must be absolute — `other` meta
  // tags aren't resolved against metadataBase.
  const canonicalUrl = `${SITE_URL}/moment/${address}/${tokenId}`
  const embedImageUrl = imageUrl ?? `${canonicalUrl}/opengraph-image`
  const fcEmbed = buildFarcasterEmbed({
    imageUrl: embedImageUrl,
    buttonTitle: 'collect',
    action: {
      url: canonicalUrl,
      name: title,
    },
  })

  return {
    title,
    description,
    openGraph: {
      title: name,
      description,
      ...(imageUrl ? { images: [{ url: imageUrl }] } : {}),
    },
    twitter: {
      // Always summary_large_image — when imageUrl isn't set, the
      // opengraph-image.tsx file convention provides a branded fallback
      // PNG, and Twitter falls back to og:image for twitter:image. Result:
      // every moment renders the large image card, never the bare
      // text-only summary.
      card: 'summary_large_image',
      title: name,
      description,
      ...(imageUrl ? { images: [imageUrl] } : {}),
    },
    other: fcEmbed,
  }
}

export default async function MomentPage({ params }: Props) {
  const { address, tokenId } = await params

  // Mirror the validation /api/moment already does so we don't waste an
  // upstream fetch + KV reads on garbage routes.
  if (!isAddress(address) || !isValidTokenId(tokenId)) notFound()

  // Resolve the viewer up front so we can decide whether to hand the full
  // detail (with metadata) to the client or render a server-side placeholder
  // that doesn't leak the moment's metadata via the React-props payload.
  // Mirrors the gating on the collection detail page.
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(SESSION_COOKIE)?.value
  const viewer = sessionToken ? await verifySession(sessionToken) : null

  const [detail, fallbackMeta, initialCollectionMeta, kvCreatorAddress] = await Promise.all([
    fetchMomentDetail(address, tokenId),
    getFallbackMeta(address, tokenId),
    getInitialCollectionMeta(address),
    getKvCreatorAddress(address, tokenId),
  ])

  // Prefer KV moment-meta (the EOA mint-proxy wrote at mint time) so
  // Kismet-minted moments resolve to the actual creator EOA. Inprocess
  // often returns the platform smart wallet as creator.address for
  // mint-proxy moments — without this priority the viewer's EOA would
  // never match `creator` and the creator would be locked out of their
  // own hidden moment. detail.creator.address is the fallback for
  // moments minted outside the Kismet flow (no KV entry); momentAdmins
  // is the last-resort signal when neither is populated.
  const creator =
    kvCreatorAddress?.toLowerCase() ??
    detail?.creator?.address?.toLowerCase() ??
    pickFirstNonOperatorAdmin(detail?.momentAdmins)?.toLowerCase()
  const isCreator =
    !!viewer && !!creator && viewer.toLowerCase() === creator

  if (detail?.hidden && !isCreator) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-24 text-center">
        <p className="text-sm font-mono text-dim">
          this moment has been hidden by the creator
        </p>
      </div>
    )
  }

  // For text moments, prefetch the body at SSR time so the client renders
  // it instantly from the React-props payload instead of waiting for a
  // separate arweave/IPFS fetch. Content is immutable so we skip revalidation.
  // If the Arweave gateway hasn't propagated yet (Turbo settlement lag),
  // fall back to the KV mirror written at mint time by /api/write so the
  // body still renders.
  const isTextMoment = detail?.metadata?.content?.mime === 'text/plain'
  const textUri = isTextMoment ? detail?.metadata?.content?.uri : undefined
  let initialTextContent: string | undefined
  if (textUri) {
    try {
      const tr = await fetch(resolveUri(textUri), { cache: 'force-cache' })
      if (tr.ok) initialTextContent = await tr.text()
    } catch { /* non-fatal — KV fallback below, then client retry on mount */ }
    // Fall through to the KV mirror written at mint time so the body
    // renders during Arweave propagation lag instead of staying blank.
    if (initialTextContent === undefined) {
      const kv = await getMomentContent(address, tokenId)
      if (kv) initialTextContent = kv
    }
  }

  return (
    <MomentDetailView
      address={address}
      tokenId={tokenId}
      initialDetail={detail}
      fallbackMeta={fallbackMeta}
      initialCollectionMeta={initialCollectionMeta}
      kvCreatorAddress={kvCreatorAddress}
      initialTextContent={initialTextContent}
    />
  )
}
