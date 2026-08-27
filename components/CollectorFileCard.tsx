'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAccount, useSignMessage } from 'wagmi'
import { toast } from 'sonner'
import { ArrowDownToLine, Link as LinkIcon } from 'lucide-react'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import { buildDownloadProofMessage } from '@/lib/collectorFileMessage'
import { formatCfileSize, type CfilePublic } from '@/lib/collectorFileTypes'
import { formatPrice } from '@/lib/inprocess'

/**
 * The collector-download card on the artwork page
 * (COLLECTOR_DOWNLOADS_DESIGN.md §8.1). Renders only when a file is attached.
 *
 * States: non-holder → the perk advertisement ("collect to download", or a
 * market pointer when sold out); holder → Download (+"update available" when
 * the current version is newer than the wallet's last download); fresh
 * collect → "your download is ready" keyed on the OPTIMISTIC hasCollected
 * flag (the on-chain balanceOf gate would paint seconds late — the client
 * mirror of the RPC lag the server-side grace marker absorbs).
 *
 * Download flow is ticket-first everywhere: POST /api/collector-file/ticket
 * (session via cookie on web / the JWT fetch patch in a Mini App) → a
 * single-use capability URL → sdk.actions.openUrl in a Mini App (in-app
 * navigations carry no credentials and RN WebViews can't save blobs) or a
 * plain navigation on web. A 401/403 falls back to the raffle-style signed
 * wallet proof, which also covers holders outside the FC-verification union.
 */

interface Props {
  collection: string
  tokenId: string
  initial: CfilePublic | null
  /** True when SSR resolved the descriptor (even to "none") — lets the card
   *  skip its status fetch entirely on the hot anonymous path. False only on
   *  the client-mounted overlay, where the fetch fills in. */
  descriptorKnown: boolean
  /** Optimistic ∨ on-chain "viewer holds this" — the MDV hasCollected flag. */
  hasCollected: boolean
  /** True when the edition is minted out (drives the market pointer state). */
  soldOut: boolean
  /** Set right after this session's collect succeeds — flips the ready copy. */
  justCollected: boolean
  /** This token's live secondary listing (page-cached getActiveListing):
   *  object = listed (price shown), null = none listed, undefined = unknown
   *  (overlay) → generic market pointer. */
  listing?: { price: string; currency: 'eth' | 'usdc' } | null
}

const TOAST_ID = 'cfile-download'

export function CollectorFileCard({ collection, tokenId, initial, descriptorKnown, hasCollected, soldOut, justCollected, listing }: Props) {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { isInMiniApp } = useFarcaster()
  const [file, setFile] = useState<CfilePublic | null>(initial)
  const [downloadedV, setDownloadedV] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const fetchedRef = useRef(false)

  const qs = `collection=${collection}&tokenId=${tokenId}`

  // Adopt parent updates: the manage panel reflects attach/replace/rollback/
  // detach into MomentDetailView's cfile state, which arrives here as a new
  // `initial` — without this sync the card would keep its mount-time copy and
  // an artist's just-attached file would never appear until a reload.
  useEffect(() => {
    setFile(initial)
  }, [initial])

  // At most ONE status read, and only when it buys something (the Redis cost
  // audit: an unconditional mount fetch was 1 HTTP request + 1-2 commands on
  // EVERY artwork view, overwhelmingly for artworks with no file and viewers
  // with no holdings). Needed exactly when:
  //   • the descriptor is unknown (client-mounted overlay — SSR passed
  //     nothing), or
  //   • a file exists and the viewer holds the edition (their last-downloaded
  //     version powers the update badge, §6.4's passive floor).
  // Anonymous browsing of a descriptor-known page costs zero requests.
  useEffect(() => {
    const needDescriptor = !descriptorKnown
    const needViewerState = !!file && hasCollected
    if (fetchedRef.current || (!needDescriptor && !needViewerState)) return
    fetchedRef.current = true
    fetch(`/api/collector-file/status?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { file: CfilePublic | null; downloadedV?: number | null } | null) => {
        if (!data) return
        setFile(data.file)
        if (typeof data.downloadedV === 'number') setDownloadedV(data.downloadedV)
      })
      .catch(() => {})
  }, [qs, descriptorKnown, file, hasCollected])

  /** Mint a ticket — session first, signed wallet proof on 401/403. */
  const mintTicket = useCallback(
    async (share: boolean): Promise<{ url: string; v: number } | null> => {
      const post = (body: object) =>
        fetch(`/api/collector-file/ticket?${qs}${share ? '&share=1' : ''}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      let res = await post({})
      if ((res.status === 401 || res.status === 403) && connectedAddress) {
        // Path 2: prove the CONNECTED wallet holds the edition — covers a
        // holding wallet outside the FC-verification union and sessionless
        // web (one gas-less signature; ERC-1271-aware server-side).
        toast.loading('Sign to verify ownership…', { id: TOAST_ID })
        const issuedAt = Math.floor(Date.now() / 1000)
        const message = buildDownloadProofMessage({
          collection,
          tokenId,
          address: connectedAddress,
          issuedAt,
        })
        let signature: string
        try {
          signature = await signMessageAsync({ message })
        } catch {
          toast.dismiss(TOAST_ID)
          return null
        }
        res = await post({ proof: { address: connectedAddress, issuedAt, signature } })
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error('Download unavailable', {
          id: TOAST_ID,
          description: body?.error ?? 'Try again shortly',
        })
        return null
      }
      const data = (await res.json()) as { url: string; v: number }
      return data
    },
    [collection, tokenId, qs, connectedAddress, signMessageAsync],
  )

  const handleDownload = useCallback(async () => {
    if (busy || !file) return
    setBusy(true)
    try {
      const ticket = await mintTicket(false)
      if (!ticket) return
      toast.dismiss(TOAST_ID)
      if (isInMiniApp) {
        // The host webview can't save files and its navigations carry no
        // credentials — hand the single-use URL to the device browser.
        hapticNotifySuccess()
        const { sdk } = await import('@farcaster/miniapp-sdk')
        await sdk.actions.openUrl(ticket.url)
        toast.success('Opening in your browser…', { id: TOAST_ID })
      } else {
        window.location.href = ticket.url
      }
      setDownloadedV(ticket.v)
    } finally {
      setBusy(false)
    }
  }, [busy, file, mintTicket, isInMiniApp])

  const handleCopyLink = useCallback(async () => {
    if (busy || !file) return
    setBusy(true)
    // Safari/WKWebView (this button is Mini-App-only, i.e. iOS-heavy) revokes
    // the transient user activation during any awaited network hop, so a
    // plain writeText AFTER minting the ticket rejects with NotAllowedError
    // every time. ClipboardItem accepts a PROMISE created synchronously in
    // the activation window — the sanctioned pattern for copy-after-fetch.
    let gateRefused = false
    const ticketPromise = mintTicket(true).then((t) => {
      if (!t) gateRefused = true
      return t
    })
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        const blobPromise = ticketPromise.then((t) => {
          if (!t) throw new Error('ticket unavailable')
          return new Blob([t.url], { type: 'text/plain' })
        })
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobPromise })])
      } else {
        const t = await ticketPromise
        if (!t) return
        await navigator.clipboard.writeText(t.url)
      }
      toast.success('Download link copied', {
        id: TOAST_ID,
        description: 'Valid for 30 minutes, single use — open it on any device.',
      })
    } catch {
      // mintTicket already toasted the gate refusal — don't paper over it.
      if (!gateRefused) toast.error('Could not copy the link', { id: TOAST_ID })
    } finally {
      setBusy(false)
    }
  }, [busy, file, mintTicket])

  if (!file) return null

  const updateAvailable = downloadedV !== null && file.v > downloadedV
  const updated = new Date(file.updatedAt)
  const metaLine = `${file.name} · ${formatCfileSize(file.size)} · v${file.v}`

  return (
    <div className="px-5 pb-3">
      <div className="border border-line px-3 py-2.5 flex items-center gap-3">
        <ArrowDownToLine size={14} className="text-accent flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-mono text-ink truncate">
            collector download · {metaLine}
          </p>
          <p className="text-[10px] font-mono text-muted mt-0.5 truncate">
            {hasCollected ? (
              justCollected ? (
                <span className="text-accent">your download is ready</span>
              ) : updateAvailable ? (
                <span className="text-accent">update available — v{file.v}</span>
              ) : (
                <>updated {updated.toLocaleDateString()} · yours with the edition</>
              )
            ) : soldOut ? (
              listing ? (
                <>
                  sold out — listed at {formatPrice(listing.price, listing.currency)} ·{' '}
                  <Link href="/market" className="underline hover:text-dim">
                    view market
                  </Link>
                </>
              ) : listing === null ? (
                // Known no-listing: say so honestly instead of a dead-end link.
                <>sold out — none listed right now</>
              ) : (
                <>
                  sold out — find it on the{' '}
                  <Link href="/market" className="underline hover:text-dim">
                    market
                  </Link>
                </>
              )
            ) : (
              'collect to download'
            )}
          </p>
        </div>
        {hasCollected && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {isInMiniApp && (
              <button
                onClick={() => void handleCopyLink()}
                disabled={busy}
                title="Copy a single-use download link (open it on your computer)"
                className="p-1.5 border border-line text-muted hover:text-ink transition-colors disabled:opacity-50"
              >
                <LinkIcon size={12} />
              </button>
            )}
            <button
              onClick={() => void handleDownload()}
              disabled={busy}
              className="px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider border border-line accent-grad-hover transition-colors disabled:opacity-50"
            >
              <span className="accent-grad">{busy ? '…' : 'download'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
