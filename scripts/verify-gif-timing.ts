// Verifies lib/media/gifTiming — the reading of a GIF's timing that both GIF
// transcoders encode by — with no ffmpeg involved:
//   1. each frame's delay is read as a browser plays it: under 2/100 s, or
//      none at all, is 1/10;
//   2. the bytes handed to ffmpeg differ from the GIF only in those delays (a
//      frame with no control block gains one), and reading them back is stable;
//   3. extensions, local colour tables and another encoder's layout are walked,
//      a truncated file yields the frames it has, and a non-GIF yields null;
//   4. the encode arguments put the GIF on its own time grid and keyframe
//      about once a second on it (never more often than every 30 frames).
//      That this holds every frame for its delay, the last included, is
//      measured on real ffmpeg by scripts/verify-gif-transcode.ts.
// The encode itself, on real ffmpeg, is scripts/verify-gif-transcode.ts.
//
// Run: node --experimental-strip-types scripts/verify-gif-timing.ts

import sharp from 'sharp'
import { gifSeconds, gifTimingArgs, readGifTiming } from '../lib/media/gifTiming.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

type Frame = { delay?: number; ext?: number[] }
const u16 = (n: number) => [n & 255, n >> 8]

/** A 16×16 GIF of `frames`, one colour each. A frame with no `delay` has no
 *  graphic control block; `ext` is raw extension bytes placed before it. */
function gif(frames: Frame[], { trailer = true } = {}): Uint8Array {
  const b: number[] = [...Buffer.from('GIF89a'), ...u16(16), ...u16(16), 0x81, 0, 0]
  b.push(255, 0, 170, 0, 200, 255, 255, 220, 0, 255, 255, 255)
  b.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0x00)
  frames.forEach((f, n) => {
    if (f.ext) b.push(...f.ext)
    if (f.delay !== undefined) b.push(0x21, 0xf9, 0x04, 0x00, ...u16(f.delay), 0x00, 0x00)
    b.push(0x2c, ...u16(0), ...u16(0), ...u16(16), ...u16(16), 0x00, 0x02)
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
  })
  if (trailer) b.push(0x3b)
  return Uint8Array.from(b)
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
/** Positions where two equal-length byte arrays differ. */
const diff = (a: Uint8Array, b: Uint8Array) => [...a.keys()].filter((i) => a[i] !== b[i])

console.log('\n1. delays, as a browser plays them')
{
  const src = gif([{ delay: 50 }, { delay: 50 }])
  const t = readGifTiming(src)
  check('even delays are read as they are', JSON.stringify(t?.delays) === '[50,50]' && gifSeconds(t!) === 1, JSON.stringify(t?.delays))
  check('and a GIF that needs nothing changed is handed on byte for byte', !!t && same(t.bytes, src))
}
{
  const src = gif([{ delay: 1 }, { delay: 1 }, { delay: 0 }, { delay: 2 }])
  const t = readGifTiming(src)
  check('a delay under 2/100 s plays as 1/10 — and 2/100 stays', JSON.stringify(t?.delays) === '[10,10,10,2]' && gifSeconds(t!) === 0.32, JSON.stringify(t?.delays))
  const changed = t ? diff(src, t.bytes) : []
  check('only those delays change in the bytes ffmpeg reads', !!t && t.bytes.length === src.length && changed.length === 3 && changed.every((i) => t.bytes[i] === 10),
    JSON.stringify(changed))
}
{
  const src = gif([{ delay: 4 }, {}, { delay: 4 }])
  const t = readGifTiming(src)
  check('a frame with no control block plays as 1/10', JSON.stringify(t?.delays) === '[4,10,4]', JSON.stringify(t?.delays))
  const again = t && readGifTiming(t.bytes)
  check('and is given one, so ffmpeg reads the same — reading the result back changes nothing',
    !!t && t.bytes.length === src.length + 8 && !!again && same(again.bytes, t.bytes) && JSON.stringify(again.delays) === '[4,10,4]')
}

console.log('\n2. the file, walked')
{
  const comment = [0x21, 0xfe, 0x05, ...Buffer.from('hello'), 0x00]
  const plain = [0x21, 0x01, 0x0c, ...Array(12).fill(0), 0x02, 0x41, 0x42, 0x00]
  const src = gif([{ delay: 7, ext: comment }, { delay: 13, ext: plain }, { delay: 1 }])
  const t = readGifTiming(src)
  check('comment and plain-text extensions are stepped over, and kept', JSON.stringify(t?.delays) === '[7,13,10]' && !!t && diff(src, t.bytes).length === 1,
    JSON.stringify(t?.delays))
}
{
  // Another encoder's layout: libvips/cgif, a local colour table per frame.
  const src = new Uint8Array(await sharp(Buffer.from(gif([{ delay: 10 }, { delay: 10 }, { delay: 10 }])), { animated: true })
    .gif({ delay: [370, 90, 1200], reuse: false })
    .toBuffer())
  const t = readGifTiming(src)
  check('a GIF from another encoder, with local colour tables', JSON.stringify(t?.delays) === '[37,9,120]' && gifSeconds(t!) === 1.66, JSON.stringify(t?.delays))
}
{
  const full = gif([{ delay: 20 }, { delay: 30 }])
  const t = readGifTiming(full.slice(0, full.length - 40))
  check('a truncated GIF yields the frames it has', JSON.stringify(t?.delays) === '[20,30]', JSON.stringify(t?.delays))
  check('a GIF with no trailer still reads', JSON.stringify(readGifTiming(gif([{ delay: 20 }], { trailer: false }))?.delays) === '[20]')
}
{
  const png = Uint8Array.from(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))
  const odd = gif([{ delay: 5 }])
  odd[odd.length - 1] = 0x99 // an unknown block where the trailer was
  const withOdd = Uint8Array.from([...odd, 0x3b])
  check('anything else is null: not a GIF, empty, a block it does not know',
    readGifTiming(png) === null && readGifTiming(new Uint8Array()) === null && readGifTiming(withOdd) === null)
  const header = gif([]).slice(0, -1)
  check('and so is a GIF with no frames', readGifTiming(Uint8Array.from([...header, 0x3b])) === null)
}

console.log('\n3. the encode that keeps it')
{
  const args = (delays: number[]) => gifTimingArgs(readGifTiming(gif(delays.map((delay) => ({ delay }))))!)
  const even = args([4, 4, 4])
  check('even delays keep their own rate — a frame per GIF frame',
    even.filter === 'fps=100/4' && even.gop === 30, JSON.stringify(even))
  const uneven = args([37, 9, 120])
  check('uneven delays go on the grid they share — here every hundredth',
    uneven.filter === 'fps=100/1', JSON.stringify(uneven))
  check('a keyframe about every second on a fine grid — 100 frames at 100 a second', uneven.gop === 100, JSON.stringify(uneven))
  const fast = args([2, 2, 2])
  check('and at 50 a second, 50', fast.gop === 50, JSON.stringify(fast))
  const slow = args([250, 250])
  check('and long ones on a slow grid, keyframing every 30 frames as before', slow.filter === 'fps=100/250' && slow.gop === 30, JSON.stringify(slow))
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nOK — GIF timing')
