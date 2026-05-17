import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { EyeOff } from 'lucide-react'
import { isAddress, isValidTokenId } from '@/lib/address'
import { fetchMomentDetail, getKvCreatorAddress } from '@/lib/momentDetail'
import { pickFirstNonOperatorAdmin } from '@/lib/momentAuthz'
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
async function resolveViewer(): Promise<string | null> {
  const cookieStore = await cookies()
  const sessionToken = cookieStore.get(SESSION_COOKIE)?.value
  return sessionToken ? await verifySession(sessionToken) : null
}

export default async function ModalMomentPage({ params }: Props) {
  const { address, tokenId } = await params
  if (!isAddress(address) || !isValidTokenId(tokenId)) notFound()

  // Detail fetch + viewer resolution + KV creator lookup are
  // independent — run them in parallel so the overlay's TTFB isn't
  // gated on session verify or the extra Redis read.
  const [detail, viewer, kvCreatorAddress] = await Promise.all([
    fetchMomentDetail(address, tokenId),
    resolveViewer(),
    getKvCreatorAddress(address, tokenId),
  ])

  // Hidden-moment privacy gate. Same EOA-first priority as the
  // canonical page + MomentDetailView, so the three never disagree.
  // KV wins because inprocess reports the platform smart wallet as
  // creator.address for Kismet-minted moments — looking up the
  // session's EOA against that would never match and the creator
  // would be locked out of their own hidden moment.
  const creator =
    kvCreatorAddress?.toLowerCase() ??
    detail?.creator?.address?.toLowerCase() ??
    pickFirstNonOperatorAdmin(detail?.momentAdmins)?.toLowerCase()
  const isCreator =
    !!viewer && !!creator && viewer.toLowerCase() === creator

  if (detail?.hidden && !isCreator) {
    return (
      <ModalOverlay>
        <div className="max-w-4xl mx-auto flex flex-col items-center justify-center gap-3 py-24 px-6">
          <EyeOff size={20} className="text-[#444]" />
          <p className="text-sm font-mono text-dim">
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
        kvCreatorAddress={kvCreatorAddress}
        inOverlay
      />
    </ModalOverlay>
  )
}
