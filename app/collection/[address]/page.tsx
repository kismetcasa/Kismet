import type { Metadata } from 'next'
import { isAddress } from 'viem'
import { notFound } from 'next/navigation'
import { INPROCESS_API, resolveUri, shortAddress, fetchCollectionMoments, type MomentAdmin } from '@/lib/inprocess'
import { CollectionView } from '@/components/CollectionView'
import { getCollectionMeta as getKvCollectionMeta } from '@/lib/kv'

interface Props {
  params: Promise<{ address: string }>
}

interface CollectionDetail {
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
  const meta = await fetchCollectionMeta(address)
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

  const [moments, meta, kvMeta, detail] = await Promise.all([
    fetchCollectionMoments(address),
    fetchCollectionMeta(address),
    getKvCollectionMeta(address),
    fetchCollectionDetail(address),
  ])

  // Collect unique admins from all moments (excluding the creator)
  const adminMap = new Map<string, MomentAdmin>()
  for (const m of moments) {
    for (const admin of m.admins ?? []) {
      if (admin.address.toLowerCase() !== m.creator.address.toLowerCase()) {
        adminMap.set(admin.address.toLowerCase(), admin)
      }
    }
  }
  const admins = Array.from(adminMap.values())

  // If we know about this collection locally but the indexer has nothing yet,
  // surface that explicitly instead of an empty grid that looks like a bug.
  const indexing = !!kvMeta && moments.length === 0

  // Show payout chip only when it differs from the deploying admin —
  // otherwise it's redundant noise. The vast majority of creators leave
  // payouts to themselves; the few who route through a splits contract
  // benefit from the transparency.
  const showPayout =
    !!detail?.payout_recipient &&
    !!detail?.default_admin?.address &&
    detail.payout_recipient.toLowerCase() !== detail.default_admin.address.toLowerCase()

  return (
    <CollectionView
      address={address}
      moments={moments}
      collectionName={meta?.name}
      collectionImage={meta?.image}
      collectionDescription={meta?.description}
      admins={admins}
      indexing={indexing}
      defaultAdminUsername={detail?.default_admin?.username}
      payoutRecipient={showPayout ? detail!.payout_recipient! : undefined}
      createdAt={detail?.created_at}
    />
  )
}
