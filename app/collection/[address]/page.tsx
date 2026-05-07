import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { isAddress } from 'viem'
import { notFound } from 'next/navigation'
import { INPROCESS_API, resolveUri, shortAddress } from '@/lib/inprocess'
import { CollectionView } from '@/components/CollectionView'
import { getCollectionMeta as getKvCollectionMeta } from '@/lib/kv'
import { isCollectionHidden } from '@/lib/hiddenCollections'
import { SESSION_COOKIE, verifySession } from '@/lib/session'

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
}

async function fetchCollectionDetail(address: string): Promise<CollectionDetail | null> {
  // GET /api/collection (singular) returns enriched data: default_admin
  // (with username), payout_recipient, timestamps. We use this on the
  // collection detail page; the plural endpoint already powers the
  // lightweight metadata fetch below.
  try {
    const url = new URL(`${INPROCESS_API}/collection`)
    url.searchParams.set('collectionAddress', address)
    url.searchParams.set('chainId', '8453')
    const res = await fetch(url.toString(), {
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
): Promise<{ name?: string; image?: string; description?: string } | null> {
  try {
    const url = new URL(`${INPROCESS_API}/collections`)
    url.searchParams.set('address', address)
    url.searchParams.set('chain_id', '8453')
    const res = await fetch(url.toString(), {
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
  const imageUrl = meta?.image ? resolveUri(meta.image) : undefined
  return {
    title: `${name} — Kismet Art`,
    description: meta?.description || `View collection on Kismet Art`,
    openGraph: imageUrl ? { images: [imageUrl] } : undefined,
  }
}

export default async function CollectionPage({ params }: Props) {
  const { address } = await params

  if (!isAddress(address)) notFound()

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
        <p className="text-sm font-mono text-[#888]">
          this collection has been hidden by the creator
        </p>
      </div>
    )
  }

  // Per-field merge: KV wins for fields it has (fast, deploy-time written),
  // inprocess fills in any gaps. We used to be all-or-nothing — `kvMeta ? {…}
  // : meta` — which meant a partial KV row (e.g. a backfill that only set
  // `name`) would mask the image + description that inprocess actually had,
  // making collections look stripped-down when both data sources were
  // populated. Per-field fallback means the cheaper source still wins
  // when present without sacrificing data we already have elsewhere.
  const displayMeta = {
    name: kvMeta?.name ?? meta?.name,
    image: kvMeta?.image ?? meta?.image,
    description: kvMeta?.description ?? meta?.description,
  }

  const showPayout =
    !!detail?.payout_recipient &&
    !!adminAddressRaw &&
    detail.payout_recipient.toLowerCase() !== adminAddressRaw.toLowerCase()

  return (
    <CollectionView
      address={address}
      collectionName={displayMeta?.name}
      collectionImage={displayMeta?.image}
      collectionDescription={displayMeta?.description}
      isTracked={!!kvMeta}
      defaultAdminUsername={adminUsername}
      defaultAdminAddress={adminAddressRaw}
      payoutRecipient={showPayout ? detail!.payout_recipient! : undefined}
      createdAt={detail?.created_at}
      initialHidden={hidden}
    />
  )
}
