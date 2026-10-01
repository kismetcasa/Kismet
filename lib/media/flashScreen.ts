/**
 * Whether a clip, shown in a machine's stage, stays within WCAG 2.3.1 (Three
 * Flashes or Below Threshold) — the check every artist's stage frame passes
 * before a player sees it. PURE — no imports beyond the GIF reader — so the
 * studio (frames decoded by ffmpeg.wasm) and the server (decoded by the
 * runtime image's ffmpeg) judge a clip the same way.
 *
 * ── The threshold, as WCAG defines it ──
 *
 * Content passes if, in any one second, there are no more than three general
 * flashes and no more than three red flashes — or if what flashes is small: no
 * more than 25% of any 10° visual field. WCAG takes a 341 × 256 px rectangle
 * as that field, so the area is 21,824 CSS px². (Understanding 2.3.1 also
 * calls 87,296 — the whole field — "a flashing area"; the normative definition
 * is a quarter of it, and this uses the definition.)
 *
 *   A general flash is a pair of opposing changes in relative luminance of 0.1
 *   or more, where the darker state is below 0.8.
 *   A red flash is a pair of opposing transitions to or from a saturated red
 *   (R / (R + G + B) ≥ 0.8) between states more than 0.2 apart in CIE 1976
 *   u′v′ (WCAG 2.2's working definition, from ISO 9241-391). A red here must
 *   also be red enough to see — R − G − B ≥ 0.0625, the older definition's
 *   (R − G − B) × 320 > 20 — so compression noise in a near-black cell, whose
 *   chromaticity is unstable, is not taken for red.
 *
 * ── How a clip is measured ──
 *
 * At the largest size a player sees it: the stage, 240 CSS px square, with the
 * clip fitted inside as the stage fits it. FLASH_DECODE_FILTER turns the clip
 * into 48 × 48 cells of 5 × 5 CSS px — about 0.1° at the viewing distance WCAG
 * assumes, the size below which it exempts a fine pattern, and which averaging
 * a cell discounts in the same way — at 60 frames a second.
 *
 * A cell's transitions are the swings of at least the threshold between
 * adjacent extremes of its luminance (or chromaticity) over time; smaller
 * wobbles on the way do not split a swing. More than six transitions in a
 * second (a seventh begins a fourth flash) and the cell flashes in that
 * second. The area of the cells that flash in any second must stay within
 * 21,824 CSS px², summed over the whole stage — which lies inside one 10°
 * field — whether or not they flash at the same instant: a clip is never
 * passed on the timing of its flashes. A clip that loops (the dispense) is
 * measured looping, so the jump from its last frame to its first counts.
 */

import { readGifTiming } from './gifTiming'

/** The stage's side, CSS px: the largest a player sees a frame
 *  (components/MachineStage.tsx). Growing the stage means changing this. */
export const FLASH_STAGE_PX = 240
/** Cells per side a frame is measured in. */
export const FLASH_GRID = 48
/** Frames a second a clip is measured at. */
export const FLASH_RATE = 60
/** A quarter of the 10° field WCAG measures by (341 × 256 CSS px). */
export const FLASH_AREA_LIMIT = 21_824

/**
 * The ffmpeg video filter that decodes a clip for screenFlashes: fitted into
 * the grid as the stage fits it (the bars never change), sampled at the rate,
 * as 8-bit RGB. Use it with `-f rawvideo`; every frame is FLASH_GRID² × 3 bytes.
 */
export const FLASH_DECODE_FILTER =
  `scale=${FLASH_GRID}:${FLASH_GRID}:force_original_aspect_ratio=decrease:flags=area,` +
  `pad=${FLASH_GRID}:${FLASH_GRID}:(ow-iw)/2:(oh-ih)/2,fps=${FLASH_RATE},format=rgb24`

/** More than three flashes a second is more than this many transitions. */
const MAX_TRANSITIONS = 6
const LUMINANCE_STEP = 0.1
const DARKER_BELOW = 0.8
const CHROMA_STEP = 0.2
const RED_SHARE = 0.8
const RED_EXCESS = 20 / 320

const CELLS = FLASH_GRID * FLASH_GRID
const CELL_AREA = (FLASH_STAGE_PX / FLASH_GRID) ** 2
const STAGE_AREA = FLASH_STAGE_PX * FLASH_STAGE_PX

/** 8-bit sRGB to linear light, as WCAG's relative luminance defines it. */
const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
/** Where CIE 1976 puts neutral (D65), for a cell too dark to have a hue. */
const NEUTRAL_U = 0.1978
const NEUTRAL_V = 0.4683

export interface FlashVerdict {
  ok: boolean
  /** The test the worst second fails, or comes nearest to failing. */
  kind: 'general' | 'red'
  /** Flashes a second in the worst second, at its most frequent cell. */
  flashes: number
  /** CSS px² that flash in the worst second. */
  area: number
  /** When the worst second starts, seconds into the clip. */
  at: number
}

/**
 * Screen a clip decoded with FLASH_DECODE_FILTER (`rgb`: its frames, one after
 * another). `loop` for a clip the stage repeats.
 */
export function screenFlashes(rgb: Uint8Array, { loop }: { loop: boolean }): FlashVerdict {
  const n = Math.floor(rgb.length / (CELLS * 3))
  const calm: FlashVerdict = { ok: true, kind: 'general', flashes: 0, area: 0, at: 0 }
  if (n < 2) return calm

  const lum = new Float64Array(n * CELLS)
  const u = new Float64Array(n * CELLS)
  const v = new Float64Array(n * CELLS)
  const red = new Uint8Array(n * CELLS)
  for (let i = 0; i < n * CELLS; i++) {
    const r = LINEAR[rgb[i * 3]]
    const g = LINEAR[rgb[i * 3 + 1]]
    const b = LINEAR[rgb[i * 3 + 2]]
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
    const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
    const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b
    const d = x + 15 * y + 3 * z
    u[i] = d > 1e-9 ? (4 * x) / d : NEUTRAL_U
    v[i] = d > 1e-9 ? (9 * y) / d : NEUTRAL_V
    const sum = r + g + b
    red[i] = sum > 0 && r / sum >= RED_SHARE && r - g - b >= RED_EXCESS ? 1 : 0
  }

  // Looped, the clip is laid end to end until every second that crosses the
  // seam is seen from its second pass on, where no swing is cut short by the
  // start; played once, it is seen once.
  const copies = loop ? 2 + Math.ceil(FLASH_RATE / n) : 1
  const length = n * copies
  const firstStart = loop ? n : 0
  const lastStart = loop ? 2 * n - 1 : Math.max(0, length - FLASH_RATE)

  const general: Int32Array[] = []
  const reds: Int32Array[] = []
  for (let c = 0; c < CELLS; c++) {
    const at = (t: number) => (t % n) * CELLS + c
    general.push(luminanceTransitions((t) => lum[at(t)], length))
    reds.push(redTransitions((t) => at(t), u, v, red, length))
  }

  const worst = (transitions: Int32Array[], kind: FlashVerdict['kind']): FlashVerdict => {
    let best: FlashVerdict = { ...calm, kind }
    const lo = new Int32Array(CELLS)
    const hi = new Int32Array(CELLS)
    for (let s = firstStart; s <= lastStart; s++) {
      let area = 0
      let most = 0
      for (let c = 0; c < CELLS; c++) {
        const times = transitions[c]
        while (lo[c] < times.length && times[lo[c]] < s) lo[c]++
        while (hi[c] < times.length && times[hi[c]] < s + FLASH_RATE) hi[c]++
        const count = hi[c] - lo[c]
        if (count > MAX_TRANSITIONS) {
          area += CELL_AREA
          if (count > most) most = count
        }
      }
      if (area > best.area || (area === best.area && Math.ceil(most / 2) > best.flashes)) {
        best = { ok: area <= FLASH_AREA_LIMIT, kind, flashes: Math.ceil(most / 2), area, at: (s % n) / FLASH_RATE }
      }
    }
    return best
  }
  const g = worst(general, 'general')
  const r = worst(reds, 'red')
  if (!g.ok || !r.ok) return !g.ok && (r.ok || g.area >= r.area) ? g : r
  return g.area >= r.area ? g : r
}

/** Frames where a luminance swing of at least the step ends, counting a swing
 *  only when its darker end is below 0.8. */
function luminanceTransitions(at: (t: number) => number, length: number): Int32Array {
  const out: number[] = []
  const swing = (a: number, b: number, t: number) => {
    if (Math.abs(b - a) >= LUMINANCE_STEP && Math.min(a, b) < DARKER_BELOW) out.push(t)
  }
  let dir = 0
  let pivot = at(0)
  let ext = pivot
  let extAt = 0
  let low = pivot
  let lowAt = 0
  let high = pivot
  let highAt = 0
  for (let t = 1; t < length; t++) {
    const x = at(t)
    if (dir === 0) {
      // No swing yet: the first is from whichever extreme came first.
      if (x > high) { high = x; highAt = t }
      if (x < low) { low = x; lowAt = t }
      if (high - low >= LUMINANCE_STEP) {
        if (lowAt < highAt) { dir = 1; pivot = low; ext = high; extAt = highAt }
        else { dir = -1; pivot = high; ext = low; extAt = lowAt }
      }
    } else if (dir === 1) {
      if (x > ext) { ext = x; extAt = t }
      else if (ext - x >= LUMINANCE_STEP) { swing(pivot, ext, extAt); pivot = ext; dir = -1; ext = x; extAt = t }
    } else {
      if (x < ext) { ext = x; extAt = t }
      else if (x - ext >= LUMINANCE_STEP) { swing(pivot, ext, extAt); pivot = ext; dir = 1; ext = x; extAt = t }
    }
  }
  if (dir !== 0) swing(pivot, ext, extAt)
  return Int32Array.from(out)
}

/** Frames where a chromaticity swing of more than 0.2 in u′v′, to or from a
 *  saturated red, ends. The swing runs from the last extreme to the state
 *  farthest from it, and ends when the colour turns back by more than 0.2. */
function redTransitions(
  index: (t: number) => number,
  u: Float64Array,
  v: Float64Array,
  red: Uint8Array,
  length: number,
): Int32Array {
  const out: number[] = []
  const dist = (a: number, b: number) => Math.hypot(u[a] - u[b], v[a] - v[b])
  let pivot = index(0)
  let far = pivot
  let farAt = 0
  let farDist = 0
  for (let t = 1; t < length; t++) {
    const i = index(t)
    const d = dist(i, pivot)
    if (d > farDist) { far = i; farAt = t; farDist = d; continue }
    if (farDist > CHROMA_STEP && dist(i, far) > CHROMA_STEP) {
      if (red[pivot] || red[far]) out.push(farAt)
      pivot = far
      far = i
      farAt = t
      farDist = dist(i, pivot)
    }
  }
  if (farDist > CHROMA_STEP && (red[pivot] || red[far])) out.push(farAt)
  return Int32Array.from(out)
}

/** Why a clip was refused, in the words a creator is shown. */
export function flashReason(v: FlashVerdict): string {
  const share = (area: number) => Math.round((100 * area) / STAGE_AREA)
  return (
    `It ${v.kind === 'red' ? 'flashes red' : 'flashes'} ${v.flashes} times a second over ${share(v.area)}% of the stage` +
    ` — keep flashing to three times a second, or to under ${Math.floor((100 * FLASH_AREA_LIMIT) / STAGE_AREA)}% of the stage`
  )
}

/**
 * Whether an image moves: a GIF of more than one frame, an animated PNG, an
 * animated WebP, or an AVIF/HEIF image sequence. A still stage frame is shown
 * as an image, which the browser would animate unscreened — so an animated one
 * has to come as a GIF or a video, which are screened.
 */
export function isAnimatedImage(b: Uint8Array): boolean {
  const ascii = (at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len))
  const u32 = (at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
  if (ascii(0, 3) === 'GIF') return (readGifTiming(b)?.delays.length ?? 0) > 1
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') {
    // APNG: an acTL chunk, before the image data, counting more than one frame.
    for (let at = 8; at + 8 <= b.length;) {
      const len = u32(at)
      const type = ascii(at + 4, 4)
      if (type === 'acTL') return u32(at + 8) > 1
      if (type === 'IDAT' || type === 'IEND') return false
      at += 12 + len
    }
    return false
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    for (let at = 12; at + 8 <= b.length;) {
      const type = ascii(at, 4)
      const len = (b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16) | (b[at + 7] << 24)) >>> 0
      if (type === 'VP8X' && b[at + 8] & 0x02) return true
      if (type === 'ANIM' || type === 'ANMF') return true
      at += 8 + len + (len & 1)
    }
    return false
  }
  if (ascii(4, 4) === 'ftyp') {
    const end = Math.min(u32(0), b.length)
    for (let at = 8; at + 4 <= end; at += 4) {
      if (at === 12) continue // the minor version, not a brand
      if (['avis', 'msf1', 'hevs'].includes(ascii(at, 4))) return true
    }
  }
  return false
}
