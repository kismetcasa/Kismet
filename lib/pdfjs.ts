'use client'

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PdfInspection } from './media/zineMedia'

/**
 * The ONE loader for pdf.js (ZINE_READER_DESIGN.md §6). Everything that
 * parses or renders a PDF imports this, never `pdfjs-dist` directly — the
 * same discipline lib/media/modelViewerConfig imposes on model-viewer's
 * decoders, and for the same reason: the worker, the wasm decoders and the
 * font data must come from OUR origin at URLs set in exactly one place.
 *
 *   - Dynamic import. The legacy build is ~150 KB gzipped; a static import
 *     would push the artwork and mint routes past the 10 % bundle guard. It
 *     loads on a tap (the reader) or a PDF pick (the mint form).
 *   - The LEGACY build, not the default: its browser floor is documented
 *     (Safari 18, Chrome 125, Firefox ESR); the default build's is "latest".
 *   - Assets are copied from node_modules at `postinstall`
 *     (scripts/copy-pdfjs-assets.mjs) so the worker ALWAYS matches the API
 *     version — pdf.js refuses a mismatched worker outright — and the wasm
 *     decoders (JPEG 2000, JBIG2, ICC) are served same-origin: scanner
 *     software and Acrobat's "optimize" commonly emit JPX and JBIG2 pages.
 *
 * Client-only: it touches `document` (canvases) and `Worker`.
 */

export type PdfDocument = PDFDocumentProxy
export type PdfPage = PDFPageProxy

/** Where scripts/copy-pdfjs-assets.mjs puts the files (under public/). */
export const PDFJS_ASSET_ROOT = '/pdfjs/'

/** Per-canvas pixel budget for a rendered page. iOS WebKit rejects canvases
 *  above ~16.7 M pixels (4096 × 4096) and accounts every live canvas against
 *  a per-page memory budget; pdf.js's own viewer uses 2^25 on desktop. One
 *  conservative number for every surface. */
const PDF_RENDER_MAX_PIXELS = 16 * 1024 * 1024
/** And a per-side cap, because the pixel budget alone admits a 20 000 × 800
 *  strip that WebKit still refuses. */
const PDF_RENDER_MAX_SIDE = 4096
/** `maxImageSize` for getDocument: pdf.js skips decoding an EMBEDDED image
 *  larger than this (in pixels), so a pathological 20k × 20k scan costs a
 *  blank area, not the tab. */
const PDF_MAX_EMBEDDED_IMAGE_PIXELS = 64 * 1024 * 1024

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type PdfWorker = InstanceType<PdfJsModule['PDFWorker']>

let modulePromise: Promise<PdfJsModule> | null = null
// ONE worker for the page session, shared by every document: the mint form
// opens a PDF twice in a row (the gate's page count, then the preview) and
// the reader opens one per tap, and each getDocument without a `worker`
// would otherwise spawn — and fetch — its own. A worker hosts any number of
// documents; destroying a document never touches a worker it was handed.
let sharedWorker: PdfWorker | null = null

export function loadPdfJs(): Promise<PdfJsModule> {
  if (!modulePromise) {
    modulePromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((m) => {
        // A module worker from our origin (CSP `worker-src 'self'`). Set
        // once, before the first getDocument; pdf.js reads it at that point.
        m.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSET_ROOT}pdf.worker.min.mjs`
        return m
      })
      .catch((err) => {
        // A failed chunk load must not poison every later attempt.
        modulePromise = null
        throw err
      })
  }
  return modulePromise
}

function getWorker(pdfjs: PdfJsModule): PdfWorker {
  if (!sharedWorker || sharedWorker.destroyed) {
    sharedWorker = new pdfjs.PDFWorker()
  }
  return sharedWorker
}

/** A worker that failed (a terminated thread, a load that never answered)
 *  is dropped so the next open spawns a fresh one instead of inheriting the
 *  failure. */
function resetWorker(): void {
  const w = sharedWorker
  sharedWorker = null
  w?.destroy()
}

/** The document needs a user password to open. Owner-password-only PDFs
 *  (printing/editing restrictions) open without one and never raise this. */
export class PdfPasswordError extends Error {
  constructor() {
    super('This PDF is password-protected')
    this.name = 'PdfPasswordError'
  }
}

function isPasswordException(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'PasswordException'
}

export interface OpenedPdf {
  doc: PdfDocument
  /** Tears down the document AND its worker-side state. Always call it —
   *  the worker otherwise keeps the whole file resident. */
  close: () => Promise<void>
}

/**
 * Open a PDF from bytes. The typed array is TRANSFERRED to the worker (pdf.js
 * takes ownership), so the caller's copy is detached afterwards and the main
 * thread keeps no second copy of the file.
 */
export async function openPdf(data: ArrayBuffer | Uint8Array): Promise<OpenedPdf> {
  const pdfjs = await loadPdfJs()
  const task = pdfjs.getDocument({
    data: data instanceof Uint8Array ? data : new Uint8Array(data),
    worker: getWorker(pdfjs),
    wasmUrl: `${PDFJS_ASSET_ROOT}wasm/`,
    standardFontDataUrl: `${PDFJS_ASSET_ROOT}standard_fonts/`,
    cMapUrl: `${PDFJS_ASSET_ROOT}cmaps/`,
    cMapPacked: true,
    iccUrl: `${PDFJS_ASSET_ROOT}iccs/`,
    useWorkerFetch: true,
    // Forms are rendered as their appearance streams only; no XFA, no
    // scripting (the sandbox module is never loaded), no annotation DOM.
    enableXfa: false,
    maxImageSize: PDF_MAX_EMBEDDED_IMAGE_PIXELS,
    verbosity: 0,
  })
  try {
    const doc = await task.promise
    return { doc, close: () => task.destroy() }
  } catch (err) {
    await task.destroy().catch(() => {})
    if (isPasswordException(err)) throw new PdfPasswordError()
    // A malformed file is the file's fault and the worker is fine — other
    // documents may be open on it (the mint preview while the gate inspects
    // a second pick). Only a worker that has died, or an error that names
    // it, replaces it.
    if (sharedWorker?.destroyed || /worker/i.test(err instanceof Error ? err.message : '')) resetWorker()
    throw err
  }
}

/** The browser `PdfInspector` for the mint gate: page count, or why not. */
export async function inspectPdfFile(file: File): Promise<PdfInspection> {
  let opened: OpenedPdf
  try {
    opened = await openPdf(await file.arrayBuffer())
  } catch (err) {
    return err instanceof PdfPasswordError ? { kind: 'password' } : { kind: 'unreadable' }
  }
  try {
    return { kind: 'ok', pages: opened.doc.numPages }
  } finally {
    await opened.close().catch(() => {})
  }
}

export interface RenderedPage {
  blob: Blob
  /** Pixel size of the render. */
  width: number
  height: number
}

export interface RenderPageOptions {
  /** Target width in CSS pixels; the render is `cssWidth × dpr` wide. */
  cssWidth: number
  dpr?: number
  mime?: string
  quality?: number
  /** Extra rotation in degrees (0, 90, 180, 270) on top of the page's own
   *  /Rotate — a reader turning a landscape scan upright on a phone. */
  rotation?: number
  /** Aborting cancels the render task; the promise then rejects. */
  signal?: AbortSignal
}

/** The page's displayed aspect (width / height) after its own /Rotate and
 *  an extra rotation. */
export function pageAspect(page: PdfPage, rotation = 0): number {
  const vp = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 })
  return vp.width / vp.height
}

/**
 * Rasterize one page to a compressed image and release the canvas.
 *
 * WHY A BLOB, NOT THE CANVAS. A 1170 × 1560 canvas is ~7 MB of RAM for as
 * long as it exists; the same page as a JPEG is ~300 KB. The reader keeps a
 * window of pages, so it keeps blobs. The canvas is zeroed before it is
 * dropped — iOS WebKit reclaims canvas memory lazily and the documented
 * workaround (WebKit bug 195325) is to set width and height to 0 yourself.
 */
export async function renderPageToBlob(page: PdfPage, opts: RenderPageOptions): Promise<RenderedPage> {
  // Aborted while the caller awaited getPage: the listener below would never
  // fire for a signal already aborted, and the render would run to completion.
  opts.signal?.throwIfAborted()
  const dpr = opts.dpr ?? 1
  const rotation = (page.rotate + (opts.rotation ?? 0)) % 360
  const base = page.getViewport({ scale: 1, rotation })
  let scale = (opts.cssWidth * dpr) / base.width
  const pixels = base.width * base.height * scale * scale
  if (pixels > PDF_RENDER_MAX_PIXELS) scale *= Math.sqrt(PDF_RENDER_MAX_PIXELS / pixels)
  const side = Math.max(base.width, base.height) * scale
  if (side > PDF_RENDER_MAX_SIDE) scale *= PDF_RENDER_MAX_SIDE / side
  const viewport = page.getViewport({ scale, rotation })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(viewport.width))
  canvas.height = Math.max(1, Math.ceil(viewport.height))
  const width = canvas.width
  const height = canvas.height
  const task = page.render({ canvas, viewport, background: '#ffffff' })
  const onAbort = () => task.cancel()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await task.promise
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, opts.mime ?? 'image/jpeg', opts.quality ?? 0.9),
    )
    if (!blob) throw new Error('page encode failed')
    return { blob, width, height }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    canvas.width = 0
    canvas.height = 0
    // Fonts and decoded images for this page go back to the worker's
    // pool; the next render re-decodes, which for a scanned page is one
    // JPEG — cheap next to keeping every visited page's bitmaps resident.
    page.cleanup()
  }
}

/** Long edge of the cover JPEG rendered from a page at mint time. Matches
 *  the other posters' consumers: the OG hero draws at 800 × 800 and /api/img
 *  downscales to 2048, so 1200 is comfortably above both. */
const ZINE_COVER_LONG_EDGE = 1200

/**
 * The cover for a zine minted without an uploaded one: a page rendered to a
 * JPEG `File`, which then goes down the existing poster pipeline (thumbhash
 * + Arweave upload). JPEG 0.85 — the same quality extractVideoPoster and
 * ModelPreview use, so a zine's card looks like every other card.
 */
export async function renderZineCoverFile(doc: PdfDocument, pageNumber: number, fileName: string): Promise<File> {
  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const cssWidth = base.width >= base.height ? ZINE_COVER_LONG_EDGE : ZINE_COVER_LONG_EDGE * (base.width / base.height)
  const rendered = await renderPageToBlob(page, { cssWidth, dpr: 1, mime: 'image/jpeg', quality: 0.85 })
  const stem = fileName.replace(/\.[^.]+$/, '') || 'zine'
  return new File([rendered.blob], `${stem}-cover.jpg`, { type: 'image/jpeg' })
}
