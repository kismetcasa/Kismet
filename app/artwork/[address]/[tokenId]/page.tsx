import type { Metadata } from 'next'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { notFound, unstable_rethrow } from 'next/navigation'
import { isAddress, isValidTokenId } from '@/lib/address'
import { resolveUri, shortAddress } from '@/lib/inprocess'
import { isVideoMoment } from '@/lib/media/isVideo'
import { getCollectionMeta as getKvCollectionMeta, getUserCollections } from '@/lib/kv'
import { getMomentContent } from '@/lib/momentContent'
import { isCollectionHidden } from '@/lib/hiddenCollections'
import { PLATFORM_COLLECTION } from '@/lib/config'
import { SESSION_COOKIE, verifySession } from '@/lib/session'
import { isWebKitOnlyUA } from '@/lib/serverDevice'
import { fetchMomentDetail, getKvCreatorAddress } from '@/lib/momentDetail'
import { getCfileRecord, toPublicDescriptor } from '@/lib/collectorFile'
import { pickFirstNonOperatorAdmin } from '@/lib/momentAuthz'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { entriesOpen, isRaffleEnabled } from '@/lib/raffle'
import { resolveEmbedImageUrl } from '@/lib/media/animatedPreview'
import { getListings } from '@/lib/listings'
import { getListingVisibility } from '@/lib/hiddenListings'
import { safeRead } from '@/lib/redisRead'
import { SITE_URL } from '@/lib/siteUrl'
import { MomentDetailView } from '@/components/MomentDetailView'
import { JsonLd } from '@/components/JsonLd'
import { momentJsonLd } from '@/lib/structuredData'
import { metaDescription } from '@/lib/metaDescription'

interface Props {
  params: Promise<{ address: string; tokenId: string }>
}

// Resolve THIS token's live, visible listing (or null). Wrapped in React cache
// so generateMetadata (button text) and the page render (Offer JSON-LD) share
// one evaluation per request — one listings read, and the "View Listing" button
// and the schema.org Offer can never disagree about whether it's for sale.
// limit: 500 matches getListings' internal scan cap; safeRead degrades to
// "no listing" on a Redis blip (losing a non-essential SEO/label refinement,
// never throwing).
const getActiveListing = cache(async (address: string, tokenId: string) => {
  // Independent reads — run them in parallel (the pre-refactor code awaited
  // them sequentially; visibility is memoized so this mostly matters on a
  // cold TTL window).
  const [{ listings }, visibility] = await Promise.all([
    safeRead(
      'getListings:moment',
      () => getListings({ collection: address, limit: 500 }),
      { listings: [], total: 0 },
    ),
    safeRead('getListingVisibility:moment', () => getListingVisibility(), null),
  ])
  return listings.find((l) => l.tokenId === tokenId && !visibility?.feedHidden(l)) ?? null
})

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
  // Wrap the body in try/catch because error.tsx does NOT catch
  // generateMetadata throws in production (vercel/next.js#49925). Only
  // global-error.tsx would catch this otherwise, and a metadata-only
  // failure shouldn't blow up the whole page — return a safe fallback
  // title so the page still renders with degraded SEO/embed.
  try {
  const { address, tokenId } = await params
  // Structurally impossible URL → render the not-found page, not a stub of the
  // artwork page. MEASURED BEHAVIOUR (don't "fix" this without re-measuring):
  // this route has a loading.tsx, so Next flushes the Suspense shell with
  // HTTP 200 before metadata can influence the status — notFound() here yields
  // 200 + the not-found page + Next's injected `noindex`, NOT a 404 status.
  // The control case proves the mechanism: /learn/[slug] has no loading.tsx and
  // does return a true 404.
  //
  // Keeping it anyway, because it fixes what it can: the visitor gets a real
  // not-found page instead of a broken artwork shell, and the noindex keeps
  // junk URLs out of the index. The residual cost is soft-404 entries in Search
  // Console. A true 404 would require either dropping loading.tsx (losing the
  // streaming UX on the highest-traffic route) or adding middleware (per-request
  // overhead on every request) — both worse trades for URLs that only arise
  // from malformed links and are never in the sitemap.
  //
  // Scoped to STRUCTURAL invalidity (isAddress/isValidTokenId): deterministic
  // local checks no upstream outage can flip, so indexer lag can never take a
  // real artwork down. Well-formed-but-unindexed keeps the noindex path below.
  if (!isAddress(address) || !isValidTokenId(tokenId)) notFound()
  const [detail, fallback] = await Promise.all([
    fetchMomentDetail(address, tokenId),
    getFallbackMeta(address, tokenId),
  ])
  // Creator-hidden moment: generic metadata + noindex for EVERYONE, mirroring
  // the page body's placeholder (which returns before any content renders).
  // Without this gate the real name/description leaked into <title>/OG tags
  // even while the page itself was withheld — and the 200 placeholder was an
  // indexable stub under the hidden work's name. Same trade-off the profile
  // page documents: the creator viewing their own hidden moment also gets
  // generic metadata; only the page body is viewer-aware.
  if (detail?.hidden) return { title: 'Artwork — Kismet', robots: { index: false } }
  const meta = detail?.metadata ?? fallback
  // No metadata from either source: the emptiest page of all (indexer lag or a
  // junk token URL) — noindex for the same crawl-budget reason as the isEmpty
  // gate below. Transient upstream failure recovers on the next crawl (the
  // sitemap still lists real moments, and noindex lifts when the tag is gone).
  // The catch path below deliberately does NOT noindex: a Redis/upstream blip
  // there is unrelated to whether the moment has content.
  if (!meta) return { title: 'Artwork — Kismet', robots: { index: false } }

  const name = meta.name ?? `#${tokenId}`
  const title = `${name} — Kismet`
  // Normalized to the 25–160 char window engines want (Bing errors outside
  // it) — artist-written descriptions arrive at any length. `isEmpty` below
  // stays keyed on the RAW description, so this fallback never masks a
  // truly empty token.
  const description = metaDescription(
    meta.description,
    `${name} — artwork on Kismet, the onchain art platform on Base`,
  )
  // A moment with no title, description, AND no image has nothing indexable —
  // usually indexer lag or a broken token. noindex it so crawl budget goes to
  // real artworks. Deliberately narrow: a titled or image-bearing moment (the
  // norm — the artwork itself is content) stays fully indexable, so we don't
  // exclude legitimate art from web or image search.
  const isEmpty = !meta.name && !meta.description && !meta.image
  // Single share image for every surface: the /opengraph-image route.
  // og:image + twitter:image are auto-wired to it by Next's file
  // convention (we don't set openGraph.images); the Farcaster embed
  // points at it explicitly. The route renders the moment's poster
  // full-bleed via Satori — bounded 1200x800 (3:2) regardless of source
  // size, with the animation_url guard applied there so a video moment
  // falls back to a branded card rather than rasterizing an MP4. Pointing
  // crawlers at the raw poster instead breaks on heavy stills: X drops
  // images >5MB and the next/image optimizer 413's on sources past its
  // 50MB body cap.
  const canonicalUrl = `${SITE_URL}/artwork/${address}/${tokenId}`
  // Farcaster embed image: for a video/gif moment, the animated embed-preview
  // route once its 3:2 looping preview is cached (so the feed card MOVES),
  // else the static Satori card above while a background warm builds it — see
  // lib/media/animatedPreview. og:image / twitter:image stay on the static
  // route (Satori PNG) via the file convention; only the Farcaster imageUrl
  // upgrades, since animated GIF/WebP is a Farcaster-specific embed capability.
  const embedImageUrl = await resolveEmbedImageUrl(canonicalUrl, detail?.metadata)
  // Active marketplace listing → embed button reads "View Listing"
  // instead of "Collect <name>", since the destination conceptually
  // moves from primary-sale collect to secondary-market purchase. Same
  // action.url either way — the moment page is where the listing is
  // surfaced for purchase. Shared (React-cached) with the page's Offer
  // JSON-LD so the button label and the structured price agree.
  const hasActiveListing = !!(await getActiveListing(address, tokenId))
  // A raffle with open entries beats both labels: casts sharing this artwork
  // (incl. the post-entry share prompt) render "collect to enter" — the
  // campaign IS the reason the link is being passed around. One cheap zscore
  // read for the common no-raffle case; entriesOpen only runs when enabled.
  const raffleLive =
    (await isRaffleEnabled(address, tokenId)) && (await entriesOpen(address, tokenId))
  const fcEmbed = buildFarcasterEmbed({
    imageUrl: embedImageUrl,
    // buildFarcasterEmbed truncates at 32 chars per the FC spec, so a
    // long moment name won't break the embed — it'll just be elided.
    buttonTitle: raffleLive
      ? 'collect to enter'
      : hasActiveListing
        ? 'View Listing'
        : `Collect ${name}`,
    action: {
      url: canonicalUrl,
    },
  })

  return {
    title,
    description,
    ...(isEmpty ? { robots: { index: false } } : {}),
    // <link rel="canonical"> — lowercased address so every case variant of
    // the same moment URL (external links can arrive checksummed) collapses
    // onto one indexable URL, matching what app/sitemap.ts lists.
    alternates: { canonical: `${SITE_URL}/artwork/${address.toLowerCase()}/${tokenId}` },
    openGraph: {
      title: name,
      description,
      // og:url — share-aggregation key for FB/X scrapers; matches the
      // canonical (profile-page precedent).
      url: `${SITE_URL}/artwork/${address.toLowerCase()}/${tokenId}`,
    },
    twitter: {
      // summary_large_image + the opengraph-image file convention →
      // both og:image and twitter:image resolve to the OG route, which
      // always renders a poster-or-branded card (never a text-only
      // summary).
      card: 'summary_large_image',
      title: name,
      description,
    },
    other: fcEmbed,
  }
  } catch (err) {
    // Let Next control-flow errors (the notFound() above) propagate — without
    // this the catch would swallow it and hand back the generic fallback
    // metadata instead of the not-found page.
    unstable_rethrow(err)
    console.error('[generateMetadata] artwork', err)
    return { title: 'Artwork — Kismet' }
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

  const [detail, fallbackMeta, initialCollectionMeta, kvCreatorAddress, webKitOnly, cfileRecord] = await Promise.all([
    fetchMomentDetail(address, tokenId),
    getFallbackMeta(address, tokenId),
    getInitialCollectionMeta(address),
    getKvCreatorAddress(address, tokenId),
    isWebKitOnlyUA(),
    // Collector-file descriptor for first-paint (public facts only — the
    // helper never returns the storage pointer). safeRead inside: a Redis
    // blip degrades to "no card", refreshed by the card's own status fetch.
    getCfileRecord(address, tokenId).catch(() => null),
  ])
  const initialCfile = toPublicDescriptor(cfileRecord)

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
          this artwork has been hidden by the creator
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
      const tr = await fetch(resolveUri(textUri), {
        cache: 'force-cache',
        // Text bodies are small but the gateway is an external dependency —
        // bound the read like every other upstream fetch.
        signal: AbortSignal.timeout(10_000),
      })
      if (tr.ok) initialTextContent = await tr.text()
    } catch { /* non-fatal — KV fallback below, then client retry on mount */ }
    // Fall through to the KV mirror written at mint time so the body
    // renders during Arweave propagation lag instead of staying blank.
    if (initialTextContent === undefined) {
      const kv = await getMomentContent(address, tokenId)
      if (kv) initialTextContent = kv
    }
  }

  // Server-rendered schema.org JSON-LD: types the moment as a VisualArtwork
  // (and, when it carries a live listing, a Product with an InStock Offer at
  // the listed price) plus a Home › Collection › Moment breadcrumb. Only
  // reached on the shown page — the hidden-moment branch above returns first,
  // so we never describe a moment we're withholding. The Offer price comes from
  // the same React-cached listing the "View Listing" button uses, so schema and
  // UI can't disagree.
  const canonicalUrl = `${SITE_URL}/artwork/${address.toLowerCase()}/${tokenId}`
  const displayName = detail?.metadata?.name ?? fallbackMeta?.name ?? `#${tokenId}`
  const rawImage = detail?.metadata?.image ?? fallbackMeta?.image
  const activeListing = await getActiveListing(address, tokenId)
  const jsonLd = momentJsonLd({
    url: canonicalUrl,
    name: displayName,
    description: detail?.metadata?.description ?? fallbackMeta?.description,
    image: rawImage ? resolveUri(rawImage) : `${canonicalUrl}/opengraph-image`,
    creator: creator
      ? {
          name: detail?.creator?.username ?? shortAddress(creator),
          url: `${SITE_URL}/profile/${creator}`,
        }
      : undefined,
    // Content type → artMedium + encodingFormat in the schema (factual, never
    // guessed; omitted when the token has no declared MIME).
    mime: detail?.metadata?.content?.mime,
    hasAnimation: !!detail?.metadata?.animation_url,
    collection: initialCollectionMeta?.name
      ? { name: initialCollectionMeta.name, url: `${SITE_URL}/collection/${address.toLowerCase()}` }
      : undefined,
    listing: activeListing
      ? { price: activeListing.price, currency: activeListing.currency ?? 'eth' }
      : null,
  })

  return (
    <>
      <JsonLd data={jsonLd} />
      {/* Above-fold LCP hint for video moments — kicks the first Range
          request off during HTML parse instead of waiting until the
          <video> element mounts post-hydration. Cuts ~150-400ms of TTFF
          on cold-cache share-link landings (FC casts, X shares). Skip
          for image/text moments and when no animation_url is set.
          No crossorigin attribute: must match the no-cors mode of the
          <video> element this preload is feeding (InlineVideo doesn't set
          crossOrigin). A mismatched preload
          ends up in a different cache partition and Chrome warns
          "preload was not used" — the bytes are wasted.

          The href must be the URL the client will actually play, or the
          preload becomes a full duplicate download: videoGatewayUrls routes
          WebKit-only viewers (all of iOS + desktop Safari) through the
          /api/img proxy first, everyone else direct. Mirror that split with
          the server-side twin of the same UA test. (URL shape matches
          lib/media/gateway proxyUrl — not importable here: that module is
          'use client'.) */}
      {detail?.metadata?.animation_url &&
        isVideoMoment(detail.metadata) && (
          <link
            rel="preload"
            as="video"
            href={
              webKitOnly
                ? `/api/img?u=${encodeURIComponent(detail.metadata.animation_url)}`
                : resolveUri(detail.metadata.animation_url)
            }
          />
        )}
      <MomentDetailView
        address={address}
        tokenId={tokenId}
        initialDetail={detail}
        fallbackMeta={fallbackMeta}
        initialCollectionMeta={initialCollectionMeta}
        kvCreatorAddress={kvCreatorAddress}
        initialTextContent={initialTextContent}
        // Same server signal the <video> preload above uses, so the SSR
        // <video src> is proxy-first for WebKit-only surfaces and matches
        // the preload target instead of emitting a doomed direct fetch.
        ssrWebKit={webKitOnly}
        initialCfile={initialCfile}
      />
    </>
  )
}
