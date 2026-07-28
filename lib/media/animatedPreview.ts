// Animated Farcaster embed thumbnails for video/gif moments.
//
// A Mini App embed card is ONE image + ONE button (the canonical schema —
// @farcaster/miniapp-core/dist/schemas/embeds.js — has no video field). The
// image URL is fetched and painted by the client, and animated GIF/WebP are
// listed embed formats, so the card MOVES when imageUrl points at an animated
// file. Our /opengraph-image route is Satori (next/og), which only ever emits
// a static PNG, so today every video/gif moment embeds a still frame.
//
// This module produces the animated counterpart: a short, silent, looping
// preview letterboxed to a 3:2 card, small enough for Farcaster's 10MB embed
// cap. It reuses the tooling the codebase already runs — native `ffmpeg`
// (Dockerfile installs it for /api/transcode-gif) and the imgVariantCache disk
// cache — and never does inline work on the crawler path beyond a cache read:
// the transcode is coalesced (SingleFlight), globally serialized (ffmpeg is
// heavy), source/size/time-capped, and any miss/failure degrades to the static
// card. Content is content-addressed (ar:///ipfs:// txid), so a preview
// computed once is valid forever.
//
// Wiring: generateMetadata points imageUrl at /moment/<a>/<id>/embed-preview
// only when the preview is already cached (else it keeps the static card and
// warms the preview for the next scrape — zero regression); the embed-preview
// route serves the cached bytes.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatewayUrls } from '@/lib/arweave/gateways'
import { readBodyBounded } from '@/lib/boundedBody'
import { readVariant, writeVariant, SingleFlight } from '@/lib/media/imgVariantCache'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'

const execFileAsync = promisify(execFile)

// Output format. Animated WebP is ~3-10x smaller than GIF at equal quality
// (validated: a high-motion 720p source → ~1.6MB WebP) and is a spec-listed
// embed format, so it's the default; GIF is the universally-animating fallback
// if a client won't animate WebP. Both encoders ship in the Alpine ffmpeg
// build. Flip with FARCASTER_PREVIEW_FORMAT=gif — old-format files simply miss
// the cache (keyed by extension) and age out via the LRU sweep.
const PREVIEW_FORMAT: 'webp' | 'gif' =
  process.env.FARCASTER_PREVIEW_FORMAT === 'gif' ? 'gif' : 'webp'
export const PREVIEW_CONTENT_TYPE = PREVIEW_FORMAT === 'gif' ? 'image/gif' : 'image/webp'

// Clip length + frame rate of the loop. 3s reads as motion (not a slideshow)
// while keeping even worst-case full-motion output well under the 10MB cap.
const CLIP_SECONDS = 3
// Skip a leading fade-from-black before sampling BOTH the loop and the still
// poster, so a video that opens on black doesn't embed a black card. We start
// just past where the black run that begins at t=0 ends (blackdetect), capped
// so we never seek deep into — or past the end of — a short clip. 0 = no
// leading black, or blackdetect unavailable = today's exact t=0 behavior.
const MAX_START_OFFSET_S = 2.5
// Representative still (JPEG) extracted at the same offset. The static OG
// share card (/opengraph-image) prefers it when a video moment's poster is a
// black fade-in frame. Longest edge; native aspect (no letterbox — it's a
// poster fed to Satori, not the 3:2 card itself).
const STILL_MAX_EDGE = 1200
// Card canvas = 3:2, Farcaster's default embed ratio (and our static card,
// lib/shareCard). Non-3:2 sources are letterboxed onto a dark #0a0a0a canvas,
// matching shareCard's backdrop. WebP rides a larger canvas than GIF (GIF's
// palette encode is heavier, so it stays smaller); both satisfy the 600x400
// min / 3000x2000 max.
const RECIPE = {
  webp: { fps: 15, w: 1200, h: 800 },
  gif: { fps: 12, w: 960, h: 640 },
} as const

// Kill a runaway encode rather than pin a CPU on the shared box. A 3s clip
// encodes in ~1-3s; generous headroom, and the caller treats a timeout as a
// normal miss (→ static card).
const FFMPEG_TIMEOUT_MS = 25_000

function buildFfmpegArgs(inPath: string, outPath: string, startOffset: number): string[] {
  const { fps, w, h } = RECIPE[PREVIEW_FORMAT]
  const pad =
    `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0a0a0a`
  // -ss BEFORE -i: fast input seeking. Keyframe-snapping is fine for a preview,
  // and it means we decode from the offset rather than from 0.
  const seek = startOffset > 0 ? ['-ss', startOffset.toFixed(3)] : []
  const head = ['-y', '-loglevel', 'error', ...seek, '-i', inPath, '-t', String(CLIP_SECONDS)]
  if (PREVIEW_FORMAT === 'gif') {
    // Single-pass palette: split → generate a palette from the stream →
    // apply it, so a 256-colour GIF isn't a muddy web-safe reduction.
    return [...head, '-vf', `${pad},split[a][b];[a]palettegen[p];[b][p]paletteuse`, '-loop', '0', outPath]
  }
  return [...head, '-vf', pad, '-c:v', 'libwebp', '-q:v', '60', '-loop', '0', '-an', outPath]
}

// One representative JPEG frame at the same offset, for the static OG card.
// Native aspect, downscaled to fit STILL_MAX_EDGE; -q:v 3 is high quality.
// -ss AFTER -i (output seeking): frame-accurate for a single still, so it can't
// keyframe-snap backward into the fade the way input seeking might on a
// sparse-keyframe source. The decode-from-0 cost is trivial for one frame at a
// ≤2.5s offset.
function buildStillArgs(inPath: string, outPath: string, startOffset: number): string[] {
  const seek = startOffset > 0 ? ['-ss', startOffset.toFixed(3)] : []
  return [
    '-y', '-loglevel', 'error', '-i', inPath, ...seek, '-frames:v', '1',
    '-vf', `scale=${STILL_MAX_EDGE}:${STILL_MAX_EDGE}:force_original_aspect_ratio=decrease`,
    '-q:v', '3', outPath,
  ]
}

// Probe the first few seconds for a black run that starts at t=0 (a fade-in),
// via ffmpeg's blackdetect filter. Returns the offset to start sampling at
// (just past the fade), capped at MAX_START_OFFSET_S; 0 when there's no leading
// black or the probe fails/blackdetect is unavailable (→ today's t=0 behavior).
// Never throws.
async function computeStartOffset(inPath: string): Promise<number> {
  try {
    // blackdetect logs segments to stderr (info level, on by default); bound the
    // read to the first MAX_START_OFFSET_S (+margin) so the probe stays cheap.
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-nostats',
        '-t', String(MAX_START_OFFSET_S + 0.5), '-i', inPath,
        '-vf', 'blackdetect=d=0.05:pix_th=0.10', '-an', '-f', 'null', '-',
      ],
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
    )
    let end = 0
    const re = /black_start:([0-9.]+)\s+black_end:([0-9.]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(stderr)) !== null) {
      // Only a run that begins at (≈) the very start is a fade-in intro to skip.
      if (parseFloat(m[1]!) <= 0.05) end = Math.max(end, parseFloat(m[2]!))
    }
    if (!(end > 0) || !Number.isFinite(end)) return 0
    return Math.min(end + 0.1, MAX_START_OFFSET_S)
  } catch {
    return 0
  }
}

function runFfmpeg(args: string[]): Promise<unknown> {
  return execFileAsync('ffmpeg', args, {
    timeout: FFMPEG_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  })
}

// Encode one output; return its bytes, or an empty Buffer on any ffmpeg/read
// failure so the caller's retry-at-0 (and overall fallback) logic can react
// without a throw escaping mid-way.
async function encodeOutput(args: string[], outPath: string): Promise<Buffer> {
  try {
    await runFfmpeg(args)
    return await readFile(outPath)
  } catch {
    return Buffer.alloc(0)
  }
}

/**
 * Transcode already-fetched source bytes (an MP4, or an animated GIF) into the
 * short looping animated preview AND a representative still poster, both sampled
 * past any leading fade-from-black. Requires `ffmpeg` on PATH. Throws only if
 * the preview itself can't be produced (caller → static card); the still is
 * best-effort (null on any failure — the OG route just keeps meta.image).
 * ffmpeg probes the container from content, so the temp input is extensionless.
 */
async function generatePreviewAssets(
  source: Buffer,
): Promise<{ preview: Buffer; still: Buffer | null }> {
  const dir = await mkdtemp(join(tmpdir(), 'fcpreview-'))
  const inPath = join(dir, 'in')
  const previewOut = join(dir, `out.${PREVIEW_FORMAT}`)
  const stillOut = join(dir, 'still.jpg')
  try {
    await writeFile(inPath, source)
    const offset = await computeStartOffset(inPath)

    // Animated preview. If an offset seek lands past a short clip's end and
    // yields nothing, retry from 0 so we never regress to an empty preview.
    let preview = await encodeOutput(buildFfmpegArgs(inPath, previewOut, offset), previewOut)
    if (preview.byteLength === 0 && offset > 0) {
      preview = await encodeOutput(buildFfmpegArgs(inPath, previewOut, 0), previewOut)
    }
    if (preview.byteLength === 0) throw new Error('ffmpeg produced empty preview')

    // Representative still — best-effort, same retry, never fatal to the preview.
    let still: Buffer | null = await encodeOutput(buildStillArgs(inPath, stillOut, offset), stillOut)
    if (still.byteLength === 0 && offset > 0) {
      still = await encodeOutput(buildStillArgs(inPath, stillOut, 0), stillOut)
    }
    if (still.byteLength === 0) still = null

    return { preview, still }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ── Cache (reuses the imgVariantCache disk store: atomic write, LRU eviction,
//    request coalescing — see lib/media/imgVariantCache) ────────────────────

/** Own dir inside the persisted `.next/cache` volume, separate from the
 *  /api/img resize variants so the two eviction budgets don't interfere. */
const PREVIEW_CACHE_DIR = join(process.cwd(), '.next', 'cache', 'kismet-fc-preview')
// Versions the OUTPUT recipe: bump when the ffmpeg params change so stale
// generations miss the cache and age out via the sweep instead of serving.
// p1 → p2: sample past a leading fade-from-black (start offset + still poster),
// so pre-existing t=0 previews regenerate non-black on their next scrape.
const RECIPE_VERSION = 'p2'

function previewName(uri: string): string {
  const hash = createHash('sha256').update(uri).digest('hex')
  return `${RECIPE_VERSION}-${hash}.${PREVIEW_FORMAT}`
}

// The representative still shares the preview's cache dir + recipe version, so a
// recipe bump ages it out in lockstep with the animated preview.
function stillName(uri: string): string {
  const hash = createHash('sha256').update(uri).digest('hex')
  return `${RECIPE_VERSION}-still-${hash}.jpg`
}

/** Read the cached representative still (bumps mtime for LRU); null on miss. */
export function readStill(uri: string): Promise<Buffer | null> {
  return readVariant(PREVIEW_CACHE_DIR, stillName(uri))
}

/** Cheap presence check (no read) — for generateMetadata's warm/serve gate. */
async function hasPreview(uri: string): Promise<boolean> {
  try {
    return (await stat(join(PREVIEW_CACHE_DIR, previewName(uri)))).isFile()
  } catch {
    return false
  }
}

/** Read cached preview bytes (bumps mtime for LRU); null on miss. */
export function readPreview(uri: string): Promise<Buffer | null> {
  return readVariant(PREVIEW_CACHE_DIR, previewName(uri))
}

// ── Orchestration (mirrors /api/img's computeResizedVariant guards) ─────────

const previewFlight = new SingleFlight<Buffer | null>()
let activePreviews = 0
// ffmpeg is CPU- and memory-heavy; serialize like /api/transcode-gif so a
// crawler burst can't stack encodes and OOM the shared box. Excess callers get
// null (→ static card) and retry on a later scrape.
const MAX_CONCURRENT_PREVIEWS = 1
// Bound one source download's RAM. Kismet's own mints are short GIF-derived
// MP4s (a few MB); a source past this cap skips the preview (→ static card),
// which is exactly its behavior today.
const MAX_SOURCE_BYTES = 100 * 1024 * 1024
// Reject an output over this — a safety margin under Farcaster's 10MB embed
// cap. With the tuned recipe real outputs land single-digit MB at most.
const MAX_PREVIEW_BYTES = 9 * 1024 * 1024
// Wall-clock for the whole source download across the gateway walk.
const SOURCE_FETCH_BUDGET_MS = 60_000

/**
 * Download an ar://ipfs:// source across the gateway pool, hard-capped on
 * ACTUAL bytes (Content-Length is advisory on chunked gateways). Returns null
 * on any failure/oversize so the caller degrades to the static card.
 */
async function fetchSourceBounded(uri: string): Promise<Buffer | null> {
  const urls = gatewayUrls(uri)
  const deadline = Date.now() + SOURCE_FETCH_BUDGET_MS
  for (const url of urls) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(remaining) })
      if (!res.ok || !res.body) continue
      const read = await readBodyBounded(res.body, MAX_SOURCE_BYTES)
      if (read.kind === 'overflow') {
        void read.reader.cancel().catch(() => {})
        return null
      }
      return read.buffer
    } catch {
      // try the next gateway
    }
  }
  return null
}

/** Fetch → transcode → cache. Increments the concurrency counter
 *  synchronously (before the first await) so the admission checks below can't
 *  race two computes past the cap on the single-threaded event loop. */
async function computePreview(uri: string): Promise<Buffer | null> {
  activePreviews++
  try {
    // A waiter that queued behind the SingleFlight may have just written it.
    const existing = await readPreview(uri)
    if (existing) return existing
    const source = await fetchSourceBounded(uri)
    if (!source) return null
    const { preview, still } = await generatePreviewAssets(source)
    if (preview.byteLength === 0 || preview.byteLength > MAX_PREVIEW_BYTES) return null
    await writeVariant(PREVIEW_CACHE_DIR, previewName(uri), preview)
    // Cache the still too (best-effort) so the OG route can prefer it over a
    // black poster. Same size cap; a write failure is non-fatal to the preview.
    if (still && still.byteLength > 0 && still.byteLength <= MAX_PREVIEW_BYTES) {
      await writeVariant(PREVIEW_CACHE_DIR, stillName(uri), still).catch(() => {})
    }
    return preview
  } catch {
    return null
  } finally {
    activePreviews--
  }
}

/**
 * Best-effort background generation, never throws, never blocks. The ONLY
 * entry point that runs ffmpeg — both the metadata gate (on a cold miss) and
 * the serve route (on a cache miss) call this and then serve the static card,
 * so Farcaster's fetch is never held on a transcode (its embed-image fetch
 * times out faster than a browser's). The preview lands for the next scrape.
 */
export function warmMomentPreview(uri: string): void {
  if (activePreviews >= MAX_CONCURRENT_PREVIEWS && !previewFlight.has(uri)) return
  void previewFlight.run(uri, () => computePreview(uri)).catch(() => {})
}

// ── Metadata helpers ────────────────────────────────────────────────────────

/**
 * The ar://ipfs:// source to animate for a moment, or null when it isn't a
 * video/gif with a fetchable content-addressed source (still/text/none, or an
 * external https:// URL we won't server-fetch — SSRF invariant, matches
 * /api/transcode-gif + /api/img). Both the metadata gate and the route derive
 * the cache key through this, so they can never disagree.
 */
export function momentPreviewSource(
  metadata: Parameters<typeof resolveMomentMedia>[0] | undefined,
): string | null {
  if (!metadata) return null
  try {
    const media = resolveMomentMedia(metadata)
    if (media.kind !== 'video' && media.kind !== 'gif') return null
    const src = media.src
    if (!src || (!src.startsWith('ar://') && !src.startsWith('ipfs://'))) return null
    return src
  } catch {
    // Malformed metadata must never break the moment's embed/OG block — treat
    // it as "no animated preview" and fall back to the static card.
    return null
  }
}

/**
 * Pick the Farcaster embed imageUrl for a moment. Animated preview route when
 * it's already cached; otherwise the static Satori card (zero regression) plus
 * a background warm so the next scrape animates.
 */
export async function resolveEmbedImageUrl(
  canonicalUrl: string,
  metadata: Parameters<typeof resolveMomentMedia>[0] | undefined,
): Promise<string> {
  const staticUrl = `${canonicalUrl}/opengraph-image`
  const src = momentPreviewSource(metadata)
  if (!src) return staticUrl
  if (await hasPreview(src)) return `${canonicalUrl}/embed-preview`
  warmMomentPreview(src)
  return staticUrl
}

/**
 * Representative-still JPEG bytes for a video/gif moment's OG share card, or
 * null. Cached alongside the animated preview (same warm, same recipe version).
 * The moment /opengraph-image route prefers it over a black fade-in poster; a
 * miss returns null (route keeps meta.image / the branded card) AND kicks a
 * background warm so the next scrape has it — mirroring resolveEmbedImageUrl.
 */
export async function readMomentStill(
  metadata: Parameters<typeof resolveMomentMedia>[0] | undefined,
): Promise<Buffer | null> {
  const src = momentPreviewSource(metadata)
  if (!src) return null
  const still = await readStill(src)
  if (still) return still
  warmMomentPreview(src)
  return null
}
