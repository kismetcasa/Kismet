'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/lib/toast'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { shortAddress } from '@/lib/inprocess'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import { KISMET_CHANNEL_KEY } from '@/lib/collectShare'
import { isPatronCollection } from '@/lib/patronCollection'
import type { SplitRecipient } from '@/lib/splits'
import { fetchSplitRecipients } from '@/lib/splitsClient'
import {
  artworkShareUrl,
  fcFollowUrl,
  fcShareUrl,
  KISMET_FC_HANDLE,
  KISMET_X_HANDLE,
  raffleCastText,
  raffleShareArtist,
  raffleTweetText,
  xFollowUrl,
  xShareUrl,
  type RaffleShareArtist,
} from '@/lib/raffleShare'

/**
 * Post-entry celebration + follow/share prompt, opened by RaffleButton the
 * moment an entry is recorded: "Good luck! Thanks for supporting us and
 * <artist>." with follow buttons for Kismet's Farcaster + X accounts and
 * share composers for both.
 *
 * Artist naming is two-tier (lib/raffleShare): a Patron artwork credits the
 * artist its token's stored split pays (Turro on token 1, Tornado Rodriguez on
 * token 3, …), linked to that artist's Kismet profile, with curated handles
 * where the profile has none; every other raffle resolves the artist from the
 * creator's profile. The Farcaster share uses the native
 * composeCast inside a Mini App (posts to /kismet with the artwork embedded —
 * whose embed button reads "collect to enter" while entries are open) and the
 * farcaster.xyz web composer otherwise; X always goes through the tweet
 * intent URL.
 */
export function RaffleEntryModal({
  collectionAddress,
  tokenId,
  creatorAddress,
  onClose,
}: {
  collectionAddress: string
  tokenId: string
  creatorAddress?: string | null
  onClose: () => void
}) {
  useEscapeKey(onClose)
  useBodyScrollLock()
  const { isInMiniApp } = useFarcaster()

  // First paint: the creator for an ordinary raffle; for a Patron token, its
  // curated override (if any) until the split arrives.
  const [artist, setArtist] = useState<RaffleShareArtist>(() =>
    raffleShareArtist({ collectionAddress, tokenId, creatorAddress }),
  )

  // Patron: read the token's stored split first. The artist it pays is the
  // credit, not the creator record (the treasury on some Patron tokens). Then
  // resolve that artist's FC handle / display name from their profile, which
  // for an ordinary raffle is the creator's. shortAddress placeholders don't
  // count as a name, same rule as lib/collectShare.
  useEffect(() => {
    let cancelled = false
    const patron = isPatronCollection(collectionAddress)
    const readSplit: Promise<SplitRecipient[] | null> = patron
      ? fetchSplitRecipients(collectionAddress, tokenId)
      : Promise.resolve(null)
    readSplit
      .then(async (recipients) => {
        if (cancelled) return
        const credited = raffleShareArtist({
          collectionAddress,
          tokenId,
          creatorAddress,
          splitRecipients: recipients,
        })
        if (patron) setArtist(credited)
        const who = credited.profileAddress
        if (!who) return
        const profile = await fetchCreatorProfile(who)
        if (cancelled) return
        const placeholder = shortAddress(who)
        setArtist(
          raffleShareArtist({
            collectionAddress,
            tokenId,
            creatorAddress,
            splitRecipients: recipients,
            resolvedFcUsername: profile.fcUsername ?? null,
            resolvedName: profile.name && profile.name !== placeholder ? profile.name : null,
          }),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [collectionAddress, tokenId, creatorAddress])

  const shareUrl = artworkShareUrl(collectionAddress, tokenId)

  async function shareOnFarcaster() {
    const text = raffleCastText(artist)
    if (isInMiniApp) {
      try {
        const { sdk } = await import('@farcaster/miniapp-sdk')
        const composed = await sdk.actions.composeCast({
          text,
          embeds: [shareUrl],
          channelKey: KISMET_CHANNEL_KEY,
        })
        if (composed?.cast) {
          toast.success('Cast shared to /kismet!', { id: 'raffle-share' })
          hapticNotifySuccess()
        }
      } catch (err) {
        toastError('Share', err, { id: 'raffle-share' })
      }
      return
    }
    window.open(fcShareUrl(text, shareUrl), '_blank', 'noopener,noreferrer')
  }

  const btn =
    'flex-1 min-w-0 border border-line px-3 py-2.5 text-[10px] font-mono uppercase tracking-widest text-dim hover:text-ink hover:border-muted transition-colors text-center'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Raffle entered"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="relative w-full max-w-sm bg-[#0d0d0d] border border-line">
        <button
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
          className="absolute top-3 right-3 p-1.5 text-muted hover:text-ink transition-colors"
        >
          <X size={16} />
        </button>

        <div className="px-6 pt-8 pb-6 flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-mono text-accent">you&rsquo;re in the raffle ✓</p>
            <p className="text-sm font-mono text-ink leading-relaxed">
              Good luck! Thanks for supporting{' '}
              {artist.displayName && artist.profileAddress ? (
                <>
                  us and{' '}
                  <Link
                    href={`/profile/${artist.profileAddress}`}
                    className="text-accent hover:underline"
                    onClick={onClose}
                  >
                    {artist.displayName}
                  </Link>
                  .
                </>
              ) : (
                'Kismet.'
              )}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted">
              farcaster
            </span>
            <div className="flex gap-2">
              <a href={fcFollowUrl} target="_blank" rel="noopener noreferrer" className={btn}>
                follow @{KISMET_FC_HANDLE}
              </a>
              <button onClick={() => void shareOnFarcaster()} className={btn}>
                share
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted">x</span>
            <div className="flex gap-2">
              <a href={xFollowUrl} target="_blank" rel="noopener noreferrer" className={btn}>
                follow @{KISMET_X_HANDLE}
              </a>
              <a
                href={xShareUrl(raffleTweetText(artist), shareUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className={btn}
              >
                share
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
