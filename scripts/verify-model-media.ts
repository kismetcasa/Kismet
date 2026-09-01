/**
 * 3D-moment oracle (GLB_3D_VIEWER_DESIGN.md) — run via `verify:flows`.
 *
 * Pins the invariants that would otherwise rot silently, because none of them
 * is visible in a passing typecheck and two of them are the difference
 * between a working artwork and a permanently broken one:
 *
 *   1. THE MINT GATE. `<input accept>` filters the OS picker only —
 *      drag-and-drop ignores it — so before checkMintMedia existed, a dropped
 *      .glb rendered as a broken <img> and, if the artist carried on, minted
 *      with the model's URI in `metadata.image`. Nothing on-chain can undo
 *      that. The gate is the fix; these assertions are what keep it.
 *   2. THE FAIL-SAFE SHAPE. `resolveMomentMedia` must put a model's STILL in
 *      `src` and the GLB in `modelSrc`. Every surface that predates 3D reads
 *      `src` as an image (MarketOvals, CustomizePanel, FeaturedMoment,
 *      PatronArtworkShowcase, the profile theme route feeding sharp), so the
 *      day someone swaps those two fields, a forgotten surface stops showing
 *      a static tile and starts feeding GLB bytes to an <img> — or to sharp.
 *   3. ONE GLB DEFINITION. The mint path and the collector-download path both
 *      accept .glb and must agree byte-for-byte on what one is.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *        scripts/verify-model-media.ts
 */

import { GLB_MAGIC, GLB_MIME, hasGlbMagic } from '../lib/glbFormat.ts'
import { CFILE_KIND_META } from '../lib/collectorFileTypes.ts'
import { detectCfileKind } from '../lib/collectorFileCore.ts'
import { resolveMomentMedia } from '../lib/media/resolveMomentMedia.ts'
import { isVideoMoment } from '../lib/media/isVideo.ts'
import { checkMintMedia } from '../lib/media/mintMedia.ts'
import { MODEL_MAX_BYTES, asGlbFile, isGlbFile } from '../lib/media/modelMedia.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const GLB = 'ar://model-txid'
const STILL = 'ar://poster-txid'

// Bytes that pass the magic test, padded past the sniff window.
const glbBytes = (size = 64): Uint8Array => {
  const b = new Uint8Array(size)
  b.set(GLB_MAGIC)
  return b
}
const glbFile = (name = 'sculpture.glb', size = 64): File =>
  // Deliberately NO type: browsers report '' for .glb (no registered MIME),
  // and every gate downstream has to cope with exactly that.
  new File([glbBytes(size)], name)

// ── 1. One GLB definition, shared by both features ─────────────────────────
check('glbFormat: collector-file registry uses the shared MIME',
  CFILE_KIND_META.glb.mime === GLB_MIME, CFILE_KIND_META.glb.mime)
check('glbFormat: collector-file detector agrees with the shared magic',
  detectCfileKind(Buffer.from(glbBytes())) === 'glb')
check('glbFormat: magic test rejects a near-miss',
  !hasGlbMagic(new Uint8Array([0x67, 0x6c, 0x54, 0x00])))
check('glbFormat: magic test rejects a too-short head',
  !hasGlbMagic(new Uint8Array([0x67, 0x6c, 0x54])))

// ── 2. The mint gate (the Phase 0 bug) ─────────────────────────────────────
const gate = async (f: File) => await checkMintMedia(f)

check('mint gate: images pass',
  (await gate(new File([new Uint8Array(4)], 'a.png', { type: 'image/png' }))).ok)
check('mint gate: videos pass',
  (await gate(new File([new Uint8Array(4)], 'a.mp4', { type: 'video/mp4' }))).ok)

const glbVerdict = await gate(glbFile())
check('mint gate: a typeless .glb is admitted AS A MODEL (not as an image)',
  glbVerdict.ok && glbVerdict.kind === 'model', JSON.stringify(glbVerdict))

// The regression that motivated the gate: these used to sail through and mint
// as `image: ar://<not-an-image>`.
const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'work.zip', { type: 'application/zip' })
check('mint gate: a zip is REJECTED (drag-and-drop bypasses input accept)', !(await gate(zip)).ok)
const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'doc.pdf', { type: 'application/pdf' })
check('mint gate: a pdf is REJECTED', !(await gate(pdf)).ok)
check('mint gate: a typeless non-media file is REJECTED',
  !(await gate(new File([new Uint8Array([1, 2, 3, 4])], 'notes.bin'))).ok)

// A model is identified by BYTES, so a mislabeled one is still a model and a
// liar named .glb is still rejected.
const misnamed = await gate(new File([glbBytes()], 'model.bin'))
check('mint gate: a GLB named .bin is still a model (magic, not extension)',
  misnamed.ok && misnamed.kind === 'model')
check('mint gate: a non-GLB named .glb is rejected',
  !(await gate(new File([new Uint8Array([1, 2, 3, 4])], 'fake.glb'))).ok)

check('mint gate: a GLB past MODEL_MAX_BYTES is rejected',
  !(await gate(glbFile('huge.glb', MODEL_MAX_BYTES + 1))).ok)
check('mint gate: a GLB at exactly MODEL_MAX_BYTES is allowed',
  (await gate(glbFile('big.glb', MODEL_MAX_BYTES))).ok)

// Typeless-but-plausible media keeps working — the gate must not regress the
// uploads that worked before it existed.
const mov = await gate(new File([new Uint8Array(4)], 'clip.mov'))
check('mint gate: a typeless .mov still passes, as video', mov.ok && mov.kind === 'video')

check('modelMedia: isGlbFile reads magic bytes', await isGlbFile(glbFile()))
check('modelMedia: asGlbFile stamps the real MIME (browsers give us "")',
  asGlbFile(glbFile()).type === GLB_MIME)

// ── 3. Classification + the fail-safe shape ────────────────────────────────
// The exact metadata MintForm writes for a 3D moment.
const minted = {
  image: STILL,
  animation_url: GLB,
  content: { uri: GLB, mime: GLB_MIME },
}
const r = resolveMomentMedia(minted)
check('resolve: a Kismet 3D mint classifies as `model`', r.kind === 'model', r.kind)
check('resolve: modelSrc is the GLB', r.modelSrc === GLB, String(r.modelSrc))
// THE fail-safe invariant. Swapping these is what would feed GLB bytes to an
// <img> on every surface that predates 3D.
check('resolve: src is the STILL, never the GLB', r.src === STILL, String(r.src))
check('isVideo: a 3D moment is never a video', !isVideoMoment(minted))

// Without the mime hint the ambiguous-animation_url branch would attempt this
// as a video (the VIDEO_PLAYBACK_RCA.md failure mode), so the extension has to
// carry it for external mints.
const external = resolveMomentMedia({ image: 'https://x.test/p.jpg', animation_url: 'https://x.test/m.glb' })
check('resolve: an external .glb animation_url classifies as `model`',
  external.kind === 'model' && external.modelSrc === 'https://x.test/m.glb', external.kind)
check('resolve: an external model still exposes its still as src',
  external.src === 'https://x.test/p.jpg', String(external.src))

// Degenerate legacy shape: the pre-gate mint bug wrote the media URI into
// `image`. Rendering that as an <img> is exactly the broken artwork; better to
// carry no still and let the thumbhash blur cover the slot.
const degenerate = resolveMomentMedia({ image: GLB, animation_url: GLB, content: { uri: GLB, mime: GLB_MIME } })
check('resolve: image === model is not passed off as a still',
  degenerate.kind === 'model' && degenerate.src === undefined, String(degenerate.src))

// A model with no still at all still resolves (the detail view can mount the
// viewer; every other surface falls back to the thumbhash).
const posterless = resolveMomentMedia({ animation_url: GLB, content: { uri: GLB, mime: GLB_MIME } })
check('resolve: a posterless model still resolves with a modelSrc',
  posterless.kind === 'model' && posterless.modelSrc === GLB && posterless.src === undefined)

// Precedence must not be disturbed for the kinds that already worked.
check('resolve: video is unaffected',
  resolveMomentMedia({ image: STILL, animation_url: 'ar://v', content: { uri: 'ar://v', mime: 'video/mp4' } }).kind === 'video')
check('resolve: gif is unaffected',
  resolveMomentMedia({ image: 'ar://g.gif' }).kind === 'gif')
check('resolve: still image is unaffected',
  resolveMomentMedia({ image: STILL }).kind === 'image')
check('resolve: text is unaffected',
  resolveMomentMedia({ content: { uri: 'ar://t', mime: 'text/plain' } }).kind === 'text')
check('resolve: nothing renderable is still `none`',
  resolveMomentMedia({}).kind === 'none')

console.log(
  failures === 0
    ? 'verify-model-media: all assertions passed'
    : `verify-model-media: ${failures} assertion(s) failed`,
)
process.exit(failures === 0 ? 0 : 1)
