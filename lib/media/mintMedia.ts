import { formatCfileSize } from '@/lib/collectorFileTypes'
import { MODEL_MAX_BYTES, inspectGlbFile } from './modelMedia'

/**
 * The mint form's MEDIA gate: the one place that decides whether a picked
 * file may become a moment's primary media, and what kind it is.
 *
 * This exists because there was no gate. `<input accept="image/*,video/*">`
 * filters only the OS picker dialog and DRAG-AND-DROP IGNORES IT, so any
 * file at all reached the form. A dropped `.glb` (whose `File.type` is `''`
 * — the extension has no registered browser MIME) rendered as a broken
 * <img>, and, if the artist carried on, minted with the model's URI written
 * into `metadata.image`: a permanently broken artwork with Arweave credits
 * spent and nothing to roll back. Rejecting at pick time is the only place
 * that failure can be stopped cheaply.
 *
 * The `kind` in a successful verdict is also the ONLY authority on "is this
 * pick a model" — a GLB has no positive `File.type` to re-test later, so
 * callers must remember the verdict rather than try to re-derive it.
 */

export type MintMediaVerdict =
  | { ok: true; kind: 'image' | 'video' | 'model' }
  | { ok: false; reason: string }

/**
 * Extension fallback for files the OS hands over with an empty `File.type`.
 * Split by kind rather than one combined pattern with a second video test
 * layered on top: the video list would otherwise appear twice and drift.
 * Browsers derive `File.type` from a system MIME table that is not
 * guaranteed to be populated — `.mov`, `.heic` and files arriving from
 * archives or some Android pickers can all present as `''` — and those
 * uploads worked before this gate existed. Keeping them working matters
 * more than the tiny amount of strictness lost: the gate's job is to stop
 * a `.glb`/`.zip`/`.pdf` from silently minting as an image, not to police
 * container formats the pipeline already tolerates.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|hei[cf]|ico|apng|svg)$/
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|mkv|avi|mpe?g|3gp)$/

export async function checkMintMedia(file: File): Promise<MintMediaVerdict> {
  const type = file.type.toLowerCase()
  if (type.startsWith('image/')) return { ok: true, kind: 'image' }
  if (type.startsWith('video/')) return { ok: true, kind: 'video' }

  // Magic bytes, never the extension or the (absent) MIME — the same
  // discipline the collector-file detector uses, sharing its signature.
  const glb = await inspectGlbFile(file)
  if (glb !== 'no') {
    if (file.size > MODEL_MAX_BYTES) {
      return {
        ok: false,
        reason: `3D models are capped at ${formatCfileSize(MODEL_MAX_BYTES)} — this one is ${formatCfileSize(file.size)}`,
      }
    }
    // It calls itself a GLB; is it one we can expect to render? Rejected here
    // rather than left to the viewer because a mint is irreversible and paid
    // for — a truncated export should cost a toast, not an artwork.
    if (glb === 'malformed') {
      return {
        ok: false,
        reason: 'This .glb looks incomplete or is an older glTF version — re-export it as glTF 2.0 binary',
      }
    }
    return { ok: true, kind: 'model' }
  }

  // Typeless-but-plausible media (see VIDEO_EXT / IMAGE_EXT). Checked AFTER
  // the GLB sniff so a mislabeled model is still identified by its bytes.
  const name = file.name.toLowerCase()
  if (VIDEO_EXT.test(name)) return { ok: true, kind: 'video' }
  if (IMAGE_EXT.test(name)) return { ok: true, kind: 'image' }

  return { ok: false, reason: 'Use an image, video, gif, or a .glb 3D model' }
}

/**
 * Gate for cover / poster pickers (the edit flow's "change cover", collection
 * covers). A cover is rendered as a still everywhere it appears, so video and
 * 3D are both refused rather than uploaded into an <img> slot.
 */
export async function checkCoverImage(file: File): Promise<MintMediaVerdict> {
  const verdict = await checkMintMedia(file)
  if (verdict.ok && verdict.kind !== 'image') {
    return { ok: false, reason: 'Use a still image or a gif for the cover' }
  }
  return verdict
}
