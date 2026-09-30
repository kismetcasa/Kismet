// Verifies the server's GIF → MP4 transcode (lib/media/transcodeGifNode) on
// the `ffmpeg` on PATH, frame by frame: every GIF frame is on screen for the
// time a browser shows it, the MP4 ends at the GIF's length, and it carries no
// more frames than the GIF's time grid needs. Each fixture is built to break a
// different way ffmpeg gets GIF timing wrong on its own (lib/media/gifTiming):
// a held last frame, delays a browser clamps, uneven delays, a frame with no
// control block, and another encoder's layout.
//
// Needs ffmpeg (with libx264) on PATH, as the runtime image has it (Dockerfile:
// apk add ffmpeg — 8.1.2 on Alpine 3.24). The same recipe in the browser
// (lib/media/transcodeGif, ffmpeg.wasm 5.1.4) is checked through the app by the
// experience E2E's frame uploads.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-gif-transcode.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { transcodeGifToMp4Node } from '../lib/media/transcodeGifNode.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

let version = ''
try {
  version = execFileSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0]
} catch {
  console.log('  FAIL  ffmpeg is on PATH (this verifies the server transcoder, which shells out to it)')
  process.exit(1)
}
console.log(`\n${version}`)

// One colour per frame, cycling, so each frame can be told from its
// neighbours once decoded.
const PALETTE = [[255, 0, 170], [0, 200, 255], [255, 220, 0], [255, 255, 255]]
const u16 = (n: number) => [n & 255, n >> 8]

/** A 16×16 GIF, a frame per delay; `null` is a frame with no control block. */
function gif(delays: (number | null)[]): Buffer {
  const b: number[] = [...Buffer.from('GIF89a'), ...u16(16), ...u16(16), 0x81, 0, 0, ...PALETTE.flat()]
  b.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0x00)
  delays.forEach((d, n) => {
    if (d !== null) b.push(0x21, 0xf9, 0x04, 0x00, ...u16(d), 0x00, 0x00)
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
  b.push(0x3b)
  return Buffer.from(b)
}

/** Decode an MP4: its length, and each run of one frame's colour with how
 *  long it is on screen (to the next frame's time, or the end for the last). */
function measure(mp4: Buffer): { seconds: number; frames: number; runs: [number, number][] } {
  const dir = mkdtempSync(join(tmpdir(), 'gifverify-'))
  try {
    const path = join(dir, 'out.mp4')
    writeFileSync(path, mp4)
    // The pixels come out on stdout; the length and each frame's time
    // (showinfo) on stderr.
    const run = spawnSync('ffmpeg', [
      '-hide_banner', '-v', 'info', '-i', path, '-fps_mode', 'passthrough',
      '-vf', 'crop=2:2:4:4,scale=1:1,showinfo', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ], { maxBuffer: 1 << 26 })
    const out = run.stdout
    const log = run.stderr.toString()
    const d = log.match(/Duration: (\d+):(\d+):(\d+\.\d+)/)
    const seconds = d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : NaN
    const pts = [...log.matchAll(/pts_time:([\d.]+)/g)].map((m) => parseFloat(m[1]))
    const colours: number[] = []
    for (let i = 0; i + 2 < out.length; i += 3) {
      const px = [out[i], out[i + 1], out[i + 2]]
      colours.push(PALETTE.reduce((best, c, k) =>
        c.reduce((s, v, j) => s + (v - px[j]) ** 2, 0) < PALETTE[best].reduce((s, v, j) => s + (v - px[j]) ** 2, 0) ? k : best, 0))
    }
    const runs: [number, number][] = []
    colours.forEach((c, k) => {
      const span = (k + 1 < pts.length ? pts[k + 1] : seconds) - pts[k]
      if (runs.length && runs[runs.length - 1][0] === c) runs[runs.length - 1][1] += span
      else runs.push([c, span])
    })
    return { seconds, frames: pts.length, runs }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

async function verify(name: string, source: Buffer, played: number[]) {
  const { mp4, poster } = await transcodeGifToMp4Node(source)
  const m = measure(mp4)
  const want = played.reduce((a, d) => a + d, 0) / 100
  const inOrder = m.runs.length === played.length && m.runs.every(([c], i) => c === i % 4)
  const worst = inOrder ? Math.max(...m.runs.map(([, s], i) => Math.abs(s - played[i] / 100))) : Infinity
  const grid = Math.round(want * (100 / played.reduce(gcd)))
  check(`${name}: every frame for its delay, ending at ${want.toFixed(2)} s`,
    inOrder && worst <= 0.011 && Math.abs(m.seconds - want) <= 0.011,
    `${m.seconds} s, runs ${JSON.stringify(m.runs.map(([c, s]) => [c, +s.toFixed(3)]))}`)
  check(`${name}: no more frames than its time grid needs (${grid})`, m.frames <= grid, String(m.frames))
  // libx264 writes the settings it encoded with into the stream.
  const keyint = Number(mp4.toString('latin1').match(/ keyint=(\d+) /)?.[1])
  const gop = Math.max(30, Math.round(100 / played.reduce(gcd)))
  check(`${name}: a keyframe every ${gop} frames — about a second, and never under 30`, keyint === gop, String(keyint))
  check(`${name}: with its poster`, poster.length > 0)
}

console.log('\nthe server transcode, frame by frame')
await verify('a held last frame', gif([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 200]), [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 200])
await verify('two long frames', gif([250, 250]), [250, 250])
await verify('delays a browser plays as 1/10', gif([1, 1, 0, 1]), [10, 10, 10, 10])
await verify('uneven delays', gif([7, 13, 3, 50, 9]), [7, 13, 3, 50, 9])
await verify('a frame with no control block', gif([4, null, 4]), [4, 10, 4])
await verify('thirty even frames', gif(Array(30).fill(4)), Array(30).fill(4))
{
  const cgif = await sharp(gif([10, 10, 10]), { animated: true }).gif({ delay: [370, 90, 1200], reuse: false }).toBuffer()
  await verify('another encoder\'s GIF with a held last frame', cgif, [37, 9, 120])
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nOK — the server GIF transcode keeps every frame\'s time')
