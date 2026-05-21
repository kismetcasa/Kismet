import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { isAddress } from '@/lib/address'
import { inprocessUrl, shortAddress } from '@/lib/inprocess'
import { shareImageUrl } from '@/lib/media/shareImage'
import { CollectionView } from '@/components/CollectionView'
import { getCollectionMeta as getKvCollectionMeta, getUserCollections } from '@/lib/kv'
import { isCollectionHidden } from '@/lib/hiddenCollections'
import { SESSION_COOKIE, verifySession } from '@/lib/session'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { SITE_URL } from '@/lib/siteUrl'
import { isMobileUA } from '@/lib/serverDevice'

interface Props {
  params: Promise<{ address: string }>
}

interface CollectionDetail {
  // Inprocess's current /api/collection shape returns `creator` (name + the
  // deployer's wallet). Older indexer rows / cached responses may still
  // surface `default_admin` instead, so we accept both and prefer creator.
  creator?: { address: string; username?: string | null }
  default_admin?: { address: string; username?: string }
  payout_recipient?: string
  created_at?: string
  // The same call also returns the parsed contract metadata. We thread
  // these through to displayMeta below as a third fallback after KV and
  // the plural-endpoint fetch — the singular endpoint is the one we know
  // empirically returns image + description for newly indexed collections.
  metadata?: {
    name?: string
    image?: string
    description?: string
    kismet_thumbhash?: string
  }
}

async function fetchCollectionDetail(address: string): Promise<CollectionDetail | null> {
  // GET /api/collection (singular) returns enriched data: default_admin
  // (with username), payout_recipient, timestamps. We use this on the
  // collection detail page; the plural endpoint already powers the
  // lightweight metadata fetch below.
  try {
    const url = inprocessUrl('/collection', { collectionAddress: address, chainId: '8453' })
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 120 },
    })
    if (!res.ok) return null
    const text = await res.text()
    return text ? (JSON.parse(text) as CollectionDetail) : null
  } catch {
    return null
  }
}

async function fetchCollectionMeta(
  address: string
): Promise<{ name?: string; image?: string; description?: string; kismet_thumbhash?: string } | null> {
  try {
    const url = inprocessUrl('/collections', { address, chain_id: '8453' })
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 120 },
    })
    if (!res.ok) return loadKvFallback(address)
    const data = await res.json()
    const col = Array.isArray(data.collections)
      ? data.collections.find(
          (c: { contractAddress?: string }) =>
            c.contractAddress?.toLowerCase() === address.toLowerCase()
        )
      : null
    return col?.metadata ?? (await loadKvFallback(address))
  } catch {
    return loadKvFallback(address)
  }
}

async function loadKvFallback(
  address: string
): Promise<{ name?: string; image?: string; description?: string } | null> {
  const kv = await getKvCollectionMeta(address)
  if (!kv) return null
  return { name: kv.name, image: kv.image, description: kv.description }
}

// Resolve a single moment in a non-curated contract so we can redirect to
// it. limit=1 keeps the upstream fetch cheap. Returns null on indexer lag
// or empty contracts — caller falls through to the existing render rather
// than 404, so the user never hits a dead URL on a brand-new wrapper.
async function findFirstMomentTokenId(address: string): Promise<string | null> {
  try {
    const url = inprocessUrl('/timeline', { collection: address, limit: 1, chain_id: '8453' })
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    if (!res.ok) return null
    const data = (await res.json()) as { moments?: { token_id?: string }[] }
    return data.moments?.[0]?.token_id ?? null
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params
  // KV is written at deploy time and is always fast; only fall back to
  // inprocess (fetchCollectionMeta) when KV has nothing.
  const [kvMeta, inprocessMeta] = await Promise.all([
    getKvCollectionMeta(address),
    fetchCollectionMeta(address),
  ])
  const meta = kvMeta ?? inprocessMeta
  const name = meta?.name || `Collection ${shortAddress(address)}`
  const description = meta?.description || 'View collection on Kismet'
  // Text-mint auto-deploy stores an SVG data URI as the cover (works
  // in-app, not in share crawlers) — shareImageUrl drops those. ar:// /
  // ipfs:// routes through /api/img for the multi-gateway-raced edge
  // cache; https:// passes through.
  const imageUrl = shareImageUrl(meta?.image)
  // Farcaster Mini App embed — see moment/[address]/[tokenId]/page.tsx
  // for the rationale. action.url points at this collection's canonical
  // page so the button drops the user directly here inside the Mini
  // App rather than the homepage.
  const canonicalUrl = `${SITE_URL}/collection/${address}`
  const embedImageUrl = imageUrl ?? `${canonicalUrl}/opengraph-image`
  const fcEmbed = buildFarcasterEmbed({
    imageUrl: embedImageUrl,
    buttonTitle: 'View Collection',
    action: {
      url: canonicalUrl,
      name: `${name} — Kismet Art`,
    },
  })
  return {
    title: `${name} — Kismet`,
    description,
    openGraph: {
      title: name,
      description,
      ...(imageUrl ? { images: [{ url: imageUrl }] } : {}),
    },
    twitter: {
      // Always summary_large_image — opengraph-image.tsx provides a
      // branded PNG fallback for collections without a usable cover
      // image (text-mint auto-deploys etc.), and Twitter falls back to
      // og:image when twitter:image isn't set.
      card: 'summary_large_image',
      title: name,
      description,
      ...(imageUrl ? { images: [imageUrl] } : {}),
    },
    other: fcEmbed,
  }
}

export default async function CollectionPage({ params }: Props) {
  const { address } = await params

  if (!isAddress(address)) notFound()

  // Non-curated contracts shouldn't render as a curated-collection page.
  // The two cases this catches:
  //   1. Auto-deploy wrappers from MintForm — single-token contracts the
  //      protocol creates per first-mint when no collection is picked.
  //      Tracked for moment fan-out but excluded from every collection-
  //      shaped surface (see lib/kv.addTrackedCollection).
  //   2. Untracked ERC1155 contracts someone pastes the URL of.
  // Either way, the canonical surface is the moment inside. Redirect to
  // it when we can resolve one; if the indexer hasn't picked it up yet
  // (brand-new wrapper), fall through to the existing render rather than
  // 404 so the URL never goes dead.
  //
  // The next/navigation `redirect` throws — must not be wrapped in a
  // try/catch (it isn't here; the helper has its own scoped catch that
  // can't see this call).
  const lowerAddr = address.toLowerCase()
  const userCreated = await getUserCollections()
  const isCurated = userCreated.some((a) => a.toLowerCase() === lowerAddr)
  if (!isCurated) {
    const tokenId = await findFirstMomentTokenId(address)
    if (tokenId) redirect(`/moment/${address}/${tokenId}`)
  }

  // Resolve the viewer so we can decide whether a hidden collection should
  // render as a placeholder. Server-component cookie reads don't have a
  // NextRequest; touch the cookie store directly. cookies() opts this
  // route into dynamic rendering, which is what we want for the per-user
  // hidden-state branch.
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(SESSION_COOKIE)?.value
  const viewer = sessionToken ? await verifySession(sessionToken) : null

  // Moments are fetched client-side in CollectionView so the header renders
  // immediately from the fast KV + inprocess-detail fetches below.
  const [meta, kvMeta, detail, hidden] = await Promise.all([
    fetchCollectionMeta(address),
    getKvCollectionMeta(address),
    fetchCollectionDetail(address),
    isCollectionHidden(address),
  ])

  // Prefer the inprocess `creator` field (current shape); fall back to
  // `default_admin` for older cached responses; finally fall back to the
  // KV-stored artist (set at deploy time) so the chip never goes missing
  // for collections we deployed even when inprocess hasn't surfaced an
  // admin yet.
  const adminAddressRaw =
    detail?.creator?.address ??
    detail?.default_admin?.address ??
    kvMeta?.artist
  const adminUsername =
    detail?.creator?.username ?? detail?.default_admin?.username ?? undefined
  const defaultAdminAddress = adminAddressRaw?.toLowerCase()
  const viewerLower = viewer?.toLowerCase() ?? null
  const isCreator =
    !!viewerLower &&
    !!defaultAdminAddress &&
    viewerLower === defaultAdminAddress

  // Non-creator visitors of a hidden collection see a placeholder. Creator
  // sees normally with a hidden indicator + unhide affordance.
  if (hidden && !isCreator) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-24 text-center">
        <p className="text-sm font-mono text-dim">
          this collection has been hidden by the creator
        </p>
      </div>
    )
  }

  // Per-field merge across three sources, in priority order:
  //   1. KV (fast, written at deploy time — wins when present)
  //   2. Plural-endpoint meta (legacy fetchCollectionMeta path)
  //   3. Singular-endpoint metadata (the one we know empirically carries
  //      image + description for currently-indexed collections)
  // Used to be all-or-nothing on KV, which meant a partial KV row could
  // shadow inprocess data we already had — and we weren't even reading
  // the singular endpoint's metadata, so image + description were lost
  // for collections where the plural-endpoint fetch didn't return a hit.
  const displayMeta = {
    name: kvMeta?.name ?? meta?.name ?? detail?.metadata?.name,
    image: kvMeta?.image ?? meta?.image ?? detail?.metadata?.image,
    description:
      kvMeta?.description ?? meta?.description ?? detail?.metadata?.description,
    kismet_thumbhash:
      kvMeta?.kismet_thumbhash ?? meta?.kismet_thumbhash ?? detail?.metadata?.kismet_thumbhash,
  }

  const showPayout =
    !!detail?.payout_recipient &&
    !!adminAddressRaw &&
    detail.payout_recipient.toLowerCase() !== adminAddressRaw.toLowerCase()

  // UA → lazy-mount toggle: server bakes the decision into the prop so
  // CollectionView (a client component) hydrates with the right value.
  // Mobile gets LazyMount on the heavy moments grid; desktop unchanged.
  const isMobile = await isMobileUA()

  return (
    <CollectionView
      address={address}
      collectionName={displayMeta?.name}
      collectionImage={displayMeta?.image}
      collectionThumbhash={displayMeta?.kismet_thumbhash}
      collectionDescription={displayMeta?.description}
      isTracked={!!kvMeta}
      defaultAdminUsername={adminUsername}
      defaultAdminAddress={adminAddressRaw}
      payoutRecipient={showPayout ? detail!.payout_recipient! : undefined}
      createdAt={detail?.created_at}
      initialHidden={hidden}
      isMobile={isMobile}
    />
  )
}
