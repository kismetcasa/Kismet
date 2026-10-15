'use client'

import { PDF_MIME } from '../pdfFormat'
import { openPdf, renderPageToBlob, type PdfPage } from '../pdfjs'

/**
 * "Optimize for phones" for a zine — the mint form's optional pass, the
 * counterpart of lib/media/optimizeModel for 3D (ZINE_READER_DESIGN.md §21).
 *
 * WHY. A scanned zine is one 300 dpi JPEG per page: Arjan's issue #0 is six
 * A4 scans of 2480 × 3507 px (8.7 M pixels each). pdf.js must decode the
 * whole JPEG before it can draw the page, and that decode — not the
 * download, not our render — is where a phone spends its time: ~0.8 s per
 * page measured, and it scales with pixels, not bytes. A phone never shows
 * more than ~1200 px of a page, so 300 dpi buys nothing on screen. This pass
 * re-renders every page at a long edge of ZINE_OPTIMIZE_LONG_EDGE px (plenty
 * for a 3× phone and for zoom), writes a new PDF with one JPEG per page, and
 * hands it back through the same pick gate as any file. Page count, page
 * sizes (in points) and reading order are preserved; vector text and the
 * original file's text layer are rasterized, which is why this is opt-in
 * with an undo and is described as "for phones", not applied silently.
 *
 * THE WRITER. A minimal, spec-valid PDF: a catalog, a page tree, one page
 * object + one DCTDecode image XObject + one content stream per page, and a
 * correct xref. No PDF library in the repo (the GLB optimizer's "no new
 * deps" posture); scripts/e2e/make-pdf.mjs is the same writer in miniature.
 */

/** Long edge of a re-rendered page in pixels. 2000 covers a 3× phone's
 *  ~1200 px page with room for a 1.6× zoom before it softens; A4 at this
 *  size is 1414 × 2000 = 2.8 M pixels, ~3× faster to decode than 300 dpi. */
export const ZINE_OPTIMIZE_LONG_EDGE = 2000
export const ZINE_OPTIMIZE_QUALITY = 0.85
/** An "optimized" file that is not at least this much smaller is reported
 *  unchanged and the original is kept — re-encoding a small vector PDF into
 *  JPEG pages would only make it bigger and blurrier. */
const MIN_SAVING = 0.15

export type PdfOptimizeStep = { kind: 'page'; page: number; pages: number } | { kind: 'writing' }

export interface PdfOptimizeResult {
  file: File
  before: number
  after: number
  pages: number
  /** The pass produced nothing worth keeping (see MIN_SAVING). */
  unchanged: boolean
}

export interface PdfOptimizeOptions {
  onStep?: (step: PdfOptimizeStep) => void
  signal?: AbortSignal
  longEdge?: number
  quality?: number
}

interface RasterPage {
  jpeg: Uint8Array
  pixelWidth: number
  pixelHeight: number
  /** Page size in PDF points, after the page's own /Rotate. */
  widthPt: number
  heightPt: number
}

const enc = new TextEncoder()
const bytesOf = (s: string): Uint8Array => enc.encode(s)

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.byteLength
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/** Escape a string for a PDF literal string `( … )`. */
function pdfString(s: string): string {
  return `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '')})`
}

/**
 * Write a PDF whose pages are one JPEG each. Exported for the oracle, which
 * feeds it fixture rasters and checks the result with the collector-file
 * detector and a page count.
 */
export function writeImagePdf(pages: RasterPage[], meta: { title?: string } = {}): Uint8Array {
  // Object numbers: 1 catalog, 2 pages, 3 info, then per page: image,
  // content, page.
  const objects: Uint8Array[] = []
  const add = (body: Uint8Array): number => {
    objects.push(body)
    return objects.length
  }
  const catalogNo = add(new Uint8Array())
  const pagesNo = add(new Uint8Array())
  const infoNo = add(
    bytesOf(
      `<< /Producer (Kismet zine optimizer)${meta.title ? ` /Title ${pdfString(meta.title)}` : ''} >>`,
    ),
  )
  const pageNos: number[] = []
  for (const p of pages) {
    const imageNo = add(
      concat([
        bytesOf(
          `<< /Type /XObject /Subtype /Image /Width ${p.pixelWidth} /Height ${p.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.byteLength} >>\nstream\n`,
        ),
        p.jpeg,
        bytesOf('\nendstream'),
      ]),
    )
    const w = p.widthPt.toFixed(2)
    const h = p.heightPt.toFixed(2)
    const content = bytesOf(`q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q\n`)
    const contentNo = add(concat([bytesOf(`<< /Length ${content.byteLength} >>\nstream\n`), content, bytesOf('\nendstream')]))
    const pageNo = add(
      bytesOf(
        `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im1 ${imageNo} 0 R >> >> /Contents ${contentNo} 0 R >>`,
      ),
    )
    pageNos.push(pageNo)
  }
  objects[catalogNo - 1] = bytesOf(`<< /Type /Catalog /Pages ${pagesNo} 0 R >>`)
  objects[pagesNo - 1] = bytesOf(`<< /Type /Pages /Kids [${pageNos.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`)

  const parts: Uint8Array[] = [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])]
  let length = parts[0].byteLength
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(length)
    const head = bytesOf(`${i + 1} 0 obj\n`)
    const tail = bytesOf('\nendobj\n')
    parts.push(head, body, tail)
    length += head.byteLength + body.byteLength + tail.byteLength
  })
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\nstartxref\n${length}\n%%EOF\n`
  parts.push(bytesOf(xref))
  return concat(parts)
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Optimization cancelled', 'AbortError')
}

async function rasterize(page: PdfPage, longEdge: number, quality: number, signal?: AbortSignal): Promise<RasterPage> {
  const vp = page.getViewport({ scale: 1 })
  const cssWidth = vp.width >= vp.height ? longEdge : (longEdge * vp.width) / vp.height
  const rendered = await renderPageToBlob(page, { cssWidth, dpr: 1, mime: 'image/jpeg', quality, signal })
  return {
    jpeg: new Uint8Array(await rendered.blob.arrayBuffer()),
    pixelWidth: rendered.width,
    pixelHeight: rendered.height,
    widthPt: vp.width,
    heightPt: vp.height,
  }
}

export async function optimizeZinePdf(file: File, opts: PdfOptimizeOptions = {}): Promise<PdfOptimizeResult> {
  const longEdge = opts.longEdge ?? ZINE_OPTIMIZE_LONG_EDGE
  const quality = opts.quality ?? ZINE_OPTIMIZE_QUALITY
  const before = file.size
  const opened = await openPdf(await file.arrayBuffer())
  try {
    const pages = opened.doc.numPages
    let title: string | undefined
    try {
      const info = (await opened.doc.getMetadata()).info as { Title?: unknown }
      if (typeof info?.Title === 'string' && info.Title.trim()) title = info.Title.trim().slice(0, 120)
    } catch {
      /* no metadata is fine */
    }
    const rasters: RasterPage[] = []
    for (let n = 1; n <= pages; n++) {
      aborted(opts.signal)
      opts.onStep?.({ kind: 'page', page: n, pages })
      const page = await opened.doc.getPage(n)
      rasters.push(await rasterize(page, longEdge, quality, opts.signal))
    }
    aborted(opts.signal)
    opts.onStep?.({ kind: 'writing' })
    const bytes = writeImagePdf(rasters, { title })
    const after = bytes.byteLength
    if (after > before * (1 - MIN_SAVING)) {
      return { file, before, after: before, pages, unchanged: true }
    }
    const stem = file.name.replace(/\.pdf$/i, '') || 'zine'
    return {
      file: new File([bytes as BlobPart], `${stem}-phone.pdf`, { type: PDF_MIME, lastModified: Date.now() }),
      before,
      after,
      pages,
      unchanged: false,
    }
  } finally {
    await opened.close().catch(() => {})
  }
}
