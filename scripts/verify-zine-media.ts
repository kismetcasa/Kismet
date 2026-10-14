/**
 * Zine oracle (ZINE_READER_DESIGN.md) — run via `verify:flows`.
 *
 * Pins the invariants that would otherwise rot silently, in the same spirit
 * as scripts/verify-model-media.ts for 3D:
 *
 *   1. THE MINT GATE. A PDF is admitted ONLY through the parser the mint form
 *      injects (page count, password), and the page and byte caps are
 *      enforced there — at pick time, before any Arweave credit is spent.
 *      Without a parser (the edit flow, the machine stage frames) a PDF is
 *      refused, never silently minted as an image.
 *   2. THE FAIL-SAFE SHAPE. `resolveMomentMedia` must put a zine's COVER in
 *      `src` and the PDF in `pdfSrc`. Every surface that predates zines reads
 *      `src` as an image; swapping the two would hand PDF bytes to an <img>
 *      — or, server-side, to sharp.
 *   3. ONE PDF DEFINITION. The mint path and the collector-download path both
 *      accept a PDF and must agree byte-for-byte on what one is.
 *   4. ONE CAP. The zine byte cap IS the collector-file cap, so the two modes
 *      can never disagree, and every user-facing string derives from it.
 *   5. THE DOWNLOAD. The owned gateway walk accepts a PDF only when the first
 *      bytes say so, and names the zine in its copy.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *        scripts/verify-zine-media.ts
 */

import { PDF_EXT, PDF_MAGIC, PDF_MIME, hasPdfExt, hasPdfMagic } from '../lib/pdfFormat.ts'
import { CFILE_KIND_META, CFILE_MAX_BYTES, formatCfileSize } from '../lib/collectorFileTypes.ts'
import { detectCfileKind } from '../lib/collectorFileCore.ts'
import { resolveMomentMedia } from '../lib/media/resolveMomentMedia.ts'
import { isVideoMoment } from '../lib/media/isVideo.ts'
import { checkCoverImage, checkMintMedia } from '../lib/media/mintMedia.ts'
import {
  ZINE_COPY,
  ZINE_MAX_BYTES,
  ZINE_MAX_PAGES,
  ZINE_SOFT_WARN_BYTES,
  asPdfFile,
  formatZinePages,
  readZineHint,
  sniffPdfFile,
  zineMomentFields,
  type PdfInspector,
} from '../lib/media/zineMedia.ts'
import {
  GLB_EXPECTATION,
  ModelFetchError,
  PDF_EXPECTATION,
  describeModelFetchFailure,
  fetchMediaBlob,
  fetchModelBlob,
} from '../lib/media/modelFetch.ts'
import { GLB_MAGIC, GLB_MIME } from '../lib/glbFormat.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const PDF = 'ar://zine-txid'
const COVER = 'ar://cover-txid'

const pdfBytes = (size = 64): Uint8Array => {
  const b = new Uint8Array(size)
  b.set(PDF_MAGIC)
  b.set([0x31, 0x2e, 0x37], PDF_MAGIC.length) // "1.7"
  return b
}
const pdfFile = (name = 'issue-1.pdf', size = 64, type: string | undefined = PDF_MIME): File =>
  type === undefined ? new File([pdfBytes(size)], name) : new File([pdfBytes(size)], name, { type })

// ── 1. One PDF definition, shared by both features ──────────────────────────
check('pdfFormat: collector-file registry uses the shared MIME and extension',
  CFILE_KIND_META.pdf.mime === PDF_MIME && CFILE_KIND_META.pdf.ext === PDF_EXT)
check('pdfFormat: collector-file detector agrees with the shared magic',
  detectCfileKind(Buffer.from(pdfBytes())) === 'pdf')
check('pdfFormat: magic test rejects a near-miss',
  !hasPdfMagic(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00])))
check('pdfFormat: magic test rejects a too-short head',
  !hasPdfMagic(new Uint8Array([0x25, 0x50, 0x44])))
check('pdfFormat: extension test is case-insensitive and exact',
  hasPdfExt('Issue.PDF') && !hasPdfExt('issue.pdf.zip'))

// ── 2. One cap, and copy that derives from it ───────────────────────────────
check('caps: the page cap is 420', ZINE_MAX_PAGES === 420, String(ZINE_MAX_PAGES))
check('caps: the byte cap IS the collector-file cap', ZINE_MAX_BYTES === CFILE_MAX_BYTES)
check('caps: the soft warning sits below the hard cap', ZINE_SOFT_WARN_BYTES < ZINE_MAX_BYTES)
check('copy: the size rejection names the cap through formatCfileSize',
  ZINE_COPY.tooLarge(ZINE_MAX_BYTES + 1).includes(formatCfileSize(ZINE_MAX_BYTES)), ZINE_COPY.tooLarge(ZINE_MAX_BYTES + 1))
check('copy: the page rejection names the cap and the count',
  ZINE_COPY.tooManyPages(512).includes(String(ZINE_MAX_PAGES)) && ZINE_COPY.tooManyPages(512).includes('512'))
check('copy: the large-zine warning names the soft threshold',
  ZINE_COPY.largeWarning(ZINE_SOFT_WARN_BYTES + 1).includes(formatCfileSize(ZINE_SOFT_WARN_BYTES)))
check('copy: page counts pluralize', formatZinePages(1) === '1 page' && formatZinePages(16) === '16 pages')

// ── 3. The mint gate ────────────────────────────────────────────────────────
let inspectorCalls = 0
const inspector = (result: Awaited<ReturnType<PdfInspector>>): PdfInspector => async () => {
  inspectorCalls++
  return result
}
const ok16 = inspector({ kind: 'ok', pages: 16 })

const bare = await checkMintMedia(pdfFile())
check('gate: a PDF with no parser is refused (edit flow, stage frames)',
  !bare.ok && bare.reason === ZINE_COPY.notHere, JSON.stringify(bare))

const admitted = await checkMintMedia(pdfFile(), { inspectPdf: ok16 })
check('gate: a PDF with a parser is admitted AS A ZINE with its page count',
  admitted.ok && admitted.kind === 'pdf' && admitted.pages === 16, JSON.stringify(admitted))

const typeless = await checkMintMedia(pdfFile('scan.bin', 64, undefined), { inspectPdf: ok16 })
check('gate: a typeless file with the PDF magic is still a zine (bytes, not File.type)',
  typeless.ok && typeless.kind === 'pdf', JSON.stringify(typeless))

const renamed = await checkMintMedia(new File([new TextEncoder().encode('hello world')], 'notes.pdf', { type: PDF_MIME }), { inspectPdf: ok16 })
check('gate: a non-PDF named .pdf with a PDF File.type is REJECTED (magic decides)',
  !renamed.ok, JSON.stringify(renamed))

inspectorCalls = 0
const tooBig = await checkMintMedia(pdfFile('big.pdf', ZINE_MAX_BYTES + 1), { inspectPdf: ok16 })
check('gate: over the byte cap is rejected with the cap copy, BEFORE the parser runs',
  !tooBig.ok && tooBig.reason === ZINE_COPY.tooLarge(ZINE_MAX_BYTES + 1) && inspectorCalls === 0, JSON.stringify(tooBig))

const atCap = await checkMintMedia(pdfFile('max.pdf', ZINE_MAX_BYTES), { inspectPdf: ok16 })
check('gate: exactly the byte cap is admitted', atCap.ok, JSON.stringify(atCap))

const tooMany = await checkMintMedia(pdfFile(), { inspectPdf: inspector({ kind: 'ok', pages: ZINE_MAX_PAGES + 1 }) })
check('gate: over the page cap is rejected with the cap copy',
  !tooMany.ok && tooMany.reason === ZINE_COPY.tooManyPages(ZINE_MAX_PAGES + 1), JSON.stringify(tooMany))

const atPageCap = await checkMintMedia(pdfFile(), { inspectPdf: inspector({ kind: 'ok', pages: ZINE_MAX_PAGES }) })
check('gate: exactly the page cap is admitted', atPageCap.ok && atPageCap.kind === 'pdf' && atPageCap.pages === ZINE_MAX_PAGES)

const onePage = await checkMintMedia(pdfFile(), { inspectPdf: inspector({ kind: 'ok', pages: 1 }) })
check('gate: a one-page PDF is a zine (the page is the cover)', onePage.ok && onePage.kind === 'pdf' && onePage.pages === 1)

const locked = await checkMintMedia(pdfFile(), { inspectPdf: inspector({ kind: 'password' }) })
check('gate: a password-protected PDF is refused with its own copy',
  !locked.ok && locked.reason === ZINE_COPY.password, JSON.stringify(locked))

const broken = await checkMintMedia(pdfFile(), { inspectPdf: inspector({ kind: 'unreadable' }) })
check('gate: an unreadable PDF is refused with its own copy',
  !broken.ok && broken.reason === ZINE_COPY.unreadable, JSON.stringify(broken))

const zeroPages = await checkMintMedia(pdfFile(), { inspectPdf: inspector({ kind: 'ok', pages: 0 }) })
check('gate: a zero-page PDF is unreadable', !zeroPages.ok && zeroPages.reason === ZINE_COPY.unreadable)

const throwing = await checkMintMedia(pdfFile(), { inspectPdf: async () => { throw new Error('boom') } })
check('gate: a parser that throws is an unreadable PDF, not an uncaught error',
  !throwing.ok && throwing.reason === ZINE_COPY.unreadable, JSON.stringify(throwing))

const cover = await checkCoverImage(pdfFile())
check('cover gate: a PDF is never a cover', !cover.ok)

const kindOf = async (f: File) => {
  const v = await checkMintMedia(f, { inspectPdf: ok16 })
  return v.ok ? v.kind : 'rejected'
}
check('gate: the other kinds are unaffected',
  (await kindOf(new File([new Uint8Array(4)], 'a.png', { type: 'image/png' }))) === 'image' &&
    (await kindOf(new File([new Uint8Array(4)], 'a.mp4', { type: 'video/mp4' }))) === 'video')
const glb = new Uint8Array(64)
glb.set(GLB_MAGIC)
new DataView(glb.buffer).setUint32(4, 2, true)
new DataView(glb.buffer).setUint32(8, 64, true)
const glbVerdict = await checkMintMedia(new File([glb], 'cube.glb'), { inspectPdf: ok16 })
check('gate: a GLB is still a model with the parser present', glbVerdict.ok && glbVerdict.kind === 'model')
check('gate: the generic rejection names the zine',
  (await checkMintMedia(new File([new Uint8Array([1, 2, 3, 4])], 'x.bin'), { inspectPdf: ok16 }) as { reason?: string }).reason?.includes('PDF zine') === true)

check('sniff: the magic sniff reads bytes, never the name',
  (await sniffPdfFile(pdfFile('anything.dat', 64, undefined))) && !(await sniffPdfFile(new File([new Uint8Array([1, 2, 3, 4, 5, 6])], 'x.pdf'))))
check('sniff: a file shorter than the magic is not a PDF', !(await sniffPdfFile(new File([new Uint8Array([0x25])], 'x.pdf'))))
const wrapped = asPdfFile(pdfFile('scan.bin', 64, undefined))
check('asPdfFile: a typeless PDF is re-wrapped with the real MIME, same name and bytes',
  wrapped.type === PDF_MIME && wrapped.name === 'scan.bin' && wrapped.size === 64)
const already = pdfFile()
check('asPdfFile: an already-typed PDF is returned as is', asPdfFile(already) === already)

// ── 4. Classification + the fail-safe shape ────────────────────────────────
const built = zineMomentFields({ pdfUri: PDF, coverUri: COVER, pages: 16, thumbhash: 'th' })
check('builder: zineMomentFields writes the video/3D shape plus the hint',
  built.image === COVER && built.animation_url === PDF && built.content.uri === PDF && built.content.mime === PDF_MIME &&
    built.kismet_zine.pages === 16 && built.kismet_zine.access === 'public' && built.kismet_thumbhash === 'th')
check('builder: no thumbhash, no key', !('kismet_thumbhash' in zineMomentFields({ pdfUri: PDF, coverUri: COVER, pages: 2 })))
const r = resolveMomentMedia(built)
check('resolve: a Kismet zine classifies as `pdf`', r.kind === 'pdf', r.kind)
check('resolve: pdfSrc is the PDF', r.pdfSrc === PDF, String(r.pdfSrc))
// THE fail-safe invariant. Swapping these is what would feed PDF bytes to an
// <img> on every surface that predates zines.
check('resolve: src is the COVER, never the PDF', r.src === COVER, String(r.src))
check('resolve: the page count rides from the hint', r.pages === 16, String(r.pages))
check('isVideo: a zine is never a video', !isVideoMoment(built))

// The feed-row shape that lost its `content` (VIDEO_PLAYBACK_RCA.md): the
// hint keeps it a zine instead of a doomed video attempt.
const hintOnly = resolveMomentMedia({ image: COVER, animation_url: PDF, kismet_zine: { pages: 16, access: 'public' } })
check('resolve: hint + animation_url with no content is still a zine', hintOnly.kind === 'pdf' && hintOnly.pdfSrc === PDF && hintOnly.src === COVER, hintOnly.kind)
const noHint = resolveMomentMedia({ image: COVER, animation_url: PDF })
check('resolve: no mime, no extension, no hint → the ambiguous branch (today’s video attempt), unchanged', noHint.kind === 'video')
const contradicted = resolveMomentMedia({ image: COVER, animation_url: 'ar://v', content: { uri: 'ar://v', mime: 'video/mp4' }, kismet_zine: { pages: 3, access: 'public' } })
check('resolve: a hint never overrides a contradicting mime', contradicted.kind === 'video')
const collectorsHint = resolveMomentMedia({ image: COVER, kismet_zine: { pages: 16, access: 'collectors' } })
check('resolve: a collectors-only zine is an image moment to the resolver (its pages are not in the metadata)',
  collectorsHint.kind === 'image' && collectorsHint.src === COVER)

const external = resolveMomentMedia({ image: 'https://x.test/c.jpg', animation_url: 'https://x.test/issue.pdf' })
check('resolve: an external .pdf animation_url classifies as `pdf`',
  external.kind === 'pdf' && external.pdfSrc === 'https://x.test/issue.pdf' && external.src === 'https://x.test/c.jpg', external.kind)
const zoraShape = resolveMomentMedia({ image: COVER, content: { uri: 'https://x.test/issue.pdf', mime: PDF_MIME } })
check('resolve: a content.uri PDF with the mime classifies as `pdf`', zoraShape.kind === 'pdf' && zoraShape.pdfSrc === 'https://x.test/issue.pdf')

const degenerate = resolveMomentMedia({ image: PDF, animation_url: PDF, content: { uri: PDF, mime: PDF_MIME } })
check('resolve: image === pdf is not passed off as a cover', degenerate.kind === 'pdf' && degenerate.src === undefined, String(degenerate.src))
const coverless = resolveMomentMedia({ animation_url: PDF, content: { uri: PDF, mime: PDF_MIME } })
check('resolve: a coverless zine still resolves with a pdfSrc', coverless.kind === 'pdf' && coverless.pdfSrc === PDF && coverless.src === undefined)
const badPages = resolveMomentMedia({ image: COVER, animation_url: PDF, content: { uri: PDF, mime: PDF_MIME }, kismet_zine: { pages: -4, access: 'public' } })
check('resolve: a nonsense page count in the hint is ignored', badPages.kind === 'pdf' && badPages.pages === undefined)

// Precedence must not be disturbed for the kinds that already worked.
check('resolve: video is unaffected',
  resolveMomentMedia({ image: COVER, animation_url: 'ar://v', content: { uri: 'ar://v', mime: 'video/mp4' } }).kind === 'video')
check('resolve: model is unaffected',
  resolveMomentMedia({ image: COVER, animation_url: 'ar://m', content: { uri: 'ar://m', mime: GLB_MIME } }).kind === 'model')
check('resolve: gif is unaffected', resolveMomentMedia({ image: 'ar://g.gif' }).kind === 'gif')
check('resolve: still image is unaffected', resolveMomentMedia({ image: COVER }).kind === 'image')
check('resolve: text is unaffected', resolveMomentMedia({ content: { uri: 'ar://t', mime: 'text/plain' } }).kind === 'text')
check('resolve: nothing renderable is still `none`', resolveMomentMedia({}).kind === 'none')

// ── 5. The hint reader (anyone can write token JSON) ───────────────────────
check('hint: a valid hint round-trips', JSON.stringify(readZineHint({ pages: 16, access: 'public' })) === JSON.stringify({ pages: 16, access: 'public' }))
check('hint: collectors access is valid', readZineHint({ pages: 1, access: 'collectors' })?.access === 'collectors')
check('hint: garbage is undefined',
  readZineHint(null) === undefined && readZineHint('x') === undefined && readZineHint({ pages: '16', access: 'public' }) === undefined &&
    readZineHint({ pages: 0, access: 'public' }) === undefined && readZineHint({ pages: 2.5, access: 'public' }) === undefined &&
    readZineHint({ pages: 16, access: 'everyone' }) === undefined)

// ── 6. The owned download accepts a zine by its bytes ───────────────────────
const respond = (bytes: Uint8Array, type: string) => async () =>
  new Response(new Blob([bytes as BlobPart]), { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } })
const zineBlob = await fetchMediaBlob(['https://g.test/z'], { expect: PDF_EXPECTATION, fetchImpl: respond(pdfBytes(10_000), 'application/pdf') })
check('fetch: a PDF body downloads whole and is typed application/pdf', zineBlob.size === 10_000 && zineBlob.type === PDF_MIME)
let htmlErr: unknown
try {
  await fetchMediaBlob(['https://g.test/z'], { expect: PDF_EXPECTATION, fetchImpl: respond(new TextEncoder().encode('<!doctype html><html>'), 'text/html') })
} catch (e) { htmlErr = e }
check('fetch: an HTML landing page is refused on its first bytes and the copy names the zine',
  htmlErr instanceof ModelFetchError && htmlErr.attempts[0]?.failure.kind === 'not-glb' && htmlErr.message.includes('zine'), String((htmlErr as Error)?.message))
let glbAsPdf: unknown
try {
  await fetchMediaBlob(['https://g.test/z'], { expect: PDF_EXPECTATION, fetchImpl: respond(glb, GLB_MIME) })
} catch (e) { glbAsPdf = e }
check('fetch: a GLB is not a zine', glbAsPdf instanceof ModelFetchError)
const modelBlob = await fetchModelBlob(['https://g.test/m'], { fetchImpl: respond(glb, GLB_MIME) })
check('fetch: the 3D path is unchanged (GLB in, model/gltf-binary out)', modelBlob.size === 64 && modelBlob.type === GLB_MIME)
check('fetch: the 3D copy still says "3D model"',
  describeModelFetchFailure([{ url: 'u', failure: { kind: 'stall' } }]).includes(GLB_EXPECTATION.label) &&
    describeModelFetchFailure([{ url: 'u', failure: { kind: 'too-large', bytes: 1 } }], PDF_EXPECTATION.label).includes('zine'))

console.log(failures === 0 ? '\nverify-zine-media: all checks passed' : `\nverify-zine-media: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
