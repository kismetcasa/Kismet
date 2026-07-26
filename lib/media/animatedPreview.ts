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
export const PREVIEW_FORMAT: 'webp' | 'gif' =
  process.env.FARCASTER_PREVIEW_FORMAT === 'gif' ? 'gif' : 'webp'
export const PREVIEW_CONTENT_TYPE = PREVIEW_FORMAT === 'gif' ? 'image/gif' : 'image/webp'

// Clip length + frame rate of the loop. 3s reads as motion (not a slideshow)
// while keeping even worst-case full-motion output well under the 10MB cap.
const CLIP_SECONDS = 3
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

function buildFfmpegArgs(inPath: string, outPath: string): string[] {
  const { fps, w, h } = RECIPE[PREVIEW_FORMAT]
  const pad =
    `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0a0a0a`
  const head = ['-y', '-loglevel', 'error', '-i', inPath, '-t', String(CLIP_SECONDS)]
  if (PREVIEW_FORMAT === 'gif') {
    // Single-pass palette: split → generate a palette from the stream →
    // apply it, so a 256-colour GIF isn't a muddy web-safe reduction.
    return [...head, '-vf', `${pad},split[a][b];[a]palettegen[p];[b][p]paletteuse`, '-loop', '0', outPath]
  }
  return [...head, '-vf', pad, '-c:v', 'libwebp', '-q:v', '60', '-loop', '0', '-an', outPath]
}

/**
 * Transcode already-fetched source bytes (an MP4, or an animated GIF) into a
 * short looping animated preview letterboxed to a 3:2 card. Requires `ffmpeg`
 * on PATH. Throws on ffmpeg failure/timeout so the caller falls back to the
 * static card. ffmpeg probes the container from content, so the temp input is
 * written extensionless.
 */
export async function generateAnimatedPreview(source: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'fcpreview-'))
  const inPath = join(dir, 'in')
  const outPath = join(dir, `out.${PREVIEW_FORMAT}`)
  try {
    await writeFile(inPath, source)
    await execFileAsync('ffmpeg', buildFfmpegArgs(inPath, outPath), {
      timeout: FFMPEG_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    })
    const out = await readFile(outPath)
    if (out.byteLength === 0) throw new Error('ffmpeg produced empty preview')
    return out
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
const RECIPE_VERSION = 'p1'

function previewName(uri: string): string {
  const hash = createHash('sha256').update(uri).digest('hex')
  return `${RECIPE_VERSION}-${hash}.${PREVIEW_FORMAT}`
}

/** Cheap presence check (no read) — for generateMetadata's warm/serve gate. */
export async function hasPreview(uri: string): Promise<boolean> {
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
    const preview = await generateAnimatedPreview(source)
    if (preview.byteLength === 0 || preview.byteLength > MAX_PREVIEW_BYTES) return null
    await writeVariant(PREVIEW_CACHE_DIR, previewName(uri), preview)
    return preview
  } catch {
    return null
  } finally {
    activePreviews--
  }
}

/**
 * Serve-path: return the preview bytes, computing them on a cold miss when a
 * slot is free. Cache hit → instant. Miss at capacity → null (caller serves
 * the static card); the SingleFlight lets concurrent callers for the same
 * moment share one encode.
 */
export async function ensurePreview(uri: string): Promise<Buffer | null> {
  const cached = await readPreview(uri)
  if (cached) return cached
  if (activePreviews >= MAX_CONCURRENT_PREVIEWS && !previewFlight.has(uri)) return null
  return previewFlight.run(uri, () => computePreview(uri))
}

/**
 * Warm-path: best-effort background generation, never throws, never blocks.
 * Called from generateMetadata on a cold miss so the NEXT scrape animates.
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
  const media = resolveMomentMedia(metadata)
  if (media.kind !== 'video' && media.kind !== 'gif') return null
  const src = media.src
  if (!src || (!src.startsWith('ar://') && !src.startsWith('ipfs://'))) return null
  return src
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
