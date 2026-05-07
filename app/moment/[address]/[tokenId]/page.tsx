import type { Metadata } from 'next'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API, resolveUri, type MomentDetail } from '@/lib/inprocess'
import { getCollectionMeta as getKvCollectionMeta } from '@/lib/kv'
import { getMomentContent } from '@/lib/momentContent'
import { isMomentHidden } from '@/lib/hiddenMoments'
import { SESSION_COOKIE, verifySession } from '@/lib/session'
import { MomentDetailView } from '@/components/MomentDetailView'

interface Props {
  params: Promise<{ address: string; tokenId: string }>
}

// React.cache dedupes within a single request so generateMetadata and
// MomentPage share results — without it each render makes two upstream
// inprocess fetches plus two Redis reads each for hidden + KV fallback.
const fetchDetail = cache(async (address: string, tokenId: string): Promise<MomentDetail | null> => {
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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address, tokenId } = await params
  if (!isAddress(address) || !isValidTokenId(tokenId)) {
    return { title: 'Moment — Kismet Art' }
  }
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

  const [detail, fallbackMeta] = await Promise.all([
    fetchDetail(address, tokenId),
    getFallbackMeta(address, tokenId),
  ])

  // Prefer the dedicated `creator` field injected by /api/moment from the
  // timeline lookup. Fall back to momentAdmins[0] for backwards-compat
  // (older cached responses, moments minted outside the Kismet flow where
  // momentAdmins[0] happens to be the minter).
  const creator =
    detail?.creator?.address?.toLowerCase() ??
    detail?.momentAdmins?.[0]?.toLowerCase()
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
      initialTextContent={initialTextContent}
    />
  )
}
