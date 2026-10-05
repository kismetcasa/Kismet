'use client'

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { KISMET_CHANNEL_KEY, resolveCreatorHandle } from '@/lib/collectShare'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import { gachaponCastText, gachaponComposeUrl, gachaponShareEmbeds, type GachaponShare } from '@/lib/gachaponShare'
import { toastError } from '@/lib/toast'

/**
 * Share what came out of a gachapon to Farcaster (lib/gachaponShare). Inside a
 * Mini App, the host's composer; on the web, Farcaster's composer in a new tab.
 * The artist's handle is resolved as the button mounts, so the web tab opens
 * within the tap itself — a tab opened after an await is a popup a browser
 * may block. Until it is known the button waits (at most HANDLE_WAIT_MS, then
 * the cast goes without one): a tap in that moment would otherwise post a
 * cast that leaves the artist out.
 */
const HANDLE_WAIT_MS = 3000

export function GachaponShareButton({ share, className }: { share: GachaponShare; className?: string }) {
  const { isInMiniApp } = useFarcaster()
  /** undefined while it is being looked up; null when there is none to give. */
  const [handle, setHandle] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    setHandle(undefined)
    const giveUp = setTimeout(() => { if (live) setHandle((h) => (h === undefined ? null : h)) }, HANDLE_WAIT_MS)
    resolveCreatorHandle({ collectionAddress: share.collection, tokenId: share.tokenId, momentName: share.title, creatorAddress: share.artist })
      .then((h) => { if (live) setHandle(h) })
      .catch(() => { if (live) setHandle(null) })
    return () => { live = false; clearTimeout(giveUp) }
  }, [share.artist, share.collection, share.tokenId, share.title])

  const onShare = async () => {
    const text = gachaponCastText(share.title, handle ?? null)
    const embeds = gachaponShareEmbeds(share)
    if (!isInMiniApp) {
      window.open(gachaponComposeUrl(text, embeds), '_blank', 'noopener,noreferrer')
      return
    }
    try {
      const { sdk } = await import('@farcaster/miniapp-sdk')
      const composed = await sdk.actions.composeCast({ text, embeds, channelKey: KISMET_CHANNEL_KEY })
      if (composed?.cast) {
        toast.success('Cast shared to /kismet!', { id: 'gachapon-share' })
        hapticNotifySuccess()
      }
    } catch (err) {
      toastError('Share', err, { id: 'gachapon-share' })
    }
  }

  return (
    <button
      type="button"
      onClick={() => void onShare()}
      disabled={handle === undefined}
      aria-busy={handle === undefined}
      className={`${className ?? 'px-4 py-2 text-[10px] font-mono uppercase tracking-widest border border-line text-dim hover:text-ink'} disabled:opacity-40`}
    >
      share to farcaster
    </button>
  )
}
