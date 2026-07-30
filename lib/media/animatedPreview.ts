// Animated Farcaster embed thumbnails for video/gif moments.
//
// A Mini App embed card is ONE image + ONE button (the canonical schema —
// @farcaster/miniapp-core/dist/schemas/embeds.js — has no video field). The
// image URL is fetched and painted by the client, and animated GIF/WebP are
// listed embed formats, so the card MOVES when imageUrl points at an animated
// file. Our /opengraph-image route is Satori (next/og), which only ever emits
// a static PNG, so without this module every video/gif moment embeds a still.
//
// This module produces the animated counterpart — a short, silent, looping
// preview letterboxed to a 3:2 card under Farcaster's 10MB embed cap — plus a
// representative STILL for the static OG card, both sampled at a VERIFIED
// non-black offset: a candidate ladder (post-blackdetect point, then fractions
// of the duration) is probed frame-by-frame with sharp, and the first frame
// that isn't flat black wins. Trusting blackdetect alone failed in the field:
// a long video's dark intro outlasted any fixed probe window, so the sampled
// frame was still black. Verifying the actual output frame is the invariant.
//
// It reuses the tooling the codebase already runs — native `ffmpeg`
// (Dockerfile installs it for /api/transcode-gif), sharp (shareImage), and the
// imgVariantCache disk cache — and never does inline work on the crawler path
// beyond a cache read: the transcode is coalesced (SingleFlight), globally
// serialized (ffmpeg is heavy), source/size/time-capped, and any miss/failure
// degrades to the static card. Content is content-addressed (ar:///ipfs://
// txid), so a preview computed once is valid forever.
//
// Wiring: generateMetadata points imageUrl at /artwork/<a>/<id>/embed-preview
// when a preview is cached (current-recipe URLs carry ?v=<recipe> so
// Farcaster's immutable edge cache re-fetches after a recipe change);
// otherwise it keeps the static card and warms the preview for the next
// scrape. The embed-preview route serves the cached bytes — current recipe
// preferred, previous recipe as a fallback so a recipe bump NEVER downgrades
// a working animated embed to a static card while the regenerate is pending
// (the p1→p2 cold-start did exactly that in the field; see RECIPE_VERSION).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
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
// Representative still (JPEG) sampled at the same verified offset as the loop.
// The static OG share card (/opengraph-image) prefers it when the moment's own
// poster is a flat-black fade-in frame (see the poster marker below). Longest
// edge; native aspect — it's a poster fed to Satori, not the 3:2 card itself.
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

// ── Verified representative offset ──────────────────────────────────────────
//
// Field lesson (the "long video still embeds black" report): a fixed shallow
// blackdetect window + offset cap can land INSIDE a long dark intro. So the
// offset is chosen by verification, not inference: probe candidate offsets,
// check the actual frame with sharp, take the first that isn't flat black.

// blackdetect window — catches the precise end of an ordinary fade-in. Intros
// darker/longer than this are handled by the duration-fraction candidates, so
// this doesn't need to cover them.
const BLACKDETECT_WINDOW_S = 12
// Duration fractions probed after the blackdetect point. Midpoint (50%) is the
// deepest rung — it clears any intro shorter than half the piece, and a video
// that is STILL black at its own midpoint is a mostly-black piece for which
// t=0 is an honest frame.
const LADDER_FRACTIONS = [0.05, 0.1, 0.25, 0.5] as const
// Wall-clock bound on the whole ladder (background work, but ffmpeg is
// serialized module-wide — don't monopolize the slot on a pathological file).
const PICK_BUDGET_MS = 30_000
// Probe frames are tiny (fast decode + stats); bound each run tighter than a
// full encode.
const PROBE_TIMEOUT_MS = 10_000

// Flat-black rule shared across the pipeline (lib/media/representativeFrame.ts
// uses the same shape client-side): a frame is "black" only when it is BOTH
// very dark (mean luma) AND featureless (channel std-dev) — so deliberately
// dark-but-textured art is never skipped, only fade-in/slate frames.
const FLAT_BLACK_LUMA_MAX = 16
const FLAT_BLACK_STD_MAX = 6

/** sharp-side flat-black check for a decoded image buffer. Fail-open false —
 *  an undecodable probe must read as "not black" so we never skip on error. */
async function isFlatBlackImage(buf: Buffer): Promise<boolean> {
  try {
    const { channels } = await sharp(buf).stats()
    if (channels.length < 3) return false
    const [r, g, b] = channels
    const luma = 0.299 * r!.mean + 0.587 * g!.mean + 0.114 * b!.mean
    const std = (r!.stdev + g!.stdev + b!.stdev) / 3
    return luma <= FLAT_BLACK_LUMA_MAX && std <= FLAT_BLACK_STD_MAX
  } catch {
    return false
  }
}

// One bounded ffmpeg pass over the intro: parse the container Duration from the
// stderr header AND any leading black run from blackdetect. Never throws.
async function probeSource(
  inPath: string,
): Promise<{ durationS: number | null; blackEndS: number }> {
  let stderr = ''
  try {
    const res = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-nostats',
        '-t', String(BLACKDETECT_WINDOW_S), '-i', inPath,
        '-vf', 'blackdetect=d=0.05:pix_th=0.10', '-an', '-f', 'null', '-',
      ],
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
    )
    stderr = res.stderr
  } catch (err) {
    // ffmpeg exits non-zero on some odd containers after printing the header —
    // salvage whatever stderr we got; a truly failed probe degrades to t=0.
    stderr = (err as { stderr?: string })?.stderr ?? ''
  }
  let durationS: number | null = null
  const dm = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr)
  if (dm) {
    const s = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3])
    if (Number.isFinite(s) && s > 0) durationS = s
  }
  let blackEndS = 0
  const re = /black_start:([0-9.]+)\s+black_end:([0-9.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stderr)) !== null) {
    // Only a run that begins at (≈) the very start is a fade-in intro to skip.
    if (parseFloat(m[1]!) <= 0.05) blackEndS = Math.max(blackEndS, parseFloat(m[2]!))
  }
  if (!Number.isFinite(blackEndS) || blackEndS < 0) blackEndS = 0
  return { durationS, blackEndS }
}

// Tiny probe frame at an offset — 128px JPEG, input-seek (fast at any depth;
// keyframe snap is fine because the OUTPUT is what we verify).
function buildProbeArgs(inPath: string, outPath: string, offset: number): string[] {
  const seek = offset > 0 ? ['-ss', offset.toFixed(3)] : []
  return [
    '-y', '-loglevel', 'error', ...seek, '-i', inPath, '-frames:v', '1',
    '-vf', 'scale=128:128:force_original_aspect_ratio=decrease', '-q:v', '5', outPath,
  ]
}

/**
 * Choose the sampling offset by verification: walk [0, post-black point, 1s,
 * 5%/10%/25% of duration], extract a tiny frame at each, and return the first
 * offset whose frame is NOT flat black. All-black candidates (a genuinely dark
 * piece) or any probe failure → 0, i.e. the original t=0 behavior.
 */
async function pickVerifiedOffset(inPath: string): Promise<number> {
  try {
    const { durationS, blackEndS } = await probeSource(inPath)
    const maxOffset = durationS ? Math.max(0, durationS - 0.5) : BLACKDETECT_WINDOW_S
    const raw = [
      0,
      blackEndS > 0 ? blackEndS + 0.1 : -1,
      1,
      ...(durationS ? LADDER_FRACTIONS.map((f) => durationS * f) : []),
    ]
    // Clamp, drop unusable, dedupe (±0.05s), keep ascending order.
    const candidates: number[] = []
    for (const t of raw) {
      if (t < 0) continue
      const c = Math.min(t, maxOffset)
      if (!candidates.some((x) => Math.abs(x - c) < 0.05)) candidates.push(c)
    }
    candidates.sort((a, b) => a - b)

    const deadline = Date.now() + PICK_BUDGET_MS
    const dir = await mkdtemp(join(tmpdir(), 'fcprobe-'))
    try {
      for (const offset of candidates) {
        if (Date.now() >= deadline) break
        const out = join(dir, 'probe.jpg')
        try {
          await execFileAsync('ffmpeg', buildProbeArgs(inPath, out, offset), {
            timeout: PROBE_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: 4 * 1024 * 1024,
          })
          const frame = await readFile(out)
          if (frame.byteLength > 0 && !(await isFlatBlackImage(frame))) return offset
        } catch {
          // Seek past EOF / decode hiccup — try the next candidate.
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    return 0
  } catch {
    return 0
  }
}

// ── Encoders ────────────────────────────────────────────────────────────────

function buildFfmpegArgs(inPath: string, outPath: string, startOffset: number): string[] {
  const { fps, w, h } = RECIPE[PREVIEW_FORMAT]
  const pad =
    `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=0x0a0a0a`
  // -ss BEFORE -i: fast input seeking. Keyframe-snapping is fine — the offset
  // was chosen by verifying actual frames, and the loop spans 3s regardless.
  const seek = startOffset > 0 ? ['-ss', startOffset.toFixed(3)] : []
  const head = ['-y', '-loglevel', 'error', ...seek, '-i', inPath, '-t', String(CLIP_SECONDS)]
  if (PREVIEW_FORMAT === 'gif') {
    // Single-pass palette: split → generate a palette from the stream →
    // apply it, so a 256-colour GIF isn't a muddy web-safe reduction.
    return [...head, '-vf', `${pad},split[a][b];[a]palettegen[p];[b][p]paletteuse`, '-loop', '0', outPath]
  }
  return [...head, '-vf', pad, '-c:v', 'libwebp', '-q:v', '60', '-loop', '0', '-an', outPath]
}

// Full-size representative still at the verified offset, for the static OG
// card. Input-seek like the probe (fast at any depth; the offset is already
// frame-verified, so keyframe snap can at worst pick a neighboring frame of
// the same verified scene).
function buildStillArgs(inPath: string, outPath: string, startOffset: number): string[] {
  const seek = startOffset > 0 ? ['-ss', startOffset.toFixed(3)] : []
  return [
    '-y', '-loglevel', 'error', ...seek, '-i', inPath, '-frames:v', '1',
    '-vf', `scale=${STILL_MAX_EDGE}:${STILL_MAX_EDGE}:force_original_aspect_ratio=decrease`,
    '-q:v', '3', outPath,
  ]
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
 * Transcode an on-disk source file (an MP4, or an animated GIF) into the
 * short looping animated preview AND the representative still, both sampled at
 * the verified non-black offset. Requires `ffmpeg` on PATH. Throws only if the
 * preview itself can't be produced (caller → static card); the still is
 * best-effort (null on any failure — the OG route just keeps meta.image).
 * ffmpeg probes the container from content, so the input is extensionless.
 * The caller owns `workDir` (creation and cleanup) — the source was streamed
 * there directly, never held in RAM.
 */
async function generatePreviewAssets(
  inPath: string,
  workDir: string,
): Promise<{ preview: Buffer; still: Buffer | null }> {
  const previewOut = join(workDir, `out.${PREVIEW_FORMAT}`)
  const stillOut = join(workDir, 'still.jpg')
  const offset = await pickVerifiedOffset(inPath)

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
}

// ── Cache (reuses the imgVariantCache disk store: atomic write, LRU eviction,
//    request coalescing — see lib/media/imgVariantCache) ────────────────────

/** Own dir inside the persisted `.next/cache` volume, separate from the
 *  /api/img resize variants so the two eviction budgets don't interfere. */
const PREVIEW_CACHE_DIR = join(process.cwd(), '.next', 'cache', 'kismet-fc-preview')
// Versions the OUTPUT recipe: bump when the ffmpeg params change so stale
// generations regenerate. History: p1 = t=0 sampling; p2 = the SHALLOW
// offset sampler (3s blackdetect window, 2.5s cap) that ran in production
// between the #638 merge and this fix — its files can still be black for
// long-intro videos, so they must regenerate; p3 = verified non-black
// sampling (candidate ladder + sharp check) + still poster + marker.
//
// A bump must NEVER cold-start the fleet: serving falls back to previous
// recipes' files while the current one regenerates (readPreview /
// cachedPreviewVersion below). The p1→p2 deploy shipped without that
// fallback and every working animated embed — gifs included — downgraded to
// the static card until re-warmed AND re-scraped; that regression is why the
// fallback exists. List every still-plausible on-disk generation, newest
// first, in LEGACY_RECIPE_VERSIONS.
const RECIPE_VERSION = 'p3'
const LEGACY_RECIPE_VERSIONS = ['p2', 'p1'] as const

function srcHash(uri: string): string {
  return createHash('sha256').update(uri).digest('hex')
}

function previewName(uri: string, version: string = RECIPE_VERSION): string {
  return `${version}-${srcHash(uri)}.${PREVIEW_FORMAT}`
}

// The representative still shares the preview's cache dir + recipe version, so
// a recipe bump ages it out in lockstep with the animated preview. (Stills
// exist only from p2 on — no legacy variant.)
function stillName(uri: string): string {
  return `${RECIPE_VERSION}-still-${srcHash(uri)}.jpg`
}

// Poster marker: the warm-time decision "should the OG card prefer the video
// still over this moment's meta.image poster?". Keyed by BOTH the source and
// the poster URI, so a creator uploading a new cover (edit-metadata) gets a
// fresh decision instead of a stale one. Decided from the actual poster bytes
// during the warm — the crawler path only ever reads it. (Its predecessor
// checked the /api/img 2048 variant instead, which video posters NEVER
// populate — they render skipProxy — so the override was dead code in the
// common case; deciding at warm time from real bytes fixes that.)
function markerName(uri: string, posterUri: string | null): string {
  return `${RECIPE_VERSION}-marker-${srcHash(uri)}-${srcHash(posterUri ?? 'none')}.json`
}

/** Read the cached representative still (bumps mtime for LRU); null on miss. */
function readStill(uri: string): Promise<Buffer | null> {
  return readVariant(PREVIEW_CACHE_DIR, stillName(uri))
}

// TTL'd failure note for a source whose fetch/encode failed — stops every
// scrape from re-downloading a dead or (transiently) oversize source, without
// ever freezing the failure permanently (FAIL_RETRY_TTL_MS). Deleted on the
// next successful preview write.
function failName(uri: string): string {
  return `${RECIPE_VERSION}-fail-${srcHash(uri)}.json`
}

async function failMarkerFresh(uri: string): Promise<boolean> {
  const buf = await readVariant(PREVIEW_CACHE_DIR, failName(uri))
  if (!buf) return false
  try {
    const t = (JSON.parse(buf.toString('utf8')) as { t?: unknown }).t
    return typeof t === 'number' && Date.now() - t < FAIL_RETRY_TTL_MS
  } catch {
    return false
  }
}

async function readMarker(uri: string, posterUri: string | null): Promise<{ preferStill: boolean } | null> {
  const buf = await readVariant(PREVIEW_CACHE_DIR, markerName(uri, posterUri))
  if (!buf) return null
  try {
    const parsed = JSON.parse(buf.toString('utf8')) as { preferStill?: unknown }
    return { preferStill: parsed.preferStill === true }
  } catch {
    return null
  }
}

/** Which recipe generation is on disk for this source: the current one, the
 *  newest legacy one, or none. Drives both the serve fallback and the
 *  imageUrl version tag. */
async function cachedPreviewVersion(uri: string): Promise<string | null> {
  for (const v of [RECIPE_VERSION, ...LEGACY_RECIPE_VERSIONS]) {
    try {
      if ((await stat(join(PREVIEW_CACHE_DIR, previewName(uri, v)))).isFile()) return v
    } catch {
      // keep looking
    }
  }
  return null
}

/** Read cached preview bytes (bumps mtime for LRU) — current recipe preferred,
 *  legacy as fallback so a recipe bump never serves worse than before it. */
export async function readPreview(uri: string): Promise<Buffer | null> {
  for (const v of [RECIPE_VERSION, ...LEGACY_RECIPE_VERSIONS]) {
    const bytes = await readVariant(PREVIEW_CACHE_DIR, previewName(uri, v))
    if (bytes) return bytes
  }
  return null
}

// ── Orchestration (mirrors /api/img's computeResizedVariant guards) ─────────

const previewFlight = new SingleFlight<Buffer | null>()
let activePreviews = 0
// ffmpeg is CPU- and memory-heavy; serialize like /api/transcode-gif so a
// crawler burst can't stack encodes and OOM the shared box. Excess callers get
// null (→ static card) and retry on a later scrape.
const MAX_CONCURRENT_PREVIEWS = 1
// Bound one source download's DISK use. Streamed straight to the temp file
// ffmpeg reads (never buffered in RAM), so the cap can afford long-form
// artist videos — the old 100MB cap existed only because the fetch buffered
// in memory, and it silently exempted exactly the reported "long video"
// class from ever getting a preview or still (→ permanently black embed for
// a fade-in long video; a documented 186MB real moment exists). Transient
// disk cost, one compute at a time.
const MAX_SOURCE_BYTES = 500 * 1024 * 1024
// Posters are small JPEGs; their marker fetch stays RAM-buffered and far
// tighter.
const MAX_POSTER_BYTES = 10 * 1024 * 1024
const POSTER_FETCH_BUDGET_MS = 15_000
// Reject an output over this — a safety margin under Farcaster's 10MB embed
// cap. With the tuned recipe real outputs land single-digit MB at most.
const MAX_PREVIEW_BYTES = 9 * 1024 * 1024
// Wall-clock for the whole source download across the gateway walk — sized
// for the raised byte cap.
const SOURCE_FETCH_BUDGET_MS = 120_000
// A source that couldn't be fetched/encoded is retried no sooner than this.
// A TTL, not a permanent flag (transient failures must never freeze — the
// p1→p2 lesson): oversize-at-the-time or gateway-dead sources stop costing a
// full re-download on EVERY scrape, but heal on their own within a day.
const FAIL_RETRY_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Stream a fetched body to `destPath`, hard-capped on ACTUAL bytes written
 * (Content-Length is advisory on chunked gateways). Returns the byte count,
 * or null on overflow (partial file removed). Never buffers the body in RAM.
 */
async function streamBodyToFile(
  body: AsyncIterable<Uint8Array>,
  destPath: string,
  maxBytes: number,
): Promise<number | null> {
  const fh = await open(destPath, 'w')
  let written = 0
  try {
    for await (const chunk of body) {
      written += chunk.byteLength
      if (written > maxBytes) return null
      await fh.write(chunk)
    }
    return written
  } finally {
    // Overflow or a mid-stream throw leaves a partial file behind this close —
    // fetchSourceToFile removes it so a later attempt can't mistake it for a
    // complete download.
    await fh.close().catch(() => {})
  }
}

/**
 * Download an ar://ipfs:// source across the gateway pool STRAIGHT TO DISK at
 * `destPath` (ffmpeg reads from disk anyway — RAM never holds the file).
 * Returns true on success; false on failure/oversize, with any partial file
 * removed, so the caller degrades gracefully.
 */
async function fetchSourceToFile(uri: string, destPath: string): Promise<boolean> {
  const urls = gatewayUrls(uri)
  const deadline = Date.now() + SOURCE_FETCH_BUDGET_MS
  for (const url of urls) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(remaining) })
      if (!res.ok || !res.body) continue
      const written = await streamBodyToFile(
        res.body as unknown as AsyncIterable<Uint8Array>,
        destPath,
        MAX_SOURCE_BYTES,
      )
      if (written === null) {
        // Oversize is a property of the content, not this gateway — stop.
        await rm(destPath, { force: true }).catch(() => {})
        return false
      }
      if (written > 0) return true
    } catch {
      // Truncated/failed transfer — remove the partial and try the next
      // gateway (each attempt reopens the file with 'w', but a final failed
      // attempt must not leave debris).
      await rm(destPath, { force: true }).catch(() => {})
    }
  }
  await rm(destPath, { force: true }).catch(() => {})
  return false
}

/**
 * Download a SMALL ar://ipfs:// resource (poster marker fetch) into RAM,
 * hard-capped on actual bytes. Returns null on any failure/oversize.
 */
async function fetchBounded(
  uri: string,
  maxBytes: number,
  budgetMs: number,
): Promise<Buffer | null> {
  const urls = gatewayUrls(uri)
  const deadline = Date.now() + budgetMs
  for (const url of urls) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(remaining) })
      if (!res.ok || !res.body) continue
      const read = await readBodyBounded(res.body, maxBytes)
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

/**
 * Warm-time poster decision: should the OG card prefer the video still over
 * this moment's poster? True when the poster is absent (or IS the video), or
 * when its actual bytes are a flat-black frame; false when it decoded as real
 * content (or is an origin we won't fetch), so a creator's cover can never be
 * displaced. Returns NULL — decision deferred, marker NOT written — when the
 * poster couldn't be FETCHED: content-addressed bytes make black/non-black
 * deterministic, but a gateway blip is transient, and caching a guess from it
 * would freeze a wrong answer until the next recipe bump (the exact
 * transient-becomes-permanent class behind the p1→p2 cold-start). Only
 * content-addressed posters are fetched (SSRF invariant, matches the source
 * fetch).
 */
async function computePreferStill(
  src: string,
  posterUri: string | null,
): Promise<boolean | null> {
  if (!posterUri || posterUri === src) return true
  if (!posterUri.startsWith('ar://') && !posterUri.startsWith('ipfs://')) return false
  const bytes = await fetchBounded(posterUri, MAX_POSTER_BYTES, POSTER_FETCH_BUDGET_MS)
  if (!bytes) return null
  return isFlatBlackImage(bytes)
}

/** Fetch → transcode → cache, filling only the artifacts that are missing
 *  (current-recipe preview, still, poster marker — each independently, so a
 *  cover edit can mint a fresh marker without re-encoding the preview).
 *  Increments the concurrency counter synchronously (before the first await)
 *  so the admission checks can't race two computes past the cap on the
 *  single-threaded event loop. */
async function computePreview(uri: string, posterUri: string | null | undefined): Promise<Buffer | null> {
  activePreviews++
  try {
    // A waiter that queued behind the SingleFlight may have just written them.
    const existingPreview = await readVariant(PREVIEW_CACHE_DIR, previewName(uri))
    const existingStill = await readStill(uri)
    // posterUri === undefined means the caller had no metadata in hand — skip
    // the marker rather than write a wrong one.
    const needMarker =
      posterUri !== undefined && (await readMarker(uri, posterUri)) === null
    const needEncode = (!existingPreview || !existingStill) && !(await failMarkerFresh(uri))

    if (needEncode) {
      // Source streams to disk in a temp dir this block owns; ffmpeg reads it
      // from there. On any failure — fetch, oversize, or encode — write the
      // TTL'd fail note so the next scrapes skip the re-download until the
      // TTL lapses; a success deletes it.
      let encodeFailed = false
      const dir = await mkdtemp(join(tmpdir(), 'fcpreview-'))
      try {
        const inPath = join(dir, 'in')
        if (!(await fetchSourceToFile(uri, inPath))) {
          encodeFailed = true
        } else {
          const { preview, still } = await generatePreviewAssets(inPath, dir)
          if (preview.byteLength > 0 && preview.byteLength <= MAX_PREVIEW_BYTES) {
            await writeVariant(PREVIEW_CACHE_DIR, previewName(uri), preview)
            await rm(join(PREVIEW_CACHE_DIR, failName(uri)), { force: true }).catch(() => {})
          } else {
            encodeFailed = true
          }
          if (still && still.byteLength > 0 && still.byteLength <= MAX_PREVIEW_BYTES) {
            await writeVariant(PREVIEW_CACHE_DIR, stillName(uri), still).catch(() => {})
          }
        }
      } catch {
        encodeFailed = true
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
      if (encodeFailed) {
        await writeVariant(
          PREVIEW_CACHE_DIR,
          failName(uri),
          Buffer.from(JSON.stringify({ t: Date.now() })),
        ).catch(() => {})
      }
    }

    if (needMarker) {
      const preferStill = await computePreferStill(uri, posterUri ?? null)
      // null = the poster couldn't be fetched this round — leave the marker
      // unwritten so the next warm retries, instead of freezing a guess.
      if (preferStill !== null) {
        await writeVariant(
          PREVIEW_CACHE_DIR,
          markerName(uri, posterUri ?? null),
          Buffer.from(JSON.stringify({ preferStill })),
        ).catch(() => {})
      }
    }

    return existingPreview ?? (await readVariant(PREVIEW_CACHE_DIR, previewName(uri)))
  } catch {
    return null
  } finally {
    activePreviews--
  }
}

/**
 * Best-effort background generation, never throws, never blocks. The ONLY
 * entry point that runs ffmpeg — the metadata gate, the serve route, and the
 * OG still reader all call this and then serve what's already cached, so
 * Farcaster's fetch is never held on a transcode (its embed-image fetch times
 * out faster than a browser's). The assets land for the next scrape.
 * `posterUri` (meta.image, null when known-absent) feeds the poster marker;
 * omit it only when no metadata is in hand.
 */
export function warmMomentPreview(uri: string, posterUri?: string | null): void {
  if (activePreviews >= MAX_CONCURRENT_PREVIEWS && !previewFlight.has(uri)) return
  void previewFlight.run(uri, () => computePreview(uri, posterUri)).catch(() => {})
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
 * The moment's poster URI for the marker decision: meta.image when it's a
 * distinct asset, null when absent or when it IS the animation source (the
 * legacy image==animation_url shape). Never throws.
 */
export function momentPosterUri(
  metadata: Parameters<typeof resolveMomentMedia>[0] | undefined,
): string | null {
  if (!metadata) return null
  try {
    const src = momentPreviewSource(metadata)
    const poster = resolveMomentMedia(metadata).poster ?? metadata.image ?? null
    if (!poster || poster === src) return null
    return poster
  } catch {
    return null
  }
}

/**
 * Pick the Farcaster embed imageUrl for a moment. The animated preview route
 * when a preview is cached — tagged ?v=<recipe> for the current generation so
 * Farcaster's immutable edge cache re-fetches fresh bytes after a recipe
 * change, untagged while only a legacy generation exists (identical URL to
 * what old casts already reference, so they keep animating) — else the static
 * Satori card. Every non-current state also kicks a background warm.
 */
export async function resolveEmbedImageUrl(
  canonicalUrl: string,
  metadata: Parameters<typeof resolveMomentMedia>[0] | undefined,
): Promise<string> {
  const staticUrl = `${canonicalUrl}/opengraph-image`
  const src = momentPreviewSource(metadata)
  if (!src) return staticUrl
  const version = await cachedPreviewVersion(src)
  if (version === RECIPE_VERSION) return `${canonicalUrl}/embed-preview?v=${RECIPE_VERSION}`
  warmMomentPreview(src, momentPosterUri(metadata))
  if (version) return `${canonicalUrl}/embed-preview`
  return staticUrl
}

/**
 * Representative-still JPEG for the moment's static OG card, IF the warm-time
 * poster marker says the still should be preferred (poster absent / poster is
 * the video / poster bytes are flat black). null otherwise — the route keeps
 * meta.image — and null on a cold cache, which also kicks the background warm
 * so the next scrape has both artifacts.
 */
export async function readPreferredStill(
  metadata: Parameters<typeof resolveMomentMedia>[0] | undefined,
): Promise<Buffer | null> {
  const src = momentPreviewSource(metadata)
  if (!src) return null
  const posterUri = momentPosterUri(metadata)
  const [still, marker] = await Promise.all([readStill(src), readMarker(src, posterUri)])
  if (still && marker) return marker.preferStill ? still : null
  warmMomentPreview(src, posterUri)
  return null
}

// Exported for the verify script only (streaming-to-disk byte cap) — not part
// of the module API.
export const __test = { streamBodyToFile }
