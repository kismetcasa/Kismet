import type { Metadata } from 'next'
import { isAddress } from 'viem'
import { notFound } from 'next/navigation'
import { INPROCESS_API, resolveUri, shortAddress, type Moment, type MomentAdmin } from '@/lib/inprocess'
import { CollectionView } from '@/components/CollectionView'
import { getCollectionMeta as getKvCollectionMeta } from '@/lib/kv'

interface Props {
  params: Promise<{ address: string }>
}

async function fetchCollectionMoments(address: string): Promise<Moment[]> {
  try {
    const url = new URL(`${INPROCESS_API}/timeline`)
    url.searchParams.set('collection', address)
    url.searchParams.set('limit', '50')
    url.searchParams.set('chain_id', '8453')
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.moments) ? data.moments : []
  } catch {
    return []
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

  const [moments, meta, kvMeta] = await Promise.all([
    fetchCollectionMoments(address),
    fetchCollectionMeta(address),
    getKvCollectionMeta(address),
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

  return (
    <CollectionView
      address={address}
      moments={moments}
      collectionName={meta?.name}
      collectionImage={meta?.image}
      collectionDescription={meta?.description}
      admins={admins}
      indexing={indexing}
    />
  )
}
