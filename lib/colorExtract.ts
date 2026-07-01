import sharp from 'sharp'
import { isSafePublicHttpsUrl } from './safeUrl'
import { readBodyBounded } from './boundedBody'

// Content-derived profile palette. Extracts the dominant colors from a moment's
// image (server-side, set-time — never per view) and synthesizes a structured,
// contrast-clamped theme: an accent that's always legible on the always-dark UI,
// a dimmed ambient-backdrop gradient, and an ordered ring sweep for the avatar.
//
// Pure sharp + median-cut + HSL synthesis — no extra dependency, and the
// synthesis (role scoring + WCAG clamp) is the part that makes a raw sample
// read as a *designed* palette on #0d0d0d. The panel re-picks the accent from
// `ringStops` (the clamped, displayable palette) when the auto choice isn't the
// artist's favorite.

export interface Palette {
  /** Auto-chosen accent, clamped to clear WCAG 4.5:1 (AA for text) on #0d0d0d —
   *  it's used for accent text (prices, links), not just chrome. */
  primary: string
  /** Ambient-backdrop gradient stops (heavily dimmed versions of the palette). */
  bgFrom: string
  bgTo: string
  /** Colors ordered for the conic avatar ring — also the source the panel
   *  re-picks the accent from (each is already contrast-clamped). */
  ringStops: string[]
}

type RGB = [number, number, number]
const BASE: RGB = [13, 13, 13] // #0d0d0d — the app's always-dark base

// ── color math (sRGB · HSL · WCAG luminance) ─────────────────────────────────
const toHex = ([r, g, b]: RGB): string =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60; if (h < 0) h += 360
  }
  const l = (mx + mn) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return [h, s, l]
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

function relLum([r, g, b]: RGB): number {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a: RGB, b: RGB): number => {
  const l1 = relLum(a), l2 = relLum(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}
// Integer channels we actually store (toHex rounds). Contrast is checked on the
// rounded color so a float that just clears 4.5 can't dip below it after
// rounding for boundary hues (e.g. fully saturated red).
const roundRgb = ([r, g, b]: RGB): RGB => [Math.round(r), Math.round(g), Math.round(b)]

// Pin lightness into a comfortable band, cap neon saturation, then lift
// lightness until the color clears WCAG 4.5:1 against the dark base — AA for
// normal text, since the accent is painted as text (prices, links), not just
// chrome. Matches the brand gradient's own ~L0.75 legibility target.
function clampForDark(rgb: RGB): RGB {
  const [h, s0, l0] = rgbToHsl(rgb)
  // Wider band + higher sat cap than a strict normalize, so distinct source
  // colors keep more of their character (variety) while staying legible.
  let l = Math.min(Math.max(l0, 0.5), 0.78)
  const s = Math.min(s0, 0.9)
  let out = hslToRgb([h, s, l])
  while (contrast(roundRgb(out), BASE) < 4.5 && l < 0.95) { l += 0.04; out = hslToRgb([h, s, l]) }
  return out
}
const darken = (rgb: RGB, targetL: number): RGB => {
  const [h, s] = rgbToHsl(rgb)
  return hslToRgb([h, Math.min(s, 0.6), targetL])
}

// ── median-cut quantizer ─────────────────────────────────────────────────────
function channelRanges(box: RGB[]): RGB {
  const mn: RGB = [255, 255, 255], mx: RGB = [0, 0, 0]
  for (const p of box) for (let i = 0; i < 3; i++) { if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i] }
  return [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]
}
function average(box: RGB[]): RGB {
  const s: RGB = [0, 0, 0]
  for (const p of box) for (let i = 0; i < 3; i++) s[i] += p[i]
  return [s[0] / box.length, s[1] / box.length, s[2] / box.length]
}
function medianCut(pixels: RGB[], n: number): { color: RGB; pop: number }[] {
  const boxes: RGB[][] = [pixels]
  while (boxes.length < n) {
    let bi = -1, best = -1
    boxes.forEach((b, i) => { if (b.length < 2) return; const m = Math.max(...channelRanges(b)); if (m > best) { best = m; bi = i } })
    if (bi < 0) break
    const box = boxes[bi], rg = channelRanges(box)
    const ch = rg[0] >= rg[1] && rg[0] >= rg[2] ? 0 : rg[1] >= rg[2] ? 1 : 2
    box.sort((a, b) => a[ch] - b[ch])
    const mid = box.length >> 1
    boxes.splice(bi, 1, box.slice(0, mid), box.slice(mid))
  }
  return boxes.map((b) => ({ color: average(b), pop: b.length })).sort((a, b) => b.pop - a.pop)
}

// ── synthesis ────────────────────────────────────────────────────────────────
function synthesize(pixels: RGB[]): Palette {
  const sw = medianCut(pixels, 5)
  // Accent score leans on saturation: vivid colors discriminate one moment from
  // another far better than the dominant tone (often a shared neutral/skin), so
  // similar-toned moments don't all resolve to the same accent. Soft
  // mid-lightness preference + population weight. (A user-facing
  // saturation↔population bias is a planned follow-up.)
  const scored = sw.map((s) => {
    const [h, sat, l] = rgbToHsl(s.color)
    return { ...s, h, score: (0.35 + sat * 1.5) * (1 - Math.abs(l - 0.55) * 0.9) * Math.log(s.pop + 1) }
  })
  const byScore = [...scored].sort((a, b) => b.score - a.score)
  const primaryRgb = clampForDark(byScore[0].color)
  const ph = rgbToHsl(primaryRgb)[0]
  // Backdrop spans the palette's hue range — the swatch most hue-distant from
  // the accent — so two moments with a similar dominant still differ. (dh seeds
  // at -1 so the first swatch always wins; byScore[0].color is a type-safe
  // placeholder for the seed, never the result.)
  const farthest = scored.reduce(
    (best, s) => { const dh = Math.abs(((s.h - ph + 540) % 360) - 180); return dh > best.dh ? { c: s.color, dh } : best },
    { c: byScore[0].color, dh: -1 },
  )
  return {
    primary: toHex(primaryRgb),
    bgFrom: toHex(darken(byScore[0].color, 0.13)),
    bgTo: toHex(darken(farthest.c, 0.08)),
    ringStops: scored.map((s) => toHex(clampForDark(s.color))),
  }
}

// ── public API ───────────────────────────────────────────────────────────────
const MAX_BYTES = 16 * 1024 * 1024

/** Synthesize a palette from raw image bytes. Returns null on decode failure. */
export async function paletteFromBuffer(buf: Buffer): Promise<Palette | null> {
  try {
    const { data, info } = await sharp(buf).resize(48, 48, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true })
    const ch = info.channels
    const px: RGB[] = []
    for (let i = 0; i + ch - 1 < data.length; i += ch) {
      if (ch === 4 && data[i + 3] < 128) continue // skip transparent pixels
      px.push([data[i], data[i + 1], data[i + 2]])
    }
    if (px.length < 8) return null
    return synthesize(px)
  } catch {
    return null
  }
}

/**
 * Fetch an image URL and synthesize its palette. Best-effort: returns null on
 * an unsafe URL, network/timeout/size failure, or undecodable bytes, so the
 * caller can fall back (e.g. to a thumbhash-derived color) without throwing.
 */
export async function extractPalette(imageUrl: string): Promise<Palette | null> {
  if (!isSafePublicHttpsUrl(imageUrl)) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(imageUrl, { signal: controller.signal, headers: { Accept: 'image/*' } })
    if (!res.ok || !res.body) return null
    if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) return null
    // Enforce the cap on ACTUAL bytes while reading — the header check above
    // is advisory only (chunked responses omit it), and the old
    // `arrayBuffer()` + post-hoc length check buffered the whole body before
    // rejecting it.
    const read = await readBodyBounded(res.body, MAX_BYTES)
    if (read.kind === 'overflow') {
      await read.reader.cancel().catch(() => {})
      return null
    }
    return await paletteFromBuffer(read.buffer)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Synthesize a palette from a single seed color (e.g. a thumbhash average) —
 * the fallback when full extraction isn't available. Builds a small spread of
 * tones around the seed so the ring/gradient still have life.
 */
export function paletteFromColor(rgb: RGB): Palette {
  const [h, s, l] = rgbToHsl(rgb)
  const spread: RGB[] = [
    rgb,
    hslToRgb([(h + 20) % 360, s, l]),
    hslToRgb([(h + 340) % 360, s, l]),
  ]
  // Re-use the same synthesis by feeding the spread as a tiny pixel set.
  return synthesize(spread.flatMap((c) => [c, c, c, c]))
}

// ── per-moment geometry ──────────────────────────────────────────────────────
// Color alone can't separate two similarly-toned moments. A deterministic seed
// from the moment + owner identity varies the *composition* — backdrop shape +
// angle, ring orientation, ambient mesh layout/count — so no two themed profiles
// render identically even when their palettes are close (and two owners theming
// the same moment differ too). Colors stay faithful to the artwork; only
// geometry is seeded.
export interface ThemeGeometry {
  angle: number     // linear backdrop gradient angle, deg
  ringStart: number // conic avatar-ring start angle, deg
  mesh: { x: number; y: number; r: number; stop: number }[] // ambient blobs: pos %, radius %, ringStops index
  // Backdrop wash shape — seeded for compositional variety. Optional so themes
  // stored before this field render as 'linear' (the prior behavior).
  shape?: 'linear' | 'radial'
  cx?: number       // radial wash center x% (when shape === 'radial')
  cy?: number       // radial wash center y%
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministic composition params from a moment ref ("collection:tokenId") and
 * the owner's address. Folding the owner into the seed means two people theming
 * the SAME moment still get different compositions; the seeded shape + variable
 * blob count add further variety so similar-palette moments don't render alike.
 */
export function themeGeometry(ref: string, owner?: string): ThemeGeometry {
  const rand = mulberry32(hashString(owner ? `${ref}:${owner.toLowerCase()}` : ref))
  const angle = Math.floor(rand() * 360)
  const ringStart = Math.floor(rand() * 360)
  const shape: 'linear' | 'radial' = rand() < 0.5 ? 'linear' : 'radial'
  const cx = Math.round(rand() * 100)
  const cy = Math.round(rand() * 100)
  const blobCount = 2 + Math.floor(rand() * 3) // 2–4 blobs
  const mesh = Array.from({ length: blobCount }, () => ({
    x: Math.round(rand() * 100),
    y: Math.round(rand() * 100),
    r: 28 + Math.round(rand() * 44),
    stop: Math.floor(rand() * 5),
  }))
  return { angle, ringStart, shape, cx, cy, mesh }
}
