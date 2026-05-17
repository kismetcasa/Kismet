import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { EyeOff } from 'lucide-react'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API, type MomentDetail } from '@/lib/inprocess'
import { isMomentHidden } from '@/lib/hiddenMoments'
import { SESSION_COOKIE, verifySession } from '@/lib/session'
import { MomentDetailView } from '@/components/MomentDetailView'
import { ModalOverlay } from '@/components/ModalOverlay'

interface Props {
  params: Promise<{ address: string; tokenId: string }>
}

/**
 * Intercepting route for /moment/[address]/[tokenId]. Fires when the
 * user navigates to a moment URL from inside the app (e.g. clicking a
 * card on the feed). Renders the detail view as an overlay over the
 * still-mounted feed — feed scroll position is preserved, the card's
 * video keeps playing (or, with SharedVideoProvider, the same video
 * element CSS-transitions from the card to the overlay's slot).
 *
 * Direct URL loads (refresh, share link) bypass interception and hit
 * the canonical /moment/[address]/[tokenId]/page.tsx instead, which
 * renders the full-page version with the same data.
 *
 * Kept intentionally lean — only the SSR work strictly necessary for
 * correctness (validation, hidden-moment gating). MomentDetailView
 * does its own client-side fetches for the optional SSR-hydrated bits
 * (collection chip, creator profile, text content). The overlay opens
 * over an already-loaded feed, so the user perceives "modal pops up"
 * not "page loads."
 */
async function fetchDetail(
  address: string,
  tokenId: string,
): Promise<MomentDetail | null> {
  try {
    const url = new URL(`${INPROCESS_API}/moment`)
    url.searchParams.set('collectionAddress', address)
    url.searchParams.set('tokenId', tokenId)
    url.searchParams.set('chainId', '8453')
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

export default async function ModalMomentPage({ params }: Props) {
  const { address, tokenId } = await params
  if (!isAddress(address) || !isValidTokenId(tokenId)) notFound()

  // Hidden-moment privacy gate — match the canonical page's logic so
  // hidden moments don't leak via the overlay path. Non-creators of
  // hidden moments see the placeholder; creators see the moment with
  // a "hidden" badge (MomentDetailView handles the badge internally).
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(SESSION_COOKIE)?.value
  const viewer = sessionToken ? await verifySession(sessionToken) : null

  const detail = await fetchDetail(address, tokenId)

  const creator =
    detail?.creator?.address?.toLowerCase() ??
    detail?.momentAdmins?.[0]?.toLowerCase()
  const isCreator =
    !!viewer && !!creator && viewer.toLowerCase() === creator

  if (detail?.hidden && !isCreator) {
    return (
      <ModalOverlay>
        <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-3 py-24 px-6">
          <EyeOff size={20} className="text-[#444]" />
          <p className="text-sm font-mono text-[#888]">
            this moment has been hidden by the creator
          </p>
        </div>
      </ModalOverlay>
    )
  }

  return (
    <ModalOverlay>
      <MomentDetailView
        address={address}
        tokenId={tokenId}
        initialDetail={detail}
        inOverlay
      />
    </ModalOverlay>
  )
}
