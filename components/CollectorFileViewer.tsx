'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { CFILE_KIND_META, type CfileKind } from '@/lib/collectorFileTypes'

/**
 * In-page viewer for a collector file (design "Format extension"). Fetches
 * the gated bytes from /api/collector-file/view — a same-origin request, so
 * FarcasterProvider's patched window.fetch attaches the Quick Auth JWT and
 * a Mini App authenticates exactly like the web does — turns them into a
 * blob URL, and renders per kind.
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
 */

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
}

/** Focusable descendants, for the dialog focus contract below. */
const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])'

export function CollectorFileViewer({ collection, tokenId, kind, name, v, onClose }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        // The custom element must be defined before <model-viewer> renders,
        // and its module is heavy — load it while the bytes are in flight.
        const mod = kind === 'glb' ? await import('@google/model-viewer') : null
        if (mod) {
          // Point Draco/KTX2 at OUR copies. model-viewer otherwise fetches
          // these from www.gstatic.com at render time — an undeclared
          // third-party origin that would also break under an enforcing
          // CSP. See public/model-decoders/README.md.
          mod.ModelViewerElement.dracoDecoderLocation = '/model-decoders/draco/'
          mod.ModelViewerElement.ktx2TranscoderLocation = '/model-decoders/basis/'
        }
        const res = await fetch(
          `/api/collector-file/view?collection=${collection}&tokenId=${tokenId}&v=${v}`,
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
        const bytes = await res.arrayBuffer()
        if (cancelled) return
        // Explicit type: the blob's MIME is what makes <img> render an SVG
        // and <model-viewer> accept a GLB — never inferred from the response.
        const url = URL.createObjectURL(new Blob([bytes], { type: CFILE_KIND_META[kind].mime }))
        urlRef.current = url
        setBlobUrl(url)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this file')
      }
    })()
    return () => {
      cancelled = true
      // Release the object URL, or every open leaks its bytes for the life
      // of the document — these are up to 16 MB each.
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [collection, tokenId, kind, v])

  // WAI-ARIA dialog contract (WCAG 2.2 SC 2.1.1 Keyboard + 2.4.3 Focus
  // Order): focus moves INTO the dialog on open, Tab cycles within it, and
  // focus RETURNS to whatever opened it on close. Escape and the labelled
  // close button are the required ways out — a trap without an exit is
  // itself the 2.1.2 violation.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
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
  }, [onClose])

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
          onClick={onClose}
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
          <p className="text-[11px] font-mono text-muted">loading…</p>
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
