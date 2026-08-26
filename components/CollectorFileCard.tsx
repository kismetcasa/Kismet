'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useAccount, useSignMessage } from 'wagmi'
import { toast } from 'sonner'
import { ArrowDownToLine, Link as LinkIcon } from 'lucide-react'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import { buildDownloadProofMessage } from '@/lib/collectorFileMessage'
import type { CfilePublic } from '@/lib/collectorFileTypes'

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
  /** Optimistic ∨ on-chain "viewer holds this" — the MDV hasCollected flag. */
  hasCollected: boolean
  /** True when the edition is minted out (drives the market pointer state). */
  soldOut: boolean
  /** Set right after this session's collect succeeds — flips the ready copy. */
  justCollected: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const TOAST_ID = 'cfile-download'

export function CollectorFileCard({ collection, tokenId, initial, hasCollected, soldOut, justCollected }: Props) {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const { isInMiniApp } = useFarcaster()
  const [file, setFile] = useState<CfilePublic | null>(initial)
  const [downloadedV, setDownloadedV] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const fetchedRef = useRef(false)

  const qs = `collection=${collection}&tokenId=${tokenId}`

  // One status read per mount: refreshes the descriptor (SSR data can be a
  // version behind after an edit) and, for a signed-in viewer, their last
  // downloaded version — which powers the update badge (§6.4's passive floor).
  useEffect(() => {
    if (fetchedRef.current) return
    fetchedRef.current = true
    fetch(`/api/collector-file/status?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { file: CfilePublic | null; downloadedV?: number | null } | null) => {
        if (!data) return
        setFile(data.file)
        if (typeof data.downloadedV === 'number') setDownloadedV(data.downloadedV)
      })
      .catch(() => {})
  }, [qs])

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
    try {
      const ticket = await mintTicket(true)
      if (!ticket) return
      await navigator.clipboard.writeText(ticket.url)
      toast.success('Download link copied', {
        id: TOAST_ID,
        description: 'Valid for 30 minutes, single use — open it on any device.',
      })
    } catch {
      toast.error('Could not copy the link', { id: TOAST_ID })
    } finally {
      setBusy(false)
    }
  }, [busy, file, mintTicket])

  if (!file) return null

  const updateAvailable = downloadedV !== null && file.v > downloadedV
  const updated = new Date(file.updatedAt)
  const metaLine = `${file.name} · ${formatSize(file.size)} · v${file.v}`

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
              <>
                sold out — find it on the{' '}
                <Link href="/market" className="underline hover:text-dim">
                  market
                </Link>
              </>
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
