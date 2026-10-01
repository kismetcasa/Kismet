// Verifies the server's screening of stage frames (lib/experience/frameScreen)
// on real clips decoded by the `ffmpeg` on PATH, as the runtime image has it:
//   1. flashing — a whole-stage flash four times a second is refused and three
//      times passes; a small flashing area passes; red flashing is refused; a
//      fine pattern (under 0.1°) flickering passes; a loop's seam counts only
//      for the stage that loops;
//   2. the limits the studio enforces, enforced again: length, size, bytes;
//   3. what else a frame could hide: an image that moves, a still that moves,
//      bytes that are no video;
//   4. codecs an artist's upload may carry (H.264, HEVC, VP9);
//   5. and no verdict at all — tried again later — when the upload cannot be
//      fetched yet or there is no ffmpeg to look with.
// The analyser itself, clause by clause, is scripts/verify-flash-screen.ts.
//
// Needs ffmpeg (with libx264, libx265 and libvpx) on PATH.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-frame-screen.ts

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { screenFrame } from '../lib/experience/frameScreen.ts'
import type { FrameCheck, StageFrame } from '../lib/experience/types.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

try {
  console.log(`\n${execFileSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' }).split('\n')[0]}`)
} catch {
  console.log('  FAIL  ffmpeg is on PATH (the server screens frames with it)')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'frame-screen-verify-'))
/** A clip from an ffmpeg source filter, encoded as `codec` into `ext`. */
function make(name: string, source: string, { codec = 'libx264', ext = 'mp4', size = '320x320', seconds = 2 } = {}): Buffer {
  const out = join(dir, `${name}.${ext}`)
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=30:d=${seconds}`,
    '-vf', `${source},format=yuv420p`, '-c:v', codec, ...(codec === 'libx265' ? ['-tag:v', 'hvc1', '-x265-params', 'log-level=error'] : []),
    ...(codec === 'libvpx-vp9' ? ['-b:v', '0', '-crf', '32'] : []), out,
  ])
  return readFileSync(out)
}
/** A frame whose uploads are `media` and `poster`, served from memory. */
async function screen(media: Buffer | null, stage: 'dispense' | 'open', { kind = 'video', poster }: { kind?: StageFrame['kind']; poster?: Buffer | null } = {}): Promise<FrameCheck | null> {
  const still = poster === undefined ? await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123' } }).jpeg().toBuffer() : poster
  const uploads: Record<string, Buffer | null> = { 'ar://media': media, 'ar://poster': still }
  const frame: StageFrame = { uri: 'ar://media', kind, poster: kind === 'image' ? 'ar://media' : 'ar://poster' }
  return screenFrame(frame, stage, async (uri, max) => {
    const bytes = uploads[uri]
    if (!bytes) return null
    return bytes.length > max ? 'too-large' : bytes
  })
}
const passed = (c: FrameCheck | null) => c?.state === 'passed'
const refused = (c: FrameCheck | null, words: RegExp) => c?.state === 'refused' && words.test(c.reason)
const say = (c: FrameCheck | null) => JSON.stringify(c)

// A switch between black and white `hz` flashes a second over the frame (or a box of it).
const flash = (hz: number, box = '') => `geq=lum='if(lt(mod(T\\,${1 / hz})\\,${1 / (2 * hz)})\\,255\\,0)${box}':cb=128:cr=128`

try {
  console.log('\n1. flashing, on real clips')
  {
    const calm = make('calm', "drawbox=x='mod(t*80\\,260)':y=130:w=60:h=60:color=white:t=fill")
    check('a calm clip (a box gliding across) passes, looping or not', passed(await screen(calm, 'dispense')) && passed(await screen(calm, 'open')))
    const four = await screen(make('four', flash(4)), 'open')
    check('the whole stage flashing four times a second is refused, saying why', refused(four, /^It flashes 4 times a second over 100% of the stage/), say(four))
    check('three times a second passes', passed(await screen(make('three', flash(3)), 'open')))
    // A 100 × 100 box of a 320 frame: 75 × 75 CSS px on the stage, well under 21,824 px².
    const small = make('small', "geq=lum='if(between(X\\,110\\,209)*between(Y\\,110\\,209)*lt(mod(T\\,0.1)\\,0.05)\\,255\\,0)':cb=128:cr=128")
    check('a small area flashing ten times a second passes', passed(await screen(small, 'open')))
    const red = make('red', "geq=r='if(lt(mod(T\\,0.2)\\,0.1)\\,255\\,0)':g='if(lt(mod(T\\,0.2)\\,0.1)\\,0\\,140)':b='if(lt(mod(T\\,0.2)\\,0.1)\\,0\\,255)'", {})
    const redCheck = await screen(red, 'open')
    check('red and teal alternating five times a second is refused as red flashing', refused(redCheck, /flashes red/), say(redCheck))
    const fine = make('fine', "geq=lum='if(mod(X+Y+floor(T*20)\\,2)\\,255\\,0)':cb=128:cr=128")
    check('a one-pixel checkerboard inverting twenty times a second — a fine pattern — passes', passed(await screen(fine, 'open')))
    // A quarter of a second: black for its first frame, then white.
    const seam = make('seam', "geq=lum='if(lt(N\\,1)\\,0\\,255)':cb=128:cr=128", { seconds: 0.25 })
    const seamLoop = await screen(seam, 'dispense')
    check('a clip whose seam flashes is refused for the dispense, which loops', refused(seamLoop, /flashes/), say(seamLoop))
    check('and passes for the open, which plays once', passed(await screen(seam, 'open')))
  }

  console.log('\n2. the limits, again')
  {
    const long = await screen(make('long', "drawbox=x=10:y=10:w=20:h=20:color=white:t=fill", { seconds: 5 }), 'open')
    check('a five-second clip is refused for its length', refused(long, /^It runs 5\.0 seconds — at most 4/), say(long))
    const big = await screen(make('big', "drawbox=x=10:y=10:w=20:h=20:color=white:t=fill", { size: '1200x1200', seconds: 1 }), 'open')
    check('a 1200 px clip is refused for its size', refused(big, /^It is 1200 px on its longest side — at most 1080/), say(big))
    const heavy = await screen(Buffer.alloc(3 * 1024 * 1024, 7), 'open')
    check('an upload over 2.5 MB is refused without being read', refused(heavy, /^It is larger than 2\.5 MB/), say(heavy))
  }

  console.log('\n3. what else a frame could hide')
  {
    const still = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#f0a' } }).png().toBuffer()
    check('a still image frame passes', passed(await screen(still, 'open', { kind: 'image' })))
    const gif = execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=64x64:r=10:d=1,${flash(4)}`, '-f', 'gif', '-'])
    const webp = await sharp(gif, { animated: true }).webp().toBuffer()
    const moving = await screen(webp, 'open', { kind: 'image' })
    check('an animated WebP given as an image is refused — it would animate unscreened', refused(moving, /^It moves/), say(moving))
    const wide = await screen(await sharp({ create: { width: 1200, height: 600, channels: 3, background: '#0af' } }).png().toBuffer(), 'open', { kind: 'image' })
    check('an image over 1080 px is refused', refused(wide, /1200 px/), say(wide))
    const calm = make('calm2', "drawbox=x=10:y=10:w=20:h=20:color=white:t=fill")
    const stillMoves = await screen(calm, 'open', { poster: webp })
    check('a clip whose still moves is refused', refused(stillMoves, /^Its still moves/), say(stillMoves))
    const junk = await screen(Buffer.from('<html>not a video</html>'), 'open')
    check('bytes that are no video are refused', refused(junk, /could not be read as a video/), say(junk))
  }

  console.log('\n4. codecs')
  {
    check('HEVC decodes and is screened: flashing refused', refused(await screen(make('hevc', flash(4), { codec: 'libx265' }), 'open'), /flashes/))
    check('VP9 in WebM decodes and is screened: calm passes', passed(await screen(make('vp9', "drawbox=x=10:y=10:w=20:h=20:color=white:t=fill", { codec: 'libvpx-vp9', ext: 'webm' }), 'open')))
  }

  console.log('\n5. no verdict, to be tried again')
  {
    check('an upload no gateway has yet gets no verdict', (await screen(null, 'open')) === null)
    const flashing = make('blind', flash(4))
    const path = process.env.PATH
    process.env.PATH = join(dir, 'no-ffmpeg-here')
    const blind = await screen(flashing, 'open').finally(() => { process.env.PATH = path })
    check('nor does a clip on a box with no ffmpeg — never a pass for want of a look', blind === null, say(blind))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nOK — the server screens every frame before a player sees it')
