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
 * Backdrops an artist can mint a 3D moment on.
 *
 * This is an AUTHORED decision, not a theme detail, which is why it is stored
 * with the artwork rather than derived from the site's palette: a model shot
 * on white reads as a product/gallery photograph, the same one on the site's
 * near-black reads as an object floating in the page. Both are legitimate and
 * the artist picks.
 *
 * It has to be recorded because THREE things must agree — the mint preview,
 * the JPEG captured from it (JPEG has no alpha, so the backdrop is baked in
 * permanently), and the live viewer on the artwork page. If the viewer just
 * rendered transparent over the page, tapping "view in 3D" would swap a white
 * still for a model on black, which reads as a bug rather than a choice.
 */
/** `id` is PERSISTED (it ships in `metadata.kismet_bg` and is permanent);
 *  `label` is UI copy. They read identically today, and are kept apart on
 *  purpose so renaming what the swatch says can never rewrite what is stored
 *  with somebody's artwork. */
export const MODEL_BACKGROUNDS = [
  { id: 'white', label: 'white', css: '#ffffff' },
  { id: 'dark', label: 'dark', css: '#111111' },
] as const

export type ModelBackgroundId = (typeof MODEL_BACKGROUNDS)[number]['id']

/** Default for a new 3D mint. White: a model on white is the neutral
 *  product-shot presentation, and it is what reads as intentional on a share
 *  card or an embed, where the surrounding surface is not ours to control. */
export const DEFAULT_MODEL_BACKGROUND: ModelBackgroundId = 'white'

/**
 * Resolve a stored `kismet_bg` to a CSS color. Unknown or absent values fall
 * back to the DEFAULT rather than to transparent, so a moment minted before
 * this field existed still renders its viewer on the same backdrop its baked
 * poster was captured on.
 */
export function modelBackgroundCss(id: string | undefined): string {
  // Resolved through DEFAULT_MODEL_BACKGROUND, not MODEL_BACKGROUNDS[0]:
  // those happen to be the same entry today, and indexing would let a
  // reordering of the array silently change the fallback while this
  // function's contract still claimed "the default".
  const fallback = MODEL_BACKGROUNDS.find((b) => b.id === DEFAULT_MODEL_BACKGROUND)!
  return (MODEL_BACKGROUNDS.find((b) => b.id === id) ?? fallback).css
}

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
