'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { BookOpen, X } from 'lucide-react'
import { MomentImage } from './MomentImage'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { modelFetchUrls } from '@/lib/media/gateway'
import { gatewayUrls } from '@/lib/arweave/gateways'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import {
  MediaFetchError,
  PDF_EXPECTATION,
  fetchMediaBlob,
  isAbortError,
  modelLoadReadout,
  type ModelFetchProgress,
} from '@/lib/media/modelFetch'
import { ZINE_COPY, formatZinePages } from '@/lib/media/zineMedia'
import { loadPdfJs, openPdf, type OpenedPdf } from '@/lib/pdfjs'
import { readRotation, readStartPage, rememberPage, rememberRotation, useReaderHistory } from '@/lib/zineHistory'

/**
 * The artwork detail view's entry to a public zine — the tap-to-load twin of
 * components/MomentModel, minus WebGL (ZINE_READER_DESIGN.md §5.2).
 *
 * TAP TO LOAD, deliberately: a zine is downloaded whole (v1 does not stream
 * pages), parsed in a worker that then holds the file, and rendered through
 * canvases — all of it memory a viewer who merely scrolled past the artwork
 * should never pay, least of all in the iOS Mini App webview. The cover is a
 * real JPEG on the same gateway-walking path as any still, so the artwork
 * looks right immediately; the ~150 KB pdf.js chunk, the reader chunk and
 * the bytes are fetched together on the tap, with a cancel, a stall watchdog,
 * a byte readout and a gateway walk (lib/media/modelFetch — the reasons that
 * download is ours are recorded there).
 *
 * The reader owns the pages; this component owns the URL (`?page=N`), the
 * resume position and the history entry (lib/zineHistory): a shared link
 * opens on its page, a return visit picks up where the reader left off, and
 * the back gesture closes the reader instead of leaving the artwork.
 */

const ZineReader = dynamic(() => import('./ZineReader').then((m) => m.ZineReader), { ssr: false })

type Phase = 'idle' | 'loading' | 'reading' | 'error'

interface Props {
  /** Raw PDF URI (ar:// / ipfs:// / https://). */
  src: string
  /** Raw cover URI. Absent on a zine minted without one. */
  poster?: string
  thumbhash?: string
  alt: string
  /** The artwork's title, for the reader's label and page alt text. */
  title: string
  /** Page count from the metadata hint, for the affordance. */
  pages?: number
  /** Resume key — the artwork's `collection:tokenId`. */
  storageKey: string
  /** Fires when neither the zine nor its cover can be shown. */
  onAllError?: () => void
}

export function MomentZine({ src, poster, thumbhash, alt, title, pages, storageKey, onAllError }: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [posterFailed, setPosterFailed] = useState(false)
  const [download, setDownload] = useState<ModelFetchProgress | null>(null)
  const [parsing, setParsing] = useState(false)
  const [opened, setOpened] = useState<OpenedPdf | null>(null)
  const [startPage, setStartPage] = useState<number | undefined>(undefined)
  const [startRotation, setStartRotation] = useState(0)
  // The affordance is unmounted while the reader is up, so the focus trap
  // finds no opener to return to; the button that comes back on close takes
  // focus itself, keyboard and screen-reader users land where they left.
  const readButtonRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const openedRef = useRef<OpenedPdf | null>(null)
  const sessionRef = useRef(0)
  const lastProgressAtRef = useRef(0)
  const { isInMiniApp } = useFarcaster()
  const urls = useMemo(() => modelFetchUrls(src), [src])
  // "Download PDF" goes to the gateway, never through our proxy (which
  // serves PDFs as attachments and would otherwise carry the egress).
  const downloadUrl = useMemo(() => gatewayUrls(src)[0], [src])
  const onAllErrorRef = useRef(onAllError)
  onAllErrorRef.current = onAllError

  const releaseDoc = useCallback(() => {
    const o = openedRef.current
    openedRef.current = null
    setOpened(null)
    if (o) void o.close().catch(() => {})
  }, [])

  const cancel = useCallback(() => {
    sessionRef.current++
    abortRef.current?.abort()
    abortRef.current = null
    releaseDoc()
  }, [releaseDoc])

  // The actual exit. Reached through the history hook below (the back
  // gesture, or the UI's close popping our entry), never called directly
  // by a control.
  const exitNow = useCallback(() => {
    cancel()
    restoreFocusRef.current = true
    setPhase('idle')
  }, [cancel])
  useEffect(() => {
    if (phase !== 'idle' || !restoreFocusRef.current) return
    restoreFocusRef.current = false
    readButtonRef.current?.focus({ preventScroll: true })
  }, [phase])
  // The entry covers the error state too: a failed open that popped its
  // entry left a dead one behind, and each retry added another.
  const closeViaHistory = useReaderHistory(phase !== 'idle', exitNow)

  const activate = useCallback(async () => {
    cancel()
    const session = sessionRef.current
    const controller = new AbortController()
    abortRef.current = controller
    setPhase('loading')
    setMessage(null)
    setDownload(null)
    setParsing(false)
    try {
      // The engine, the reader chunk and the bytes are independent; fetch
      // all three at once so neither chunk waits behind a multi-MB download.
      const [, , blob] = await Promise.all([
        loadPdfJs(),
        import('./ZineReader'),
        fetchMediaBlob(urls, {
          expect: PDF_EXPECTATION,
          signal: controller.signal,
          onProgress: (p) => {
            if (sessionRef.current !== session) return
            const now = Date.now()
            const final = p.total !== null && p.loaded >= p.total
            if (!final && now - lastProgressAtRef.current < 100) return
            lastProgressAtRef.current = now
            setDownload(p)
          },
        }),
      ])
      if (sessionRef.current !== session) return
      setParsing(true)
      const o = await openPdf(await blob.arrayBuffer())
      if (sessionRef.current !== session) {
        void o.close().catch(() => {})
        return
      }
      openedRef.current = o
      setStartPage(readStartPage(storageKey))
      setStartRotation(readRotation(storageKey))
      setOpened(o)
      setPhase('reading')
    } catch (err) {
      controller.abort()
      if (sessionRef.current !== session || isAbortError(err)) return
      setPhase('error')
      setMessage(err instanceof MediaFetchError ? err.message : ZINE_COPY.readerUnavailable)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [urls, cancel, storageKey])

  // Unmount (navigation) stops a download in flight and frees the document.
  useEffect(() => () => cancel(), [cancel])

  const onPageChange = useCallback((page: number) => rememberPage(storageKey, page), [storageKey])
  const onRotationChange = useCallback((r: number) => rememberRotation(storageKey, r), [storageKey])

  // A Mini App opens URLs through its host; target=_blank goes nowhere in
  // the RN webview. Same route the collector-file download takes.
  const onDownload = useMemo(
    () =>
      isInMiniApp
        ? () => {
            void import('@farcaster/miniapp-sdk')
              .then(({ sdk }) => sdk.actions.openUrl(downloadUrl))
              .catch(() => {})
          }
        : undefined,
    [isInMiniApp, downloadUrl],
  )

  const hasStill = !!poster && !posterFailed
  useEffect(() => {
    if (phase === 'error' && !hasStill) onAllErrorRef.current?.()
  }, [phase, hasStill])

  const blur = thumbhashToBlurDataURL(thumbhash)
  const still = hasStill ? (
    <MomentImage
      src={poster!}
      alt={alt}
      fill
      className="object-contain"
      sizes="(max-width: 768px) 100vw, 50vw"
      priority
      thumbhash={thumbhash}
      onAllError={() => setPosterFailed(true)}
    />
  ) : (
    <div
      className="absolute inset-0 bg-cover bg-center"
      style={blur ? { backgroundImage: `url(${blur})` } : undefined}
    />
  )

  const readLabel = pages ? `read · ${formatZinePages(pages)}` : 'read'

  return (
    <div className="absolute inset-0">
      {still}
      {phase === 'reading' && opened ? (
        <ZineReader
          doc={opened.doc}
          title={title}
          startPage={startPage}
          onClose={closeViaHistory}
          onPageChange={onPageChange}
          downloadUrl={onDownload ? undefined : downloadUrl}
          onDownload={onDownload}
          haptics={isInMiniApp}
          startRotation={startRotation}
          onRotationChange={onRotationChange}
        />
      ) : null}
      {phase === 'loading' ? (
        <>
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 px-2.5 py-1 bg-[#0d0d0d]/85 text-[11px] font-mono text-dim pointer-events-none whitespace-nowrap">
            opening zine… {modelLoadReadout(download, parsing)}
          </p>
          <button
            type="button"
            onClick={closeViaHistory}
            aria-label="Cancel opening the zine"
            className="absolute top-2 right-2 z-10 w-8 h-8 bg-[#0d0d0d]/80 border border-line flex items-center justify-center text-dim hover:text-ink transition-colors"
          >
            <X size={14} />
          </button>
        </>
      ) : phase !== 'reading' ? (
        <>
          {/* The affordance. Sits over the cover so it reads as "this artwork
              has pages", not as a stray control. */}
          <div className="absolute inset-0 flex items-end justify-center p-4 pointer-events-none">
            <button
              ref={readButtonRef}
              type="button"
              onClick={activate}
              className="pointer-events-auto flex items-center gap-2 px-4 py-2 bg-[#0d0d0d]/85 border border-line text-xs font-mono uppercase tracking-wider text-dim hover:text-ink hover:border-muted transition-colors"
            >
              <BookOpen size={13} strokeWidth={1.5} />
              {phase === 'error' ? 'retry' : readLabel}
            </button>
          </div>
          {message && (
            <p className="absolute bottom-16 left-0 right-0 px-4 text-center text-[11px] font-mono text-muted">
              {message}
              {phase === 'error' && (
                <>
                  {' '}
                  {onDownload ? (
                    <button type="button" onClick={onDownload} className="underline hover:text-ink">
                      open the PDF
                    </button>
                  ) : (
                    <a href={downloadUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-ink">
                      open the PDF
                    </a>
                  )}
                </>
              )}
            </p>
          )}
        </>
      ) : null}
    </div>
  )
}
