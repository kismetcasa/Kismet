'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { MomentImage } from './MomentImage'
import { holdBodyScroll } from '@/lib/bodyScroll'
import { thumbhashToRatio } from '@/lib/media/thumbhash'

/**
 * The first moment of reading a zine (ZINE_READER_DESIGN.md §5.2, §25).
 *
 * A tap on "read" no longer waits for the file. The cover leaves its place
 * on the artwork page and settles exactly where the reader will show the
 * first page, on the reader's own backdrop, while the PDF downloads and
 * opens behind it. When the reader has painted underneath (`leaving`), this
 * layer fades and the cover appears to sharpen into the page. A failed open
 * stays here, in the same frame, with retry and the PDF itself a tap away.
 *
 * Pure presentation: it owns no download and no document. It sits one layer
 * above the reader so the handoff is a crossfade, never a flash.
 */

/** The reader's stage padding and page shadow, shared so the cover lands on
 *  the first page's own rectangle and looks like the same sheet. */
export const STAGE_PAD = 12
export const PAGE_SHADOW = '0 1px 2px rgba(0,0,0,.6), 0 8px 24px rgba(0,0,0,.5)'
/** Fallback page shape (width / height) — A-series portrait, the common zine. */
export const DEFAULT_ASPECT = 0.7071
/** Motion off: the user asked for less, or the display redraws slowly
 *  (e-ink) — slides and zooms become fades; a finger is still followed. */
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce), (update: slow)'

/** The reading room: near-black, lit by the cover's own average colour
 *  (from its thumbhash — no image, no blur filter, nothing extra to
 *  composite), so each zine is read in a light of its own. */
export function zineBackdrop(rgb: [number, number, number] | null): string {
  if (!rgb) return '#0a0a0a'
  const [r, g, b] = rgb.map((v) => Math.round(v))
  return `radial-gradient(120% 85% at 50% 42%, rgba(${r},${g},${b},0.2) 0%, rgba(${r},${g},${b},0.07) 42%, rgba(${r},${g},${b},0) 72%), #0a0a0a`
}

/** A page of `aspect` fitted and centred in a viewport, as the reader fits it. */
export function fitCentered(vw: number, vh: number, aspect: number) {
  const w = Math.max(1, Math.min(vw - STAGE_PAD * 2, (vh - STAGE_PAD * 2) * aspect))
  const h = w / aspect
  return { left: (vw - w) / 2, top: (vh - h) / 2, width: w, height: h }
}

export interface ZineCover {
  /** Raw cover URI — drawn when there is no `current` (the collector-file
   *  viewer, a cover still loading) the way the artwork slot draws it (same
   *  `sizes`), with the thumbhash as its placeholder. */
  src: string
  thumbhash?: string
  /** width / height, when the slot has measured it. */
  aspect?: number
  /** Where the cover is drawn on the page at the tap, for the expand. */
  from?: { left: number; top: number; width: number; height: number }
  /** The URL the slot's image is showing (its currentSrc): loaded and
   *  decoded already, so the expand starts with the very bitmap that was
   *  tapped. A fresh image component would re-run its own delivery chain
   *  (optimizer, then proxy) and could show its skeleton for a round trip. */
  current?: string
}

/** The cover as the artwork slot draws it (object-contain in its box), or
 *  nothing while it has not loaded — the frame then simply fades in. */
export function measureCover(slot: HTMLElement | null): Pick<ZineCover, 'from' | 'aspect' | 'current'> {
  const img = slot?.querySelector('img')
  if (!img || !img.complete || !img.naturalWidth || !img.naturalHeight) return {}
  const box = img.getBoundingClientRect()
  const s = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight)
  const width = img.naturalWidth * s
  const height = img.naturalHeight * s
  return {
    aspect: img.naturalWidth / img.naturalHeight,
    from: { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height },
    current: img.currentSrc || img.src,
  }
}

const EXPAND_MS = 360
const EXPAND_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
const LEAVE_MS = 220

interface Props {
  title: string
  cover?: ZineCover
  backdrop: string
  /** "62% · 1.5 of 2.4 MB", "preparing" … */
  readout: string
  /** 0..1 once the size is known. */
  fraction: number | null
  error?: {
    message: string
    onRetry?: () => void
    /** The PDF itself: a link on the web, a host call in a Mini App. */
    pdf?: { href: string } | { onOpen: () => void }
  } | null
  /** The reader has painted underneath: fade out, then `onGone`. */
  leaving: boolean
  onGone: () => void
  onClose: () => void
}

export function ZineOpening({ title, cover, backdrop, readout, fraction, error, leaving, onGone, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [vp, setVp] = useState<{ w: number; h: number } | null>(null)
  // This layer only ever renders after a tap, in the browser.
  const reduce = useMemo(() => window.matchMedia(REDUCED_MOTION).matches, [])
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const onGoneRef = useRef(onGone)
  onGoneRef.current = onGone

  useEffect(() => holdBodyScroll(), [])

  useLayoutEffect(() => {
    const measure = () => setVp({ w: window.innerWidth, h: window.innerHeight })
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const aspect = cover?.aspect ?? thumbhashToRatio(cover?.thumbhash) ?? DEFAULT_ASPECT
  const box = vp ? fitCentered(vp.w, vp.h, aspect) : null

  // The expand, once: the cover flies from its place on the page to the
  // first page's place (FLIP — measured, inverted, played on the compositor),
  // while the room darkens around it.
  const playedRef = useRef(false)
  useLayoutEffect(() => {
    if (playedRef.current || !box) return
    playedRef.current = true
    if (reduce) return
    backdropRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' })
    const from = cover?.from
    if (from && coverRef.current) {
      const t = `translate(${from.left - box.left}px, ${from.top - box.top}px) scale(${from.width / box.width}, ${from.height / box.height})`
      coverRef.current.animate([{ transform: t }, { transform: 'none' }], { duration: EXPAND_MS, easing: EXPAND_EASE })
    } else {
      coverRef.current?.animate(
        [{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }],
        { duration: 280, easing: EXPAND_EASE },
      )
    }
  }, [box, cover?.from, reduce])

  // The handoff: fade away over the reader's first page.
  useEffect(() => {
    if (!leaving) return
    const el = rootRef.current
    if (!el) { onGoneRef.current(); return }
    const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: reduce ? 120 : LEAVE_MS, easing: 'ease-out', fill: 'forwards' })
    a.finished.then(() => onGoneRef.current(), () => onGoneRef.current())
    return () => a.cancel()
  }, [leaving, reduce])

  // Focus the way out; Escape takes it — and ONLY it, captured on window as
  // the reader does: the in-app overlay route closes on Escape too (its own
  // window listener calls router.back()), and both acting would pop two
  // history entries. (Once the reader is up it takes Escape itself, and this
  // layer no longer takes input.)
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (leaving) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      e.preventDefault()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [leaving])

  const layer = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Opening ${title}`}
      className="fixed inset-0 z-[201] select-none"
      style={{ overscrollBehavior: 'none', touchAction: 'none', pointerEvents: leaving ? 'none' : undefined }}
    >
      <div ref={backdropRef} className="absolute inset-0" style={{ background: backdrop }} />
      {cover && box && (
        <div
          ref={coverRef}
          className="absolute bg-white"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            boxShadow: PAGE_SHADOW,
            transformOrigin: '0 0',
            opacity: error ? 0.35 : 1,
            transition: 'opacity 200ms ease-out',
          }}
        >
          {cover.current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={cover.current} alt="" decoding="sync" draggable={false} className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <MomentImage
              src={cover.src}
              alt=""
              fill
              className="object-cover"
              sizes="(max-width: 768px) 100vw, 50vw"
              priority
              thumbhash={cover.thumbhash}
            />
          )}
        </div>
      )}

      <div className="absolute top-0 right-0 h-12 px-3 flex items-center">
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Cancel opening the zine"
          className="w-8 h-8 flex items-center justify-center text-dim hover:text-ink transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {error ? (
        <div className="absolute inset-x-0 bottom-0 pb-8 px-6 flex flex-col items-center gap-3 text-center">
          <p className="max-w-sm text-[11px] font-mono text-dim">{error.message}</p>
          <div className="flex items-center gap-2">
            {error.onRetry && (
              <button
                type="button"
                onClick={error.onRetry}
                className="px-4 py-2 bg-[#0d0d0d]/85 border border-line text-xs font-mono uppercase tracking-wider text-dim hover:text-ink hover:border-muted transition-colors"
              >
                retry
              </button>
            )}
            {error.pdf && ('href' in error.pdf ? (
              <a
                href={error.pdf.href}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 text-xs font-mono uppercase tracking-wider text-muted hover:text-ink transition-colors underline-offset-4 hover:underline"
              >
                open the PDF
              </a>
            ) : (
              <button
                type="button"
                onClick={error.pdf.onOpen}
                className="px-4 py-2 text-xs font-mono uppercase tracking-wider text-muted hover:text-ink transition-colors underline-offset-4 hover:underline"
              >
                open the PDF
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <p className="absolute inset-x-0 bottom-4 flex justify-center pointer-events-none" aria-hidden>
            <span className="px-2.5 py-1 bg-[#0d0d0d]/85 text-[11px] font-mono text-dim whitespace-nowrap [font-variant-numeric:tabular-nums]">
              {readout}
            </span>
          </p>
          <div
            role="progressbar"
            aria-label={`Opening ${title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
            aria-valuetext={readout}
            className="absolute inset-x-0 bottom-0 h-[2px] bg-white/10 overflow-hidden"
          >
            <div
              className={`h-full bg-ink/70 origin-left ${fraction === null ? 'w-1/3 animate-pulse' : 'w-full'}`}
              style={fraction === null ? undefined : { transform: `scaleX(${fraction})`, transition: reduce ? undefined : 'transform 160ms linear' }}
            />
          </div>
        </>
      )}
    </div>
  )

  return createPortal(layer, document.body)
}
