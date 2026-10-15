'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { X } from 'lucide-react'
import { CFILE_KIND_META, formatCfileSize, type CfileKind } from '@/lib/collectorFileTypes'
import { configureModelViewerDecoders } from '@/lib/media/modelViewerConfig'
import { openPdf, type OpenedPdf } from '@/lib/pdfjs'
import { readRotation, readStartPage, rememberPage, rememberRotation, useReaderHistory } from '@/lib/zineHistory'
import { ZINE_COPY } from '@/lib/media/zineMedia'

/**
 * In-page viewer for a collector file (design "Format extension"). Fetches
 * the gated bytes from /api/collector-file/view — a same-origin request, so
 * FarcasterProvider's patched window.fetch attaches the Quick Auth JWT and
 * a Mini App authenticates exactly like the web does — and renders per kind.
 *
 * SVG SAFETY, the one rule this file exists to hold:
 * an SVG may contain <script>, event handlers and foreignObject, and blob:
 * URLs INHERIT THE CREATING ORIGIN — so navigating to one (window.open,
 * an <a href>, <object>, <iframe>) would execute artist-authored script as
 * kismet.art. That is the WhatsApp/Telegram Web XSS. Browsers disable
 * scripting and external resource loading only in IMAGE contexts, so the
 * SVG is rendered exclusively through <img src={blobUrl}> — never inline,
 * never dangerouslySetInnerHTML, never opened. Our CSP is Report-Only
 * (next.config.mjs), so this rule is the control, not a second line.
 *
 * GLB is inert data with no such hazard; <model-viewer> is imported lazily
 * (~444 KB chunk, outside the artwork route's manifest) on first open.
 *
 * PDF (a collectors-only zine, ZINE_READER_DESIGN.md §10) never becomes a
 * URL at all: the bytes go straight to pdf.js in its worker and the same
 * page-by-page reader public zines use mounts over the page. The bytes stay
 * in memory only, and the document is closed when the reader is.
 */

const ZineReader = dynamic(() => import('./ZineReader').then((m) => m.ZineReader), { ssr: false })

interface Props {
  collection: string
  tokenId: string
  kind: CfileKind
  name: string
  /** Current version — part of the request URL purely as a CACHE KEY. The
   *  view response is cached for an hour, so without it a replace would keep
   *  rendering the superseded file while the card advertised the update. */
  v: number
  onClose: () => void
  /** Inside a Mini App: the reader ticks a haptic on each page turn. */
  miniApp?: boolean
}

/** Focusable descendants, for the dialog focus contract below. */
const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])'

export function CollectorFileViewer({ collection, tokenId, kind, name, v, onClose, miniApp = false }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [opened, setOpened] = useState<OpenedPdf | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ loaded: number; total: number | null } | null>(null)
  const urlRef = useRef<string | null>(null)
  const openedRef = useRef<OpenedPdf | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const storageKey = `${collection.toLowerCase()}:${tokenId}`
  // The back gesture closes this viewer — the loading shell included — rather
  // than the artwork page (lib/zineHistory). The UI's close goes through it
  // too, so the stack never keeps a dead entry.
  const closeViaHistory = useReaderHistory(true, onClose)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    ;(async () => {
      try {
        // The custom element must be defined before <model-viewer> renders,
        // and its module is heavy — load it while the bytes are in flight.
        const modPromise = kind === 'glb' ? import('@google/model-viewer') : Promise.resolve(null)
        const res = await fetch(
          `/api/collector-file/view?collection=${collection}&tokenId=${tokenId}&v=${v}`,
          { signal: controller.signal },
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          // Viewing is session-only; downloading additionally accepts a
          // signed wallet proof. A holder without a session can therefore
          // download but not view — say so instead of dead-ending them.
          throw new Error(
            res.status === 401
              ? 'Sign in to view this here — or use download instead.'
              : (body?.error ?? 'Could not load this file'),
          )
        }
        // Read the body ourselves for a byte readout: a zine can be tens of
        // megabytes, and a bare "loading…" past ten seconds reads as a hang.
        const declared = res.headers.get('content-length')
        const total = declared && /^\d+$/.test(declared) ? Number(declared) : null
        const chunks: Uint8Array[] = []
        let loaded = 0
        if (res.body) {
          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(value)
            loaded += value.byteLength
            if (!cancelled) setProgress({ loaded, total })
          }
        }
        const bytes = new Uint8Array(loaded)
        let at = 0
        for (const c of chunks) {
          bytes.set(c, at)
          at += c.byteLength
        }
        if (cancelled) return
        if (kind === 'pdf') {
          // Straight into the worker (the typed array is transferred, so no
          // second copy lingers here); never a URL.
          const o = await openPdf(bytes)
          if (cancelled) {
            void o.close().catch(() => {})
            return
          }
          openedRef.current = o
          setOpened(o)
          return
        }
        const mod = await modPromise
        if (mod) {
          // Point Draco/KTX2 at OUR copies. model-viewer otherwise fetches
          // these from www.gstatic.com at render time — an undeclared
          // third-party origin that would also break under an enforcing
          // CSP. See public/model-decoders/README.md.
          // Set on the global config the element constructor reads — the
          // static setter this used to assign never held (lib/media/
          // modelViewerConfig).
          configureModelViewerDecoders()
        }
        if (cancelled) return
        // Explicit type: the blob's MIME is what makes <img> render an SVG
        // and <model-viewer> accept a GLB — never inferred from the response.
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: CFILE_KIND_META[kind].mime }))
        urlRef.current = url
        setBlobUrl(url)
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return
        setError(
          err instanceof Error && err.message && !(kind === 'pdf' && err.name === 'PdfPasswordError')
            ? err.message
            : kind === 'pdf'
              ? ZINE_COPY.readerUnavailable
              : 'Could not load this file',
        )
      }
    })()
    return () => {
      cancelled = true
      // Closing mid-download stops the transfer: a 64 MiB file must not keep
      // streaming for nobody.
      controller.abort()
      // Release the object URL, or every open leaks its bytes for the life
      // of the document — these are up to CFILE_MAX_BYTES (64 MiB) each.
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
      // And the document, so the worker releases the file.
      const o = openedRef.current
      openedRef.current = null
      if (o) void o.close().catch(() => {})
    }
  }, [collection, tokenId, kind, v])

  // WAI-ARIA dialog contract (WCAG 2.2 SC 2.1.1 Keyboard + 2.4.3 Focus
  // Order): focus moves INTO the dialog on open, Tab cycles within it, and
  // focus RETURNS to whatever opened it on close. Escape and the labelled
  // close button are the required ways out — a trap without an exit is
  // itself the 2.1.2 violation. The zine reader brings its own contract
  // (and captures Escape itself) once it is on screen.
  useEffect(() => {
    if (opened) return
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeViaHistory()
        return
      }
      if (e.key !== 'Tab') return
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (!nodes || nodes.length === 0) return
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      opener?.focus?.()
    }
  }, [closeViaHistory, opened])

  // model-viewer reports its own load failures on an `error` event — a
  // corrupt GLB (or a decoder that failed to load) otherwise leaves an
  // empty box with no explanation. Attached with addEventListener via a
  // callback ref rather than an `onError` prop: React's synthetic event
  // system maps on*-props for known DOM elements, NOT for custom elements,
  // so the prop form would silently never fire.
  const modelRef = useCallback((el: HTMLElement | null) => {
    if (!el) return
    const handler = () =>
      setError('This 3D model could not be displayed — try downloading it instead.')
    el.addEventListener('error', handler)
    return () => el.removeEventListener('error', handler)
  }, [])

  const onPageChange = useCallback((page: number) => rememberPage(storageKey, page), [storageKey])
  const onRotationChange = useCallback((r: number) => rememberRotation(storageKey, r), [storageKey])

  if (opened) {
    return (
      <ZineReader
        doc={opened.doc}
        title={name}
        startPage={readStartPage(storageKey)}
        onClose={closeViaHistory}
        onPageChange={onPageChange}
        haptics={miniApp}
        startRotation={readRotation(storageKey)}
        onRotationChange={onRotationChange}
      />
    )
  }

  const readout = progress
    ? progress.total
      ? `${formatCfileSize(progress.loaded)} of ${formatCfileSize(progress.total)}`
      : formatCfileSize(progress.loaded)
    : null

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 bg-black/90 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${name}`}
    >
      <div className="flex items-center justify-between px-4 py-3 flex-shrink-0">
        <p className="text-[11px] font-mono text-muted truncate">{name}</p>
        <button
          ref={closeRef}
          onClick={closeViaHistory}
          aria-label="Close viewer"
          className="p-1.5 text-muted hover:text-ink transition-colors"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center p-4">
        {error ? (
          <p className="text-[11px] font-mono text-muted text-center max-w-xs">{error}</p>
        ) : !blobUrl ? (
          <p className="text-[11px] font-mono text-muted">
            {kind === 'pdf' ? 'opening zine…' : 'loading…'}{readout ? ` ${readout}` : ''}
          </p>
        ) : kind === 'glb' ? (
          // @ts-expect-error — custom element registered by the lazy import.
          <model-viewer
            ref={modelRef}
            src={blobUrl}
            camera-controls
            auto-rotate
            touch-action="pan-y"
            style={{ width: '100%', height: '100%', backgroundColor: 'transparent' }}
          />
        ) : (
          // IMAGE context only — see the SVG safety note above. next/image is
          // not an option and not merely inconvenient here: it cannot take a
          // blob: URL, and the raw <img> element IS the security control (it
          // is what disables scripting in the SVG).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={blobUrl}
            alt={name}
            onError={() => setError('This image could not be displayed — try downloading it instead.')}
            className="max-w-full max-h-full object-contain"
          />
        )}
      </div>
    </div>
  )
}
