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
 * TWO colours per option, because the thumbnail and the live viewer are
 * genuinely different contexts and the artist asked for them to differ:
 *
 *   - `poster` is baked into the captured JPEG, which travels to feed cards,
 *     OG cards and Farcaster embeds — surfaces whose surrounding colour is
 *     not ours to control. It must be OPAQUE (JPEG has no alpha) and white is
 *     the neutral product-shot default the NFT world already reads that way.
 *   - `viewer` is the live element on the artwork page, which sits inside our
 *     own dark surface. `transparent` lets a model sit IN the page rather
 *     than in a box, which suits some models and not others.
 *
 * Collapsing the two would force the choice: coupling them means a white
 * thumbnail implies a white viewer. The third option exists precisely because
 * an artist can want the shared image white and the in-app view open, and
 * the cost is that promoting to 3D crossfades the backdrop — deliberate, and
 * only on the option that asks for it.
 *
 * `id` is PERSISTED (it ships in `metadata.kismet_bg` and is permanent);
 * `label` is UI copy and `swatch` is the picker dot. They are kept apart on
 * purpose so renaming what a swatch says can never rewrite what is stored
 * with somebody's artwork.
 */
export const MODEL_BACKGROUNDS = [
  { id: 'white', label: 'white', poster: '#ffffff', viewer: '#ffffff', swatch: '#ffffff' },
  { id: 'dark', label: 'dark', poster: '#111111', viewer: '#111111', swatch: '#111111' },
  {
    id: 'transparent',
    label: 'white thumbnail, transparent in app',
    poster: '#ffffff',
    viewer: 'transparent',
    // The universal transparency checker, so the dot reads as "no backdrop"
    // rather than as some third colour.
    swatch: 'repeating-conic-gradient(#ffffff 0% 25%, #9a9a9a 0% 50%) 0 0 / 8px 8px',
  },
] as const

export type ModelBackgroundId = (typeof MODEL_BACKGROUNDS)[number]['id']

/** Default for a new 3D mint. White: a model on white is the neutral
 *  product-shot presentation, and it is what reads as intentional on a share
 *  card or an embed, where the surrounding surface is not ours to control. */
export const DEFAULT_MODEL_BACKGROUND: ModelBackgroundId = 'white'

function entry(id: string | undefined) {
  // Resolved through DEFAULT_MODEL_BACKGROUND, not MODEL_BACKGROUNDS[0]:
  // those happen to be the same entry today, and indexing would let a
  // reordering of the array silently change the fallback while these
  // functions' contracts still claimed "the default".
  const fallback = MODEL_BACKGROUNDS.find((b) => b.id === DEFAULT_MODEL_BACKGROUND)!
  return MODEL_BACKGROUNDS.find((b) => b.id === id) ?? fallback
}

/** Opaque colour baked into the captured poster. Never `transparent` — a
 *  JPEG has no alpha, and this image ships to surfaces we do not control. */
export function modelPosterBg(id: string | undefined): string {
  return entry(id).poster
}

/** Colour for the live viewer on the artwork page. May be `transparent`, in
 *  which case the model sits directly on the page surface. */
export function modelViewerBg(id: string | undefined): string {
  return entry(id).viewer
}

export function isModelBackgroundId(id: unknown): id is ModelBackgroundId {
  return typeof id === 'string' && MODEL_BACKGROUNDS.some((b) => b.id === id)
}

/**
 * The metadata fields that make a moment a 3D moment: the video shape with
 * the GLB where the MP4 would be, plus the backdrop the still was shot on.
 *
 * ONE definition for the three producers — the mint form, the edit flow and
 * the agent mint — so no path can write a model whose shape drifts from what
 * resolveMomentMedia classifies. `image` is the captured still, and every
 * static surface renders exactly that; only the artwork page ever reads
 * `animation_url`. The poster is therefore not optional: a posterless 3D
 * moment is invisible on every surface but one.
 */
export function modelMomentFields(input: {
  modelUri: string
  posterUri: string
  thumbhash?: string
  /** A MODEL_BACKGROUNDS id; anything else resolves to the default. */
  background?: string
}) {
  return {
    image: input.posterUri,
    animation_url: input.modelUri,
    content: { uri: input.modelUri, mime: GLB_MIME },
    ...(input.thumbhash ? { kismet_thumbhash: input.thumbhash } : {}),
    kismet_bg: entry(input.background).id,
  }
}

/**
 * Contact-shadow strength for every 3D surface.
 *
 * model-viewer ships `shadow-intensity` at **0** — no shadow whatsoever —
 * which is why an untextured model reads as a flat silhouette, worst of all
 * on the white backdrop that is now the default. A grounding shadow is the
 * standard fix and it lands in the captured poster too, since the shadow is
 * part of the rendered scene rather than a DOM layer.
 */
export const MODEL_SHADOW_INTENSITY = '1'

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
