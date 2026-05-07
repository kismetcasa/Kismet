import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { INPROCESS_API, resolveUri, type MomentDetail } from '@/lib/inprocess'
import { getCollectionMeta as getKvCollectionMeta } from '@/lib/kv'
import { isMomentHidden } from '@/lib/hiddenMoments'
import { SESSION_COOKIE, verifySession } from '@/lib/session'
import { MomentDetailView } from '@/components/MomentDetailView'

interface Props {
  params: Promise<{ address: string; tokenId: string }>
}

async function fetchDetail(address: string, tokenId: string): Promise<MomentDetail | null> {
  try {
    const url = new URL(`${INPROCESS_API}/moment`)
    url.searchParams.set('collectionAddress', address)
    url.searchParams.set('tokenId', tokenId)
    url.searchParams.set('chainId', '8453')
    // 60s cache so a freshly-minted token isn't stuck rendering null for an
    // hour while inprocess catches up. Same window used by the collection
    // page's moments fetch. Hidden state is read uncached from KV alongside
    // and injected into the returned shape — the /api/moment proxy does the
    // same thing so the client cache and the server-rendered initialDetail
    // stay consistent on first paint and on refresh.
    const [res, hidden] = await Promise.all([
      fetch(url.toString(), { next: { revalidate: 60 } }),
      isMomentHidden(address, tokenId),
    ])
    if (!res.ok) return null
    const data = (await res.json()) as MomentDetail
    return { ...data, hidden }
  } catch {
    return null
  }
}

// For the cover token (tokenId='1') of a kismet-tracked collection we have
// the same metadata in KV that we wrote at deploy time. Synthesize a minimal
// fallback so the image, title, and description render instantly while
// inprocess catches up — but only for tokenId=1 since later tokens have
// their own metadata that isn't in KV.
async function getFallbackMeta(
  address: string,
  tokenId: string,
): Promise<{ name?: string; image?: string; description?: string } | undefined> {
  if (tokenId !== '1') return undefined
  const kv = await getKvCollectionMeta(address)
  if (!kv) return undefined
  return { name: kv.name, image: kv.image, description: kv.description }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address, tokenId } = await params
  const [detail, fallback] = await Promise.all([
    fetchDetail(address, tokenId),
    getFallbackMeta(address, tokenId),
  ])
  const meta = detail?.metadata ?? fallback
  if (!meta) return { title: 'Moment — Kismet Art' }

  const title = `${meta.name ?? `#${tokenId}`} — Kismet Art`
  const description = meta.description ?? 'View this moment on Kismet Art'
  const imageUrl = meta.image ? resolveUri(meta.image) : undefined

  return {
    title,
    description,
    openGraph: {
      title: meta.name ?? `#${tokenId}`,
      description,
      ...(imageUrl ? { images: [{ url: imageUrl }] } : {}),
    },
  }
}

export default async function MomentPage({ params }: Props) {
  const { address, tokenId } = await params

  // Resolve the viewer up front so we can decide whether to hand the full
  // detail (with metadata) to the client or render a server-side placeholder
  // that doesn't leak the moment's metadata via the React-props payload.
  // Mirrors the gating on the collection detail page.
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(SESSION_COOKIE)?.value
  const viewer = sessionToken ? await verifySession(sessionToken) : null

  const [detail, fallbackMeta] = await Promise.all([
    fetchDetail(address, tokenId),
    getFallbackMeta(address, tokenId),
  ])

  const creator = detail?.momentAdmins?.[0]?.toLowerCase()
  const isCreator =
    !!viewer && !!creator && viewer.toLowerCase() === creator

  if (detail?.hidden && !isCreator) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-24 text-center">
        <p className="text-sm font-mono text-[#888]">
          this moment has been hidden by the creator
        </p>
      </div>
    )
  }

  return (
    <MomentDetailView
      address={address}
      tokenId={tokenId}
      initialDetail={detail}
      fallbackMeta={fallbackMeta}
    />
  )
}
