import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { isAddress } from '@/lib/address'
import { inprocessUrl, shortAddress } from '@/lib/inprocess'
import { CollectionView } from '@/components/CollectionView'
import { getCollectionMeta as getKvCollectionMeta, getUserCollections } from '@/lib/kv'
import { isCollectionHidden } from '@/lib/hiddenCollections'
import { stripHiddenDeployerIdentity } from '@/lib/hiddenDeployer'
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
      signal: AbortSignal.timeout(8_000),
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
      signal: AbortSignal.timeout(8_000),
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
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { moments?: { token_id?: string }[] }
    return data.moments?.[0]?.token_id ?? null
  } catch {
    return null
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // Wrap in try/catch because error.tsx does NOT catch generateMetadata
  // throws (vercel/next.js#49925). Safe fallback keeps the page rendering
  // even when the KV/inprocess fetch fails.
  try {
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
  // Single share image for every surface: the /opengraph-image route.
  // og:image + twitter:image are auto-wired to it by Next's file
  // convention (we deliberately don't set openGraph.images), and the
  // Farcaster embed points at it explicitly. That route renders the
  // cover full-bleed via Satori — which rasterizes any-size source into
  // a bounded 1200x800 PNG — and falls back to a branded card. Pointing
  // crawlers at the raw cover instead breaks on heavy originals: X drops
  // images >5MB and the next/image optimizer 413's on sources >4MB (see
  // MomentImage proxy mode).
  const canonicalUrl = `${SITE_URL}/collection/${address}`
  const embedImageUrl = `${canonicalUrl}/opengraph-image`
  const fcEmbed = buildFarcasterEmbed({
    imageUrl: embedImageUrl,
    buttonTitle: 'View Collection',
    action: {
      url: canonicalUrl,
    },
  })
  return {
    title: `${name} — Kismet`,
    description,
    openGraph: {
      title: name,
      description,
    },
    twitter: {
      // summary_large_image + the opengraph-image file convention →
      // both og:image and twitter:image resolve to the OG route.
      card: 'summary_large_image',
      title: name,
      description,
    },
    other: fcEmbed,
  }
  } catch (err) {
    console.error('[generateMetadata] collection', err)
    return { title: 'Collection — Kismet' }
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
  const [meta, kvMeta, detailRaw, hidden] = await Promise.all([
    fetchCollectionMeta(address),
    getKvCollectionMeta(address),
    fetchCollectionDetail(address),
    isCollectionHidden(address),
  ])
  // Null a hidden-identity deployer's @handle (creator/default_admin username)
  // before it seeds the header: CollectionView keeps the SSR seed over the
  // gated client resolver, so it must be stripped server-side. Address is
  // preserved, so the isCreator owner check below still resolves.
  const detail = await stripHiddenDeployerIdentity(detailRaw)

  // Resolve the collection's admin EOA. PREFER the KV-stored deployer EOA
  // (written at deploy time = the wallet that actually controls the contract
  // on-chain) over inprocess's `creator.address` — which, for Kismet-relayed
  // collections, is the per-creator SMART WALLET, not the artist's EOA.
  // Using the smart wallet here was the bug behind "no authorize banner even
  // though I'm the creator": it made `isCreator` false for the real creator
  // (their EOA != the smart wallet), gating them out of the authorize banner +
  // creators panel on a collection they own, AND it resolved the WRONG smart
  // wallet downstream (useInprocessSmartWallet of a smart wallet). The moment
  // detail page already prefers the KV minter EOA for exactly this reason.
  // Falls through to the inprocess fields for non-Kismet collections (no KV row).
  const adminAddressRaw =
    kvMeta?.artist ??
    detail?.creator?.address ??
    detail?.default_admin?.address
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
      createdAt={
        detail?.created_at ??
        (kvMeta?.createdAt ? new Date(kvMeta.createdAt).toISOString() : undefined)
      }
      initialHidden={hidden}
      isMobile={isMobile}
    />
  )
}
