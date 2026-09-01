import { GLB_HEADER_BYTES, GLB_MIME, hasGlbMagic, isWellFormedGlbHeader } from '@/lib/glbFormat'

/**
 * Primary-media helpers for 3D moments (GLB / Binary glTF), the mint-side
 * counterpart to lib/media/extractPoster for video. See
 * GLB_3D_VIEWER_DESIGN.md.
 *
 * A 3D moment is minted with the SAME metadata shape as a video moment —
 * `image` (a captured still), `animation_url` (the GLB) and
 * `content.mime` — so every static surface (feed cards, OG cards, Farcaster
 * embeds, covers, thumbhash) keeps working with no knowledge of 3D. Only
 * the artwork detail view mounts a real viewer.
 */

/**
 * Hard ceiling for a mintable model. The mint form's global cap is 420 MB,
 * sized for video; a GLB is a very different animal because it is not
 * streamed — the whole file is downloaded, parsed into CPU-side buffers and
 * then uploaded to the GPU, so peak memory is roughly 2x the file plus
 * textures. COLLECTOR_DOWNLOADS_DESIGN.md already recorded the same tension
 * for collector files (risk #10: "practical mobile ceiling is nearer
 * 5-10 MB") and PUBLIC media is the worse exposure — a collector file is
 * opened by a holder who chose to, an artwork page by anyone who taps a feed
 * card, disproportionately inside the iOS Mini App webview where this
 * codebase has already eaten OOM crashes from animated GIFs holding
 * decoders (see MomentCard).
 *
 * 30 MB is deliberately generous for desktop while staying an order of
 * magnitude below the video cap; the soft warning below is what actually
 * steers artists toward models that work on a phone.
 */
export const MODEL_MAX_BYTES = 30 * 1024 * 1024

/** Above this, warn (but allow) — the size where a low-end phone in the
 *  Mini App webview starts to be a real risk rather than a theoretical one. */
export const MODEL_SOFT_WARN_BYTES = 8 * 1024 * 1024

/**
 * Three-way verdict, from ONE read of the file's first 12 bytes:
 *
 *   'no'        — not a GLB; the caller should go on classifying it
 *   'malformed' — claims to be one, but not one we can expect to render
 *   'ok'        — a glTF 2.0 binary whose header agrees with its byte count
 *
 * Three-way rather than two predicates because "is it a model?" and "will it
 * render?" are always asked together, and answering them separately meant
 * reading the file twice to reach one decision.
 *
 * Magic bytes decide the first question — neither cheap signal is
 * trustworthy. `.glb` has no registered browser MIME, so `File.type` is `''`
 * for a real GLB (exactly how a dropped model used to slip through the mint
 * form's `accept` filter and mint as a broken `image:`), and the extension is
 * whatever the file happened to be named.
 */
export type GlbVerdict = 'no' | 'malformed' | 'ok'

export async function inspectGlbFile(file: File): Promise<GlbVerdict> {
  let head: Uint8Array
  try {
    head = new Uint8Array(await file.slice(0, GLB_HEADER_BYTES).arrayBuffer())
  } catch {
    return 'no'
  }
  if (!hasGlbMagic(head)) return 'no'
  return isWellFormedGlbHeader(head, file.size) ? 'ok' : 'malformed'
}

/**
 * Re-wrap a GLB with its real MIME before upload.
 *
 * lib/arweave/uploadFile tags the Arweave data item with
 * `file.type || 'application/octet-stream'`, and a browser hands us `''` for
 * a `.glb` — so without this the model would be stored (and served by the
 * gateway) as octet-stream. The same `.type` is what the mint form's
 * animation binding and the resume path's persisted `mediaType` key off, so
 * this one re-wrap is what makes a model behave like a video end-to-end.
 */
export function asGlbFile(file: File): File {
  return file.type === GLB_MIME
    ? file
    : new File([file], file.name, { type: GLB_MIME, lastModified: file.lastModified })
}
