// Verifies lib/media/flashScreen — the WCAG 2.3.1 screen every stage frame
// passes — on frames built here, one clause of the definition at a time, each
// at its edge:
//   1. how often: three flashes a second pass, more do not;
//   2. how much: flashing within 21,824 CSS px² of the stage passes, more does
//      not — and the stage's own letterboxing counts for nothing;
//   3. what a flash is: a change of 0.1 in luminance or more, whose darker end
//      is below 0.8; slow fades and small wobbles are none;
//   4. red: a swing of more than 0.2 in u′v′ to or from a saturated red counts
//      even where luminance hardly moves, and the same swing between other
//      colours does not;
//   5. a looping clip is measured looping — its seam is a change;
//   6. what a creator is told, and which images count as animated.
// The frames decoded from real clips, on real ffmpeg, are
// scripts/verify-frame-screen.ts.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-flash-screen.ts

import sharp from 'sharp'
import {
  FLASH_AREA_LIMIT,
  FLASH_DECODE_FILTER,
  FLASH_GRID,
  FLASH_RATE,
  FLASH_STAGE_PX,
  flashReason,
  isAnimatedImage,
  isSvg,
  screenFlashes,
  type FlashVerdict,
} from '../lib/media/flashScreen.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

type RGB = [number, number, number]
const CELLS = FLASH_GRID * FLASH_GRID
const CELL_AREA = (FLASH_STAGE_PX / FLASH_GRID) ** 2
/** `frames` frames of the grid, each cell's colour from `at(frame, cell)`. */
function clip(frames: number, at: (f: number, cell: number) => RGB): Uint8Array {
  const out = new Uint8Array(frames * CELLS * 3)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < CELLS; c++) out.set(at(f, c), (f * CELLS + c) * 3)
  }
  return out
}
/** Between `a` and `b`, switching `hz` times a second's worth of flashes
 *  (2 × hz switches a second), over the cells `where` picks. */
const flashing = (hz: number, a: RGB, b: RGB, seconds = 2, where: (cell: number) => boolean = () => true, rest: RGB = [0, 0, 0]) =>
  clip(seconds * FLASH_RATE, (f, c) => (where(c) ? (Math.floor((f * 2 * hz) / FLASH_RATE) % 2 ? b : a) : rest))
const say = (v: FlashVerdict) => JSON.stringify(v)
const BLACK: RGB = [0, 0, 0]
const WHITE: RGB = [255, 255, 255]

// The same arithmetic as the module, to choose colours at a clause's edge.
const lin = (x: number) => { const c = x / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const luminance = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const uv = ([r, g, b]: RGB) => {
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const x = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B
  const z = 0.0193339 * R + 0.119192 * G + 0.9503041 * B
  const d = x + 15 * y + 3 * z
  return [(4 * x) / d, (9 * y) / d]
}
const chroma = (a: RGB, b: RGB) => { const [p, q] = [uv(a), uv(b)]; return Math.hypot(p[0] - q[0], p[1] - q[1]) }
const grey = (v: number): RGB => [v, v, v]
/** A 16×16 GIF of `frames` frames, each a different colour, 1/10 s apiece. */
function gif(frames: number): Uint8Array {
  const u16 = (n: number) => [n & 255, n >> 8]
  const b: number[] = [...Buffer.from('GIF89a'), ...u16(16), ...u16(16), 0x81, 0, 0, 255, 0, 170, 0, 200, 255, 255, 220, 0, 255, 255, 255]
  b.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0x00)
  for (let n = 0; n < frames; n++) {
    b.push(0x21, 0xf9, 0x04, 0x00, ...u16(10), 0x00, 0x00, 0x2c, ...u16(0), ...u16(0), ...u16(16), ...u16(16), 0x00, 0x02)
    const codes: number[] = []
    for (let i = 0; i < 256; i += 2) codes.push(4, n % 4, n % 4)
    codes.push(5)
    const data: number[] = []
    let acc = 0
    let bits = 0
    for (const c of codes) {
      acc |= c << bits
      bits += 3
      while (bits >= 8) { data.push(acc & 255); acc >>= 8; bits -= 8 }
    }
    if (bits) data.push(acc & 255)
    for (let i = 0; i < data.length; i += 255) b.push(Math.min(255, data.length - i), ...data.slice(i, i + 255))
    b.push(0x00)
  }
  b.push(0x3b)
  return Uint8Array.from(b)
}

console.log('\n1. how often')
{
  check('a still clip passes', screenFlashes(clip(120, () => [40, 90, 200]), { loop: false }).ok)
  const three = screenFlashes(flashing(3, BLACK, WHITE), { loop: false })
  check('black to white across the whole stage three times a second passes', three.ok, say(three))
  const four = screenFlashes(flashing(4, BLACK, WHITE), { loop: false })
  check('four times a second does not', !four.ok && four.kind === 'general' && four.flashes === 4 && four.area === FLASH_STAGE_PX ** 2, say(four))
  const half = screenFlashes(flashing(3.5, BLACK, WHITE), { loop: false })
  check('nor does three and a half — a seventh change begins a fourth flash', !half.ok, say(half))
  const burst = clip(120, (f) => (f >= 30 && f < 90 && Math.floor(f / 7) % 2 ? WHITE : BLACK))
  check('a burst inside an otherwise still clip is found wherever it falls', !screenFlashes(burst, { loop: false }).ok)
}

console.log('\n2. how much')
{
  // ⌊21,824 / 25⌋, written out so the edge does not move with the constant.
  const limitCells = 872
  check('the limit is a quarter of the 341 × 256 field', FLASH_AREA_LIMIT === (341 * 256) / 4 && CELL_AREA === 25, `${FLASH_AREA_LIMIT} ${CELL_AREA}`)
  const under = screenFlashes(flashing(8, BLACK, WHITE, 2, (c) => c < limitCells), { loop: false })
  check(`${limitCells} cells flashing eight times a second (${limitCells * CELL_AREA} CSS px²) pass`, under.ok && under.area === limitCells * CELL_AREA, say(under))
  const over = screenFlashes(flashing(8, BLACK, WHITE, 2, (c) => c < limitCells + 1), { loop: false })
  check(`${limitCells + 1} cells (${(limitCells + 1) * CELL_AREA} CSS px²) do not`, !over.ok && over.area === (limitCells + 1) * CELL_AREA, say(over))
  // A 16:9 clip fitted into the square stage: bars top and bottom.
  const rows = Math.round(FLASH_GRID * 9 / 16)
  const top = Math.floor((FLASH_GRID - rows) / 2)
  const wide = screenFlashes(flashing(5, BLACK, WHITE, 2, (c) => { const y = Math.floor(c / FLASH_GRID); return y >= top && y < top + rows }), { loop: false })
  check('a wide clip is measured at the size it is shown, bars excluded', !wide.ok && wide.area === rows * FLASH_GRID * CELL_AREA, say(wide))
  // Two regions, each under the limit, flashing one after the other in the same second.
  const apart = clip(120, (f, c) => {
    const first = c < 600
    const second = c >= 1200 && c < 1800
    const on = (first && f < 30) || (second && f >= 30 && f < 60)
    return on && Math.floor(f / 4) % 2 ? WHITE : BLACK
  })
  const summed = screenFlashes(apart, { loop: false })
  check('flashing areas in the same second are summed whether or not they coincide', !summed.ok && summed.area === 1200 * CELL_AREA, say(summed))
}

console.log('\n3. what a flash is')
{
  // Two greys whose luminance differs by just over, and just under, 0.1.
  let lo = 60
  let justOver: RGB = grey(0)
  let justUnder: RGB = grey(0)
  for (let hi = lo + 1; hi < 256; hi++) {
    if (luminance(grey(hi)) - luminance(grey(lo)) >= 0.1) { justOver = grey(hi); justUnder = grey(hi - 1); break }
  }
  check('(the edge: greys 0.1 apart in luminance, and one step less)',
    luminance(justOver) - luminance(grey(lo)) >= 0.1 && luminance(justUnder) - luminance(grey(lo)) < 0.1)
  check('a change of 0.1 or more is a flash', !screenFlashes(flashing(6, grey(lo), justOver), { loop: false }).ok)
  check('a change just under 0.1 is not', screenFlashes(flashing(6, grey(lo), justUnder), { loop: false }).ok)
  // Bright flicker: both ends at or above 0.8.
  lo = 0
  for (let x = 200; x < 256; x++) if (luminance(grey(x)) >= 0.8) { lo = x; break }
  check('(the edge: the darkest grey at 0.8)', luminance(grey(lo)) >= 0.8 && luminance(grey(lo - 1)) < 0.8)
  check('a flicker whose darker end is at 0.8 or above is not a flash', screenFlashes(flashing(8, grey(lo), WHITE), { loop: false }).ok)
  check('one whose darker end is just below is', !screenFlashes(flashing(8, grey(lo - 8), WHITE), { loop: false }).ok)
  // A slow pulse: a full swing every second and a half.
  const pulse = screenFlashes(clip(240, (f) => grey(Math.round(127 + 127 * Math.sin((f / 90) * Math.PI * 2)))), { loop: false })
  check('a slow pulse, however deep, is not', pulse.ok, say(pulse))
  // A staircase: up 0.12, back 0.05, up 0.12… from near black to near white in
  // a second. Every rise is 0.1 or more, but no two opposing changes both are —
  // one swing, not a flash for every step.
  const levels: RGB[] = []
  const greyAt = (l: number) => { let g = 0; while (g < 255 && luminance(grey(g)) < l) g++; return grey(g) }
  for (let l = 0.02; l < 0.85; l += 0.07) { levels.push(greyAt(l + 0.12), greyAt(l + 0.07)) }
  const stairs = clip(60, (f) => levels[Math.min(levels.length - 1, Math.floor(f / 2))])
  check('(the steps: each rise 0.1 or more, each setback under)',
    levels.every((c, i) => i === 0 || (i % 2 ? luminance(levels[i - 1]) - luminance(c) < 0.1 : luminance(c) - luminance(levels[i - 1]) >= 0.1)))
  check('a staircase of rises with small setbacks is one swing, not a flash a step', screenFlashes(stairs, { loop: false }).ok)
  // Small wobbles riding on one big swing do not split it into many.
  const wobble = screenFlashes(clip(120, (f) => grey(Math.min(255, Math.round(f * 1.5) + (f % 2 ? 6 : 0)))), { loop: false })
  check('small wobbles on the way do not count as swings', wobble.ok, say(wobble))
}

console.log('\n4. red')
{
  const RED: RGB = [255, 0, 0]
  const TEAL: RGB = [0, 140, 255]
  check('(the edge: red and a teal of nearly the same luminance, far apart in u′v′)',
    Math.abs(luminance(RED) - luminance(TEAL)) < 0.1 && chroma(RED, TEAL) > 0.2, `${luminance(RED)} ${luminance(TEAL)} ${chroma(RED, TEAL)}`)
  const redFlash = screenFlashes(flashing(5, RED, TEAL), { loop: false })
  check('red to teal five times a second is a red flash, though luminance hardly moves', !redFlash.ok && redFlash.kind === 'red', say(redFlash))
  check('three times a second is not', screenFlashes(flashing(3, RED, TEAL), { loop: false }).ok)
  // The same kind of swing between two colours, neither of them red.
  const GREEN: RGB = [0, 150, 60]
  const VIOLET: RGB = [150, 110, 255]
  check('(the edge: green and violet, as far apart, neither red)',
    Math.abs(luminance(GREEN) - luminance(VIOLET)) < 0.1 && chroma(GREEN, VIOLET) > 0.2, `${luminance(GREEN)} ${luminance(VIOLET)} ${chroma(GREEN, VIOLET)}`)
  check('is not a red flash', screenFlashes(flashing(5, GREEN, VIOLET), { loop: false }).ok)
  const dim: RGB = [12, 0, 0]
  check('nor is a red too dark to see flickering against black', screenFlashes(flashing(8, BLACK, dim), { loop: false }).ok)
}

console.log('\n5. a looping clip')
{
  // A quarter of a second: black once, then white. Played once, one change;
  // looped, the seam makes it eight a second.
  const seam = clip(15, (f) => (f === 0 ? BLACK : WHITE))
  check('a clip whose only other change is its seam passes played once', screenFlashes(seam, { loop: false }).ok)
  const looped = screenFlashes(seam, { loop: true })
  check('and fails looped', !looped.ok && looped.flashes >= 4, say(looped))
  const slow = clip(60, (f) => (f < 30 ? BLACK : WHITE))
  check('a looping second of black then white — two changes a second — passes', screenFlashes(slow, { loop: true }).ok)
}

console.log('\n6. what a creator is told, and what an image is')
{
  const four = screenFlashes(flashing(4, BLACK, WHITE), { loop: false })
  check('the reason names the rate and the share of the stage, and the way to pass',
    flashReason(four) === 'It flashes 4 times a second over 100% of the stage — keep flashing to three times a second, or to under 37% of the stage',
    flashReason(four))
  const red = screenFlashes(flashing(5, [255, 0, 0], [0, 140, 255]), { loop: false })
  check('and says when it is red', flashReason(red).startsWith('It flashes red 5 times a second'), flashReason(red))
  check('the decode is the stage\'s fit, at the grid and the rate',
    FLASH_DECODE_FILTER === 'scale=48:48:force_original_aspect_ratio=decrease:flags=area,pad=48:48:(ow-iw)/2:(oh-ih)/2,fps=60,format=rgb24',
    FLASH_DECODE_FILTER)

  const still = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f0a' } }).png().toBuffer()
  const animatedGif = gif(2)
  const animatedWebp = await sharp(Buffer.from(animatedGif), { animated: true }).webp().toBuffer()
  // APNG: a PNG with an acTL chunk counting two frames (the chunk's crc is not checked here).
  const apng = (count: number) => {
    const ihdrEnd = 8 + 8 + 13 + 4
    const actl = Buffer.alloc(20)
    actl.writeUInt32BE(8, 0); actl.write('acTL', 4); actl.writeUInt32BE(count, 8); actl.writeUInt32BE(0, 12)
    return new Uint8Array(Buffer.concat([still.subarray(0, ihdrEnd), actl, still.subarray(ihdrEnd)]))
  }
  const avif = (brand: string) => {
    const b = Buffer.alloc(24)
    b.writeUInt32BE(24, 0); b.write('ftyp', 4); b.write(brand, 8); b.writeUInt32BE(0, 12); b.write('mif1', 16); b.write(brand, 20)
    return new Uint8Array(b)
  }
  check('a still PNG, WebP and JPEG are stills',
    !isAnimatedImage(still) && !isAnimatedImage(await sharp(still).webp().toBuffer()) && !isAnimatedImage(await sharp(still).jpeg().toBuffer()))
  check('an animated GIF moves; a one-frame GIF does not', isAnimatedImage(animatedGif) && !isAnimatedImage(gif(1)))
  check('an animated WebP moves', isAnimatedImage(animatedWebp), `${animatedWebp.length} bytes`)
  check('an APNG of two frames moves; one declaring a single frame does not', isAnimatedImage(apng(2)) && !isAnimatedImage(apng(1)))
  check('an AVIF image sequence moves; an AVIF still does not', isAnimatedImage(avif('avis')) && !isAnimatedImage(avif('avif')))
  // An SVG can move by itself (SMIL, CSS, an image inside it), so it is never a still.
  const text = (t: string) => new Uint8Array(Buffer.from(t, 'utf8'))
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"><animate attributeName="fill" values="#000;#fff" dur="0.2s" repeatCount="indefinite"/></rect></svg>'
  const utf16le = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(svg, 'utf16le')]))
  check('an SVG is told apart — bare, after a prolog, comment and doctype, after a byte-order mark, namespaced, or in UTF-16',
    isSvg(text(svg)) && isSvg(text(`<?xml version="1.0"?>\n<!-- art -->\n<!DOCTYPE svg>\n${svg}`)) && isSvg(text(`\ufeff \n${svg}`)) &&
      isSvg(text('<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>')) && isSvg(utf16le))
  check('and nothing else is one: a PNG, a JPEG, a GIF, a WebP, a page with no svg, or text that only mentions one',
    !isSvg(still) && !isSvg(await sharp(still).jpeg().toBuffer()) && !isSvg(animatedGif) && !isSvg(animatedWebp) &&
      !isSvg(text('<html><body>art</body></html>')) && !isSvg(text('my art: <svg> soon')))
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nOK — flash screening, clause by clause')
