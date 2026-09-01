import { formatCfileSize } from '@/lib/collectorFileTypes'
import { MODEL_MAX_BYTES, isGlbFile } from './modelMedia'

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
 * Browsers derive `File.type` from a system MIME table that is not
 * guaranteed to be populated — `.mov`, `.heic` and files arriving from
 * archives or some Android pickers can all present as `''` — and those
 * uploads worked before this gate existed. Keeping them working matters
 * more than the tiny amount of strictness lost: the gate's job is to stop
 * a `.glb`/`.zip`/`.pdf` from silently minting as an image, not to police
 * container formats the pipeline already tolerates.
 */
const MEDIA_EXT =
  /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|hei[cf]|ico|apng|svg|mp4|webm|mov|m4v|ogv|mkv|avi|mpe?g|3gp)$/

export async function checkMintMedia(file: File): Promise<MintMediaVerdict> {
  const type = file.type.toLowerCase()
  if (type.startsWith('image/')) return { ok: true, kind: 'image' }
  if (type.startsWith('video/')) return { ok: true, kind: 'video' }

  // Magic bytes, never the extension or the (absent) MIME — the same
  // discipline the collector-file detector uses, sharing its signature.
  if (await isGlbFile(file)) {
    if (file.size > MODEL_MAX_BYTES) {
      return {
        ok: false,
        reason: `3D models are capped at ${formatCfileSize(MODEL_MAX_BYTES)} — this one is ${formatCfileSize(file.size)}`,
      }
    }
    return { ok: true, kind: 'model' }
  }

  // Typeless-but-plausible media (see MEDIA_EXT). Checked AFTER the GLB
  // sniff so a mislabeled model is still identified by its bytes.
  if (MEDIA_EXT.test(file.name.toLowerCase())) {
    return { ok: true, kind: file.name.toLowerCase().match(/\.(mp4|webm|mov|m4v|ogv|mkv|avi|mpe?g|3gp)$/) ? 'video' : 'image' }
  }

  return { ok: false, reason: 'Use an image, video, gif, or a .glb 3D model' }
}

/**
 * Gate for the artwork EDIT flow's media-replace picker.
 *
 * Identical to checkMintMedia except that a model is refused, because that
 * path cannot express one: its non-video branch uploads the picked file and
 * writes the returned URI straight into `image` (MomentDetailView's save),
 * which for a GLB is precisely the broken-artwork outcome checkMintMedia
 * exists to prevent. Refusing with a reason beats silently breaking an
 * artwork that currently works — swapping 3D in would need the same
 * poster-capture step the mint form has.
 */
export async function checkReplaceMedia(file: File): Promise<MintMediaVerdict> {
  const verdict = await checkMintMedia(file)
  if (verdict.ok && verdict.kind === 'model') {
    return { ok: false, reason: 'A 3D model can only be set when the artwork is first minted' }
  }
  return verdict
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
