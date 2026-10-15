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

import { PDF_EXT, PDF_MAGIC, PDF_MIME, hasPdfMagic } from '../lib/pdfFormat.ts'
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
import { writeImagePdf } from '../lib/media/optimizePdf.ts'
import { canResumeUpload, resumeNeedsPoster } from '../lib/media/mintResume.ts'

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
check('cover gate: a PDF gets the cover slot’s own copy, not the zine’s', !cover.ok && cover.reason === 'Use a still image or a gif for the cover')

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
const built = zineMomentFields({ access: 'public', pdfUri: PDF, coverUri: COVER, pages: 16, thumbhash: 'th' })
check('builder: zineMomentFields writes the video/3D shape plus the hint',
  built.image === COVER && built.animation_url === PDF && built.content?.uri === PDF && built.content?.mime === PDF_MIME &&
    built.kismet_zine.pages === 16 && built.kismet_zine.access === 'public' && built.kismet_thumbhash === 'th')
check('builder: no thumbhash, no key', !('kismet_thumbhash' in zineMomentFields({ access: 'public', pdfUri: PDF, coverUri: COVER, pages: 2 })))
// Collectors-only: an image moment plus the hint — no animation_url, no
// content, so every resolver and marketplace sees a still (§8.2).
const privateBuilt = zineMomentFields({ access: 'collectors', coverUri: COVER, pages: 16, thumbhash: 'th' })
check('builder: a collectors-only zine is the cover plus the hint, nothing else',
  privateBuilt.image === COVER && !('animation_url' in privateBuilt) && !('content' in privateBuilt) &&
    privateBuilt.kismet_zine.access === 'collectors' && privateBuilt.kismet_zine.pages === 16 && privateBuilt.kismet_thumbhash === 'th')
check('builder: a collectors-only zine resolves as an image with the cover as src',
  resolveMomentMedia(privateBuilt).kind === 'image' && resolveMomentMedia(privateBuilt).src === COVER)
check('builder: the hint of a collectors-only zine reads back', readZineHint(privateBuilt.kismet_zine)?.access === 'collectors')
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

// ── 7. The optimizer's PDF writer (lib/media/optimizePdf) ──────────────────
// Fed fixture "JPEGs" (the SOI marker is all a structural check needs), the
// writer must produce a file the collector-file detector calls a pdf, with
// the page count it was given, one image per page, and a valid xref.
const fakeJpeg = (n: number) => {
  const b = new Uint8Array(64 + n)
  b.set([0xff, 0xd8, 0xff, 0xe0])
  b.set([0xff, 0xd9], b.length - 2)
  return b
}
const rasters = [1, 2, 3].map((n) => ({ jpeg: fakeJpeg(n), pixelWidth: 1414, pixelHeight: 2000, widthPt: 595.2, heightPt: 841.68 }))
const written = writeImagePdf(rasters, { title: 'Issue (0) \\ test' })
const writtenText = new TextDecoder('latin1').decode(written)
check('writer: the output is a PDF by magic', hasPdfMagic(written) && detectCfileKind(Buffer.from(written)) === 'pdf')
check('writer: the page tree counts every page', /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 3 >>/.test(writtenText))
check('writer: one DCT image per page, at the pixel size rendered',
  (writtenText.match(/\/Filter \/DCTDecode/g) ?? []).length === 3 && writtenText.includes('/Width 1414 /Height 2000'))
check('writer: pages keep their size in points', writtenText.includes('/MediaBox [0 0 595.20 841.68]'))
check('writer: the title is escaped into the Info dictionary', writtenText.includes('/Title (Issue \\(0\\) \\\\ test)'))
check('writer: every image stream declares its exact byte length', [65, 66, 67].every((n) => writtenText.includes(`/Length ${n} >>`)))
check('writer: the trailer counts every object plus the free head', writtenText.includes('/Size 13'))
check('writer: xref entries are exactly 20 bytes, free head included',
  [...writtenText.matchAll(/^\d{10} \d{5} [nf] ?\r?\n/gm)].length === 13 &&
    [...writtenText.matchAll(/^\d{10} \d{5} [nf] ?\r?\n/gm)].every((m) => m[0].length === 20))
{
  const t = new TextDecoder('latin1').decode(writeImagePdf(rasters.slice(0, 1), { title: 'Café №1' }))
  check('writer: a non-ASCII title is a UTF-16BE hex string, not stripped', /\/Title <FEFF00430061006600e9002021160031>/i.test(t))
}
{
  const m = /startxref\n(\d+)\n%%EOF/.exec(writtenText)
  const at = m ? Number(m[1]) : -1
  check('writer: startxref points at the xref table', at > 0 && writtenText.slice(at, at + 4) === 'xref', String(at))
  // Every xref offset must land on "<n> 0 obj".
  const offsets = [...writtenText.matchAll(/^(\d{10}) 00000 n /gm)].map((x) => Number(x[1]))
  check('writer: every xref offset lands on its object',
    offsets.length === 12 && offsets.every((o, i) => writtenText.slice(o, o + `${i + 1} 0 obj`.length) === `${i + 1} 0 obj`), String(offsets.length))
}


// ── 8. The mint form's resume decisions ───────────────────────────────────
{
  const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'issue.pdf', { type: PDF_MIME })
  const coverA = new File([new Uint8Array(3)], 'a.jpg', { type: 'image/jpeg' })
  const coverB = new File([new Uint8Array(3)], 'b.jpg', { type: 'image/jpeg' })
  const glb = new File([new Uint8Array(4)], 'm.glb', { type: 'model/gltf-binary' })
  const banked = (mediaFile: File, coverSource: File | null, verifyFailures = 0) => ({ source: pdf, mediaFile, coverSource, verifyFailures })
  const publicPick = { isZine: true, access: 'public' as const, cover: coverA }
  const collectorsPick = { isZine: true, access: 'collectors' as const, cover: coverA }
  check('resume: a public zine resumes a session that banked the PDF', canResumeUpload(banked(pdf, coverA), pdf, publicPick, 3))
  check('resume: a public zine never resumes a session banked under collectors (the cover as media)', !canResumeUpload(banked(coverA, coverA), pdf, publicPick, 3))
  check('resume: a collectors-only zine resumes a session that banked the cover', canResumeUpload(banked(coverA, coverA), pdf, collectorsPick, 3))
  check('resume: a collectors-only zine never resumes a session banked under public (the PDF as media)', !canResumeUpload(banked(pdf, coverA), pdf, collectorsPick, 3))
  check('resume: a cover changed since the banked attempt is a miss', !canResumeUpload(banked(pdf, coverA), pdf, { ...publicPick, cover: coverB }, 3))
  check('resume: an unknown banked cover (a reload) counts as a match', canResumeUpload(banked(pdf, null), pdf, { ...publicPick, cover: coverB }, 3))
  check('resume: a different pick is a miss', !canResumeUpload(banked(pdf, coverA), coverB, publicPick, 3))
  check('resume: a session given up on is a miss', !canResumeUpload(banked(pdf, coverA, 3), pdf, publicPick, 3))
  check('resume: no session, no resume', !canResumeUpload(null, pdf, publicPick, 3))
  check('resume: a non-zine pick ignores the zine rules', canResumeUpload({ source: glb, mediaFile: glb, coverSource: null, verifyFailures: 0 }, glb, { isZine: false, access: 'public', cover: null }, 3))
  check('resume: a banked PDF or model owes a poster', resumeNeedsPoster({ mediaFile: pdf }) && resumeNeedsPoster({ mediaFile: glb }))
  check('resume: a banked cover (a collectors-only zine’s media) owes none — it would be uploaded twice', !resumeNeedsPoster({ mediaFile: coverA }))
}

console.log(failures === 0 ? '\nverify-zine-media: all checks passed' : `\nverify-zine-media: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
