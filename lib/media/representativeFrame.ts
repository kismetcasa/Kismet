// Shared "first non-black frame" seek for the mint-time frame grabbers
//
// No 'use client' directive: like lib/media/thumbhash.ts this is a plain util
// that touches browser globals ONLY inside functions (all callers run in the
// mint flow on the client), so it stays importable from thumbhash.ts's
// server-reachable graph without dragging in a client boundary.
// (extractVideoPoster, generateThumbhash). A video that FADES IN FROM BLACK has
// a flat-black frame at t=0, and every mint-time still was sampled there — so
// the poster (meta.image), the thumbhash blur, and (downstream) the Farcaster
// embed card all came out black. This seeks a loaded <video> forward to the
// first frame that ISN'T flat black and leaves it parked there for the caller
// to draw.
//
// Safe by construction — it can only ever IMPROVE on sampling t=0:
//   • A frame is skipped ONLY when it is both very dark (low mean luma) AND
//     flat (near-zero luma variance): a featureless black frame. A deliberately
//     dark BUT textured frame has variance and is kept, so dark art is never
//     "brightened".
//   • A video that opens on real content clears the very first probe (t=0) and
//     incurs ZERO seeks — the common path adds one 32×32 readback, nothing more.
//   • Any failure (no 2d context, un-seekable source, tainted canvas, budget
//     exhausted, an all-black clip) falls back to t=0 — never worse than today.

// Mean luma (0-255) at/below which a frame counts as "dark".
const DARK_LUMA_MAX = 16
// Luma variance at/below which a dark frame counts as "flat" (featureless).
// A real, even dim, frame carries far more than this; a fade-in black frame is
// ~0. (std-dev 5 ⇒ variance 25.)
const FLAT_LUMA_VARIANCE_MAX = 25
// Probe resolution — luma stats need no detail, and 32×32 keeps the per-frame
// readback sub-millisecond.
const PROBE_DIM = 32
// Scan cadence + hard caps. Fade-ins are sub-second, so a few 0.4s steps cover
// them; never walk past MAX_SCAN_S or 10% of a long video's duration.
const SCAN_STEP_S = 0.4
const MAX_SCAN_S = 3
const MAX_SCAN_FRACTION = 0.1
// Per-seek settle bound and whole-scan wall-clock bound, so a slow/odd source
// can never stall the mint flow here.
const SEEK_SETTLE_MS = 2000
const SCAN_BUDGET_MS = 4000

/** True when the sampled RGBA frame is uniformly near-black (mean luma low AND
 *  variance low). Single pass over the pixels; Rec.601 luma. */
function isFlatBlackFrame(data: Uint8ClampedArray): boolean {
  const n = data.length >> 2
  if (n === 0) return false
  const lumas = new Float32Array(n)
  let sum = 0
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const y = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
    lumas[p] = y
    sum += y
  }
  const mean = sum / n
  if (mean > DARK_LUMA_MAX) return false
  let varSum = 0
  for (let p = 0; p < n; p++) {
    const d = lumas[p]! - mean
    varSum += d * d
  }
  return varSum / n <= FLAT_LUMA_VARIANCE_MAX
}

/** Seek `video` to `t` and resolve true once it settles, false on error/timeout. */
function seekTo(video: HTMLVideoElement, t: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => done(false), SEEK_SETTLE_MS)
    function done(ok: boolean) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      resolve(ok)
    }
    const onSeeked = () => done(true)
    const onError = () => done(false)
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    try {
      video.currentTime = t
    } catch {
      done(false)
    }
  })
}

/**
 * Park a LOADED <video> (loadeddata already fired) at the first non-flat-black
 * frame within a bounded window, so the caller's drawImage samples real content
 * instead of a fade-in. Best-effort and self-bounding: on any failure the video
 * is left at (or returned to) t=0, i.e. exactly today's behavior.
 *
 * The <video> must be a same-origin/local source (an object URL from the mint
 * file picker) so the probe's getImageData isn't blocked by canvas tainting —
 * which is the case for both callers.
 */
export async function seekToFirstNonBlackFrame(video: HTMLVideoElement): Promise<void> {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    const probe = document.createElement('canvas')
    probe.width = PROBE_DIM
    probe.height = PROBE_DIM
    ctx = probe.getContext('2d', { willReadFrequently: true })
  } catch {
    ctx = null
  }
  if (!ctx) return

  const duration = Number.isFinite(video.duration) ? video.duration : undefined
  const maxScan = Math.min(MAX_SCAN_S, duration ? duration * MAX_SCAN_FRACTION : MAX_SCAN_S)
  const deadline = Date.now() + SCAN_BUDGET_MS

  for (let t = 0; t <= maxScan + 1e-6; t += SCAN_STEP_S) {
    if (t > 0) {
      if (Date.now() >= deadline) break
      // Un-seekable / errored source: draw whatever frame is parked (t=0).
      if (!(await seekTo(video, t))) break
    }
    let data: Uint8ClampedArray
    try {
      ctx.drawImage(video, 0, 0, PROBE_DIM, PROBE_DIM)
      data = ctx.getImageData(0, 0, PROBE_DIM, PROBE_DIM).data
    } catch {
      // Draw/read failed (e.g. a tainted canvas) — keep the current frame.
      return
    }
    if (!isFlatBlackFrame(data)) return // representative frame found; parked here
  }

  // Everything scanned was flat black (a genuinely dark piece) or the scan was
  // cut short — fall back to the first frame so we never end on a mid-clip black.
  if (video.currentTime !== 0) await seekTo(video, 0)
}

// Exported for unit testing the classifier in isolation (see
// scripts/verify-representative-frame). Not part of the component API.
export const __test = { isFlatBlackFrame }
