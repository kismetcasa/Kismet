'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ZINE_COPY, formatZinePages } from '@/lib/media/zineMedia'
import { formatCfileSize } from '@/lib/collectorFileTypes'
import { openPdf, renderPageToBlob, renderZineCoverFile, type OpenedPdf } from '@/lib/pdfjs'

/**
 * Mint-form preview for a zine: renders the picked PDF page by page so the
 * artist can check the reading order, and captures the chosen page as the
 * moment's cover (ZINE_READER_DESIGN.md §9).
 *
 * WHY CAPTURE HERE. A zine ships the video/3D metadata shape (`image` cover +
 * `animation_url` PDF + `content.mime`), so the cover is what every feed card,
 * OG card, embed and collection cover renders — a coverless zine would be
 * invisible on every surface but one. The page the artist is looking at is
 * the cover source, page 1 by default; "use this page as cover" re-captures
 * from any other (the posed-model precedent: the framing of a work is an
 * authored decision). An uploaded cover image, if the artist adds one, wins
 * over this capture in the form.
 *
 * Memory: one page image on screen at a time plus the cover file; the
 * document is closed on unmount so the worker releases the bytes.
 */

interface Props {
  /** The picked PDF. ONE file per mount: the caller keys the component on
   *  the pick, and a new file arriving in place resets every page state. */
  file: File
  /** Fires with the newest captured cover, or null if capture failed. */
  onPoster: (poster: File | null) => void
  /** Fires when the document itself can't be shown. */
  onError: (message: string) => void
  /** The page to capture as the cover at mount (clamped to the document) —
   *  how the chosen page survives "optimize for phones" and its undo. */
  initialCoverPage?: number
  /** Fires with the page the cover is captured from, whenever it changes. */
  onCoverPage?: (page: number) => void
}

const PREVIEW_MAX_CSS_WIDTH = 720

export function ZinePreview({ file, onPoster, onError, initialCoverPage, onCoverPage }: Props) {
  const [opened, setOpened] = useState<OpenedPdf | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [page, setPage] = useState(1)
  const [coverPage, setCoverPage] = useState(Math.max(1, Math.floor(initialCoverPage ?? 1)))
  const onCoverPageRef = useRef(onCoverPage)
  onCoverPageRef.current = onCoverPage
  const [pageUrl, setPageUrl] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const urlRef = useRef<string | null>(null)
  const onPosterRef = useRef(onPoster)
  onPosterRef.current = onPoster
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  // A render or a capture is async; a result from a file the artist has since
  // swapped out must never install itself over the new one.
  const liveRef = useRef(true)

  useEffect(() => {
    liveRef.current = true
    // A file arriving in place (the caller keys on the pick, so this is the
    // mount in practice): the previous document's page state must not be
    // applied to the new one.
    setOpened(null)
    setPageUrl(null)
    setPageCount(0)
    setPage(1)
    let current: OpenedPdf | null = null
    ;(async () => {
      try {
        const o = await openPdf(await file.arrayBuffer())
        if (!liveRef.current) {
          await o.close().catch(() => {})
          return
        }
        current = o
        setOpened(o)
        setPageCount(o.doc.numPages)
        // The carried cover page may exceed this document's count.
        setCoverPage((p) => Math.min(p, o.doc.numPages))
      } catch {
        if (liveRef.current) onErrorRef.current(ZINE_COPY.unreadable)
      }
    })()
    return () => {
      liveRef.current = false
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
      void current?.close().catch(() => {})
    }
  }, [file])

  // The page on screen.
  useEffect(() => {
    if (!opened) return
    let cancelled = false
    const controller = new AbortController()
    setRendering(true)
    ;(async () => {
      try {
        const pdfPage = await opened.doc.getPage(page)
        const cssWidth = Math.min(containerRef.current?.clientWidth || PREVIEW_MAX_CSS_WIDTH, PREVIEW_MAX_CSS_WIDTH)
        const rendered = await renderPageToBlob(pdfPage, {
          cssWidth,
          dpr: Math.min(window.devicePixelRatio || 1, 2),
          signal: controller.signal,
        })
        if (cancelled || !liveRef.current) return
        const url = URL.createObjectURL(rendered.blob)
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = url
        setPageUrl(url)
      } catch {
        if (!cancelled && liveRef.current) onErrorRef.current(ZINE_COPY.unreadable)
      } finally {
        if (!cancelled) setRendering(false)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [opened, page])

  // The cover file, re-captured whenever the chosen page changes.
  useEffect(() => {
    if (!opened) return
    let cancelled = false
    ;(async () => {
      try {
        const cover = await renderZineCoverFile(opened.doc, coverPage, file.name)
        if (cancelled || !liveRef.current) return
        onCoverPageRef.current?.(coverPage)
        onPosterRef.current(cover)
      } catch {
        if (cancelled || !liveRef.current) return
        onPosterRef.current(null)
        onErrorRef.current(ZINE_COPY.noCover)
      }
    })()
    return () => { cancelled = true }
  }, [opened, coverPage, file.name])

  const go = useCallback((delta: number) => {
    setPage((p) => Math.min(Math.max(1, p + delta), Math.max(1, pageCount)))
  }, [pageCount])

  return (
    <div className="relative">
      <div ref={containerRef} className="relative w-full bg-raised flex items-center justify-center min-h-48">
        {pageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={pageUrl} alt={`Page ${page} preview`} className="block w-full h-auto" draggable={false} />
        ) : (
          <p className="text-[11px] font-mono text-muted py-16">
            {opened ? 'rendering page…' : 'opening PDF…'}
          </p>
        )}
        {pageUrl && rendering && (
          <span aria-hidden className="absolute inset-0 bg-black/20 animate-pulse pointer-events-none" />
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-line bg-[#0d0d0d]">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={page <= 1}
            aria-label="Previous page"
            className="w-7 h-7 flex items-center justify-center text-dim hover:text-ink disabled:opacity-30 transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-[11px] font-mono text-muted tabular-nums" aria-live="polite">
            {pageCount ? `${page} / ${pageCount}` : '…'}
          </span>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={page >= pageCount}
            aria-label="Next page"
            className="w-7 h-7 flex items-center justify-center text-dim hover:text-ink disabled:opacity-30 transition-colors"
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <p className="text-[10px] font-mono text-muted truncate">
          {pageCount ? `${formatZinePages(pageCount)} · ${formatCfileSize(file.size)}` : ''}
        </p>
        {page === coverPage ? (
          <span className="text-[10px] font-mono text-dim uppercase tracking-wider whitespace-nowrap">
            cover
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setCoverPage(page)}
            className="text-[10px] font-mono uppercase tracking-wider text-dim hover:text-ink underline-offset-2 hover:underline whitespace-nowrap"
          >
            use as cover
          </button>
        )}
      </div>
    </div>
  )
}
