/**
 * Browser end-to-end check for 3D moments (GLB_3D_VIEWER_DESIGN.md).
 *
 * This exists because the rest of the suite cannot catch a whole class of
 * bug. typecheck, lint, the verify-model-media oracle and the bundle guard
 * were ALL green on a mint preview that rendered as a 150px strip and
 * captured its poster at the same wrong size — nothing in them renders a
 * layout. Every assertion below needs a real browser, a real WebGL context
 * and a real GLB.
 *
 * Deliberately NOT wired into `npm run check`: it needs a built app, a
 * running server and a browser, none of which that suite assumes. See
 * scripts/e2e/README.md to run it.
 */
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'

const DIR = process.env.E2E_DIR || path.join(process.cwd(), '.e2e')
const SHOTS = path.join(DIR, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3100'
// Chromium ships with the image in CI/sandboxes; override if yours differs.
const EXE = process.env.E2E_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const GLB = fs.readFileSync(path.join(DIR, 'cube.glb'))
const POSTER = fs.readFileSync(path.join(DIR, 'poster.jpg'))

let fails = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) fails++
}

// Fixtures written as truncated / wrong-version GLBs so the gate's header
// checks are exercised against real bytes, not mocks.
const truncated = Buffer.from(GLB); truncated.writeUInt32LE(999999, 8)
const oldVersion = Buffer.from(GLB); oldVersion.writeUInt32LE(1, 4)
fs.writeFileSync(path.join(DIR, 'truncated.glb'), truncated)
fs.writeFileSync(path.join(DIR, 'v1.glb'), oldVersion)
fs.writeFileSync(path.join(DIR, 'archive.zip'), Buffer.from([0x50,0x4b,0x03,0x04, ...Array(60).fill(0)]))

/**
 * A textured UV sphere for the "optimize for web" pass: ~29k triangles (so
 * Draco has something to compress) with one 3000px PNG albedo (over the 2K
 * cap, so the texture step has something to shrink). Spec-valid glTF 2.0
 * binary, built the same way scripts/e2e/make-glb.mjs builds the cube.
 */
async function makeTexturedGlb(file) {
  const segs = 120, rings = 120
  const pos = [], uv = [], idx = []
  for (let r = 0; r <= rings; r++) {
    const v = r / rings, phi = v * Math.PI
    for (let c = 0; c <= segs; c++) {
      const u = c / segs, th = u * 2 * Math.PI
      pos.push(Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th))
      uv.push(u, v)
    }
  }
  for (let r = 0; r < rings; r++) for (let c = 0; c < segs; c++) {
    const a = r * (segs + 1) + c, b = a + segs + 1
    idx.push(a, b, a + 1, b, b + 1, a + 1)
  }
  const P = new Float32Array(pos), T = new Float32Array(uv), I = new Uint16Array(idx)
  // A smooth gradient with a little structure: compresses to a few MB as
  // PNG, still clearly larger than its 2K downscale.
  const side = 3000
  const raw = Buffer.alloc(side * side * 3)
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const o = (y * side + x) * 3
    raw[o] = (x * 255 / side) | 0
    raw[o + 1] = (y * 255 / side) | 0
    raw[o + 2] = ((x ^ y) & 0x3f) << 2
  }
  const png = await sharp(raw, { raw: { width: side, height: side, channels: 3 } }).png({ compressionLevel: 6 }).toBuffer()
  const pad4 = (n) => (n + 3) & ~3
  const parts = [Buffer.from(I.buffer), Buffer.from(P.buffer), Buffer.from(T.buffer), png]
  const views = []
  let off = 0
  const bins = []
  for (const part of parts) {
    views.push({ buffer: 0, byteOffset: off, byteLength: part.length })
    const padded = Buffer.alloc(pad4(part.length)); part.copy(padded)
    bins.push(padded); off += padded.length
  }
  views[0].target = 34963; views[1].target = 34962; views[2].target = 34962
  const bin = Buffer.concat(bins)
  const json = {
    asset: { version: '2.0', generator: 'kismet-e2e-fixture' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, TEXCOORD_0: 2 }, indices: 0, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.8 } }],
    textures: [{ source: 0 }],
    images: [{ bufferView: 3, mimeType: 'image/png' }],
    accessors: [
      { bufferView: 0, componentType: 5123, count: I.length, type: 'SCALAR' },
      { bufferView: 1, componentType: 5126, count: P.length / 3, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
      { bufferView: 2, componentType: 5126, count: T.length / 2, type: 'VEC2' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  }
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)])
  const chunk = (buf, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(buf.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, buf]) }
  const jsonChunk = chunk(jsonBuf, 0x4e4f534a), binChunk = chunk(bin, 0x004e4942)
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + jsonChunk.length + binChunk.length, 8)
  const out = Buffer.concat([header, jsonChunk, binChunk])
  fs.writeFileSync(file, out)
  return out.length
}
const TEXTURED_BYTES = await makeTexturedGlb(path.join(DIR, 'textured.glb'))

const MODEL_META = {
  uri: 'ar://meta',
  owner: '0x000000000000000000000000000000000000dEaD',
  momentAdmins: [],
  saleConfig: null,
  metadata: {
    name: 'E2E Cube',
    description: 'A 3D moment used to validate the viewer end to end.',
    image: 'ar://poster-txid',
    animation_url: 'ar://model-txid',
    content: { uri: 'ar://model-txid', mime: 'model/gltf-binary' },
    kismet_bg: 'white',
  },
}

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 })

// Serve the fixture bytes wherever the app resolves ar:// to.
await ctx.route('**/arweave.net/**', (route) => {
  const u = route.request().url()
  if (u.includes('model-txid')) return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: GLB })
  if (u.includes('poster-txid')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER })
  return route.fulfill({ status: 404, body: '' })
})
await ctx.route('**/api/img**', (route) => {
  const u = decodeURIComponent(route.request().url())
  if (u.includes('model-txid')) return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: GLB })
  return route.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER })
})

/**
 * Set the media input and WAIT FOR THE APP TO HAVE REACTED — a preview
 * mounted, or a rejection toast. The file input is server-rendered, so
 * setInputFiles can land before hydration and change nothing at all; that
 * race silently turns "no preview mounted" into a vacuous pass. Retrying
 * until an outcome is observed is the only deterministic signal available,
 * since nothing else in this form is client-only.
 */
const pickMedia = async (pg, file, ms = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await pg.setInputFiles(MEDIA_INPUT, path.join(DIR, file))
    for (let i = 0; i < 12; i++) {
      await pg.waitForTimeout(250)
      if ((await pg.locator('model-viewer').count()) > 0) return 'preview'
      if ((await pg.locator('[data-sonner-toast]').count()) > 0) return 'toast'
    }
  }
  return 'timeout'
}

// The colour at the CENTRE of an element as rendered — the only honest test
// of "the still is visible": a layer can have opacity 1 and still be painted
// over by an opaque sibling (which is exactly what happened to the still
// under model-viewer's backdrop, and what the old opacity check never saw).
const centerOf = async (pg, locator) => {
  const buf = await locator.screenshot()
  const b64 = buf.toString('base64')
  return pg.evaluate(async (data) => {
    const img = new Image()
    await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + data })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    return Array.from(ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data).slice(0, 3)
  }, b64)
}
// The poster fixture is a flat green (20,120,90); the backdrop is white.
const isPosterGreen = (px) => px[0] < 80 && px[1] > 80 && px[2] > 50 && px[1] > px[0]
// The media box while a model is loading or active: the exit/cancel
// control's parent is the wrapper that carries the backdrop.
const mediaBoxOf = (pg) => pg.locator('button[aria-label="Exit 3D view"], button[aria-label="Cancel 3D load"]').first().locator('..')
const readoutOf = async (pg) => pg.locator('text=/loading 3D…/').first().innerText().catch(() => '')

const stillOpacityOf = async (pg) => pg.evaluate(() => {
  const mv = document.querySelector('model-viewer')
  const layer = mv?.parentElement?.querySelector('div')
  return layer ? getComputedStyle(layer).opacity : null
})
// The fade is a 300ms CSS transition, and getComputedStyle reports the value
// MID-transition — so poll for the settled state instead of racing it.
const waitStillFaded = async (pg, ms = 4000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if ((await stillOpacityOf(pg)) === '0') return true
    await pg.waitForTimeout(150)
  }
  return false
}

const page = await ctx.newPage()
// Warm the route before asserting anything. On a freshly started server the
// first /mint request compiles and serves a large lazy chunk, and a cold run
// can lose the 30s race on the first selector — a red that says nothing about
// the code. One throwaway load removes it.
{
  const warm = await ctx.newPage()
  await warm.goto(`${BASE}/mint`, { waitUntil: 'load' }).catch(() => {})
  await warm.close()
}
page.on('console', (m) => { if (m.type() === 'error') console.log('    [console.error]', m.text().slice(0, 140)) })

// ───────────────────────── A. Mint form: real GLB ─────────────────────────
console.log('\nA. Mint form — picking a real GLB')
await page.goto(`${BASE}/mint`, { waitUntil: 'domcontentloaded' })
// The media picker is hidden by design (a styled drop zone triggers it), so
// wait for it to be ATTACHED, and target it by the accept list rather than
// index — there are three file inputs on this form.
const MEDIA_INPUT = 'input[accept*="model/gltf-binary"]'
await page.waitForSelector(MEDIA_INPUT, { state: 'attached', timeout: 30000 })
check('media input advertises .glb in its accept list', true)
check('a valid GLB is accepted and previewed', (await pickMedia(page, 'cube.glb')) === 'preview')

await page.waitForSelector('model-viewer', { timeout: 30000 })
await page.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, { timeout: 60000 })

const box = await page.locator('model-viewer').boundingBox()
check('preview renders (model-viewer present and loaded)', !!box)
// The artist's bug: the host stylesheet's 150px height won when no explicit
// height was set. Ratio ~1 proves the aspect-square wrapper is in control.
const ratio = box.width / box.height
check('preview box is SQUARE, not the 150px host default',
  Math.abs(ratio - 1) < 0.02 && box.height > 300, `${Math.round(box.width)}x${Math.round(box.height)} ratio ${ratio.toFixed(3)}`)

const hint = await page.locator('text=drag to pose').first().isVisible()
check('pose hint is visible to the artist', hint)
await page.screenshot({ path: path.join(SHOTS, '01-mint-preview.png'), clip: { x: 300, y: 150, width: 680, height: 800 } })

// Exercise the ACTUAL capture path the mint uses, and measure what it yields.
const cap = await page.evaluate(async () => {
  const el = document.querySelector('model-viewer')
  const blob = await el.toBlob({ mimeType: 'image/jpeg', qualityArgument: 0.85 })
  const bmp = await createImageBitmap(blob)
  return { type: blob.type, size: blob.size, w: bmp.width, h: bmp.height }
})
check('toBlob yields a real JPEG', cap.type === 'image/jpeg' && cap.size > 1000, JSON.stringify(cap))
check('captured poster is square', Math.abs(cap.w / cap.h - 1) < 0.02, `${cap.w}x${cap.h}`)
check('captured poster is big enough for the 800x800 OG hero', cap.h >= 800, `${cap.w}x${cap.h}`)
console.log(`    capture: ${cap.w}x${cap.h}, ${(cap.size/1024).toFixed(0)} KB`)

// Read a real corner pixel of the RENDERED element — what the artist sees —
// rather than trusting the CSS declaration.
const cornerOf = async (pg) => {
  const buf = await pg.locator('model-viewer').screenshot()
  // PNG: walk to IDAT-free territory by decoding in the page instead.
  const b64 = buf.toString('base64')
  return pg.evaluate(async (data) => {
    const img = new Image()
    await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + data })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    return Array.from(ctx.getImageData(4, 4, 1, 1).data).slice(0, 3)
  }, b64)
}
// model-viewer fades out its own loading overlay for about a second after
// `load`, so an element screenshot taken immediately reads a transient grey.
// That overlay is DOM-only and never reaches the capture (which reads the
// WebGL canvas), so poll for the settled colour rather than adding a sleep.
const waitCorner = async (pg, ok, ms = 6000) => {
  const t0 = Date.now()
  let last = []
  while (Date.now() - t0 < ms) {
    last = await cornerOf(pg)
    if (ok(last)) return last
    await pg.waitForTimeout(250)
  }
  return last
}
const isWhite = (px) => px.every((v) => v > 245)
const isDark = (px) => px.every((v) => v < 40)
const firstCorner = await waitCorner(page, isWhite)
check('the preview is shot on WHITE by default (the artist\'s ask)',
  isWhite(firstCorner), JSON.stringify(firstCorner))

// THE TRAP, pinned. model-viewer renders into a TRANSPARENT buffer, so asking
// it for a JPEG returns the model on BLACK no matter what the element shows.
// ModelPreview therefore takes a PNG and composites itself. If anyone
// "simplifies" that back to a direct JPEG toBlob, every poster silently goes
// black-backed again — this assertion is what makes that visible.
const rawJpeg = await page.evaluate(async () => {
  const el = document.querySelector('model-viewer')
  const b = await el.toBlob({ mimeType: 'image/jpeg', qualityArgument: 0.92 })
  const bmp = await createImageBitmap(b)
  const c = document.createElement('canvas')
  c.width = bmp.width; c.height = bmp.height
  c.getContext('2d').drawImage(bmp, 0, 0)
  return Array.from(c.getContext('2d').getImageData(4, 4, 1, 1).data).slice(0, 3)
})
check('model-viewer\'s own JPEG ignores the backdrop (why we composite)',
  rawJpeg.every((v) => v < 20), JSON.stringify(rawJpeg))

// A PNG keeps the alpha, which is what makes our compositing possible.
const rawPngAlpha = await page.evaluate(async () => {
  const el = document.querySelector('model-viewer')
  const b = await el.toBlob({ mimeType: 'image/png' })
  const bmp = await createImageBitmap(b)
  const c = document.createElement('canvas')
  c.width = bmp.width; c.height = bmp.height
  c.getContext('2d').drawImage(bmp, 0, 0)
  return c.getContext('2d').getImageData(4, 4, 1, 1).data[3]
})
check('model-viewer\'s PNG preserves alpha (the composite source)', rawPngAlpha === 0,
  String(rawPngAlpha))

// Switching the backdrop must change the preview, not just a stored id.
check('the picker offers all three backdrop options',
  (await page.locator('button[aria-label^="Backdrop:"]').count()) === 3,
  String(await page.locator('button[aria-label^="Backdrop:"]').count()))
check('the mint preview also renders the grounding shadow (it IS the poster source)',
  Number(await page.locator('model-viewer').getAttribute('shadow-intensity')) > 0)
check('the mint preview lights the model with the keyed studio, not the flat default',
  (await page.locator('model-viewer').getAttribute('environment-image')) === 'legacy')
await page.locator('button[aria-label="Backdrop: dark"]').click()
const darkCorner = await waitCorner(page, isDark)
check('choosing "dark" actually changes the backdrop', isDark(darkCorner), JSON.stringify(darkCorner))
// WCAG 2.2 SC 2.5.8: 24px minimum, and these sit too close together to claim
// the spacing exemption. verify:a11y only scans text contrast, so nothing
// else in the suite can see this.
const swatch = await page.locator('button[aria-label="Backdrop: dark"]').boundingBox()
check('the backdrop swatches meet the 24px minimum target size',
  swatch.width >= 24 && swatch.height >= 24,
  `${Math.round(swatch.width)}x${Math.round(swatch.height)}`)
await page.screenshot({ path: path.join(SHOTS, '10-mint-dark-bg.png'), clip: { x: 300, y: 150, width: 680, height: 800 } })
await page.locator('button[aria-label="Backdrop: white"]').click()
check('switching back returns the preview to white', isWhite(await waitCorner(page, isWhite)))

// Rotate, confirm a re-capture happens and differs (the "pose it" mechanic).
const before = cap.size
await page.locator('model-viewer').hover()
await page.mouse.down(); await page.mouse.move(600, 400, { steps: 12 }); await page.mouse.up()
await page.waitForTimeout(900)
const after = await page.evaluate(async () => {
  const el = document.querySelector('model-viewer')
  const b = await el.toBlob({ mimeType: 'image/jpeg', qualityArgument: 0.85 })
  return b.size
})
check('posing changes what would be captured', after !== before, `${before} -> ${after}`)
await page.screenshot({ path: path.join(SHOTS, '02-mint-posed.png'), clip: { x: 300, y: 150, width: 680, height: 800 } })

// A rapid re-pick must land on the LAST file. useFileUpload guards this with
// a monotonic token, because `accept` is async (it sniffs magic bytes) and a
// slow verdict on an earlier pick must never install over a later one.
// Untested until now — the token is invisible to every static check.
await page.setInputFiles(MEDIA_INPUT, path.join(DIR, 'cube.glb'))
await page.setInputFiles(MEDIA_INPUT, path.join(DIR, 'archive.zip'))
await page.setInputFiles(MEDIA_INPUT, path.join(DIR, 'cube.glb'))
await page.waitForTimeout(1500)
check('a rapid re-pick settles on the last valid file, not a stale verdict',
  (await page.locator('model-viewer').count()) === 1,
  String(await page.locator('model-viewer').count()))

// ───────────────────── B. Mint gate: rejections ─────────────────────
console.log('\nB. Mint gate — rejections')
// Clear the accepted model via the form's own × rather than reloading. A
// reload can land setInputFiles BEFORE hydration, and then nothing happens at
// all — which would ALSO make "leaves no preview mounted" pass vacuously.
// Staying on a live page keeps every assertion here meaningful.
await page.locator('button:has(svg.lucide-x)').first().click()
await page.waitForSelector('model-viewer', { state: 'detached', timeout: 10000 })
check('clearing the preview removes the viewer', (await page.locator('model-viewer').count()) === 0)

for (const [file, expect] of [
  ['archive.zip', 'Use an image, video, gif, or a .glb 3D model'],
  ['truncated.glb', 'looks incomplete or is an older glTF version'],
  ['v1.glb', 'looks incomplete or is an older glTF version'],
]) {
  await pickMedia(page, file)
  // Match on the EXPECTED TEXT rather than `.first()`: sonner mounts a toast
  // element before its content paints, and a toast still animating out from
  // the previous case would otherwise be picked up as an empty string.
  const toast = page.locator('[data-sonner-toast]', { hasText: expect })
  let matched = true
  try { await toast.first().waitFor({ timeout: 10000 }) } catch { matched = false }
  check(`${file} is rejected with the right reason`, matched,
    matched ? '' : JSON.stringify((await page.locator('[data-sonner-toast]').allInnerTexts()).join(' | ').slice(0, 160)))
  const noPreview = (await page.locator('model-viewer').count()) === 0
  check(`${file} leaves no preview mounted`, noPreview)
  if (file === 'truncated.glb') {
    await page.screenshot({ path: path.join(SHOTS, '03-mint-reject.png'), clip: { x: 300, y: 150, width: 680, height: 500 } })
  }
}

// ───────────────── C. Artwork detail: tap to load ─────────────────
console.log('\nC. Artwork detail — the 3D viewer')
await ctx.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MODEL_META) }))
const ART = `${BASE}/artwork/0x00000000000000000000000000000000000000aa/1`
await page.goto(ART, { waitUntil: 'domcontentloaded' })

const viewBtn = page.locator('button:has-text("view in 3D")')
await viewBtn.waitFor({ timeout: 30000 })
check('idle state offers "view in 3D"', await viewBtn.isVisible())
check('no WebGL context before the tap', (await page.locator('model-viewer').count()) === 0)
const stillVisible = await page.locator('img[alt="E2E Cube"]').first().isVisible().catch(() => false)
check('the still paints before any tap', stillVisible)
await page.screenshot({ path: path.join(SHOTS, '04-detail-idle.png'), clip: { x: 0, y: 100, width: 700, height: 760 } })

await viewBtn.click()
await page.waitForSelector('model-viewer', { timeout: 30000 })
check('tapping mounts exactly one viewer', (await page.locator('model-viewer').count()) === 1)
await page.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, { timeout: 60000 })
await page.waitForTimeout(600)
check('exit control is present and labelled',
  await page.locator('button[aria-label="Exit 3D view"]').isVisible())
// The whole point of recording kismet_bg: tapping must not swap the artist's
// backdrop for the page's.
const viewerBg = await page.evaluate(() => {
  const mv = document.querySelector('model-viewer')
  return { wrapper: getComputedStyle(mv.parentElement).backgroundColor, element: getComputedStyle(mv).backgroundColor }
})
// On the WRAPPER, behind the still — never on the element. model-viewer's
// host is position:relative and paints over the absolutely positioned still,
// so an opaque colour on the element hid the still for the whole download
// (the empty white box the artist reported).
check('the live viewer renders on the SAME backdrop as the still, carried by the wrapper',
  viewerBg.wrapper === 'rgb(255, 255, 255)', JSON.stringify(viewerBg))
check('the element itself stays transparent so the still shows through until load',
  viewerBg.element === 'rgba(0, 0, 0, 0)', JSON.stringify(viewerBg))
// model-viewer ships shadow-intensity at 0; an untextured model reads as a
// flat silhouette without this, worst of all on the white default.
check('a grounding shadow is enabled on the viewer',
  Number(await page.locator('model-viewer').getAttribute('shadow-intensity')) > 0)
// Same lighting as the preview, or the live model would not match its own
// poster.
check('the viewer lights the model with the same studio as the preview',
  (await page.locator('model-viewer').getAttribute('environment-image')) === 'legacy')
await page.screenshot({ path: path.join(SHOTS, '05-detail-active.png'), clip: { x: 0, y: 100, width: 700, height: 760 } })

// The still must fade out only AFTER the model paints.
check('still layer faded once the model painted', await waitStillFaded(page))

await page.locator('button[aria-label="Exit 3D view"]').click()
await page.waitForTimeout(400)
check('exiting unmounts the viewer (releases the context)', (await page.locator('model-viewer').count()) === 0)
check('exiting restores the "view in 3D" affordance', await page.locator('button:has-text("view in 3D")').isVisible())
await page.screenshot({ path: path.join(SHOTS, '06-detail-exited.png'), clip: { x: 0, y: 100, width: 700, height: 760 } })

// ───────── C2. `transparent` backdrop ─────────
// The artist's ask: a white shared thumbnail, but the in-app view open onto
// the page. Two different colours behind ONE stored choice.
console.log('\nC2. The transparent backdrop option')
const clear = await ctx.newPage()
await clear.route(/\/api\/moment\?/, (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ ...MODEL_META, metadata: { ...MODEL_META.metadata, kismet_bg: 'transparent' } }),
}))
await clear.goto(ART, { waitUntil: 'domcontentloaded' })
await clear.locator('button:has-text("view in 3D")').click()
await clear.waitForSelector('model-viewer', { timeout: 30000 })
await clear.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, { timeout: 60000 })
const clearBg = await clear.evaluate(() =>
  getComputedStyle(document.querySelector('model-viewer').parentElement).backgroundColor)
check('`transparent` lets the page show through the viewer',
  clearBg === 'rgba(0, 0, 0, 0)', clearBg)
await clear.screenshot({ path: path.join(SHOTS, '11-detail-transparent.png'), clip: { x: 0, y: 100, width: 700, height: 760 } })
await clear.close()

// ───────────────── D. Reduced motion ─────────────────
console.log('\nD. prefers-reduced-motion')
const rm = await ctx.newPage()
await rm.emulateMedia({ reducedMotion: 'reduce' })
await rm.goto(ART, { waitUntil: 'domcontentloaded' })
await rm.locator('button:has-text("view in 3D")').click()
await rm.waitForSelector('model-viewer', { timeout: 30000 })
await rm.waitForTimeout(1200)
const autoRotate = await rm.evaluate(() => document.querySelector('model-viewer')?.hasAttribute('auto-rotate'))
check('auto-rotate is OFF under prefers-reduced-motion', autoRotate === false, `hasAttribute=${autoRotate}`)
await rm.close()

const normal = await ctx.newPage()
await normal.emulateMedia({ reducedMotion: 'no-preference' })
await normal.goto(ART, { waitUntil: 'domcontentloaded' })
await normal.locator('button:has-text("view in 3D")').click()
await normal.waitForSelector('model-viewer', { timeout: 30000 })
await normal.waitForTimeout(1200)
check('auto-rotate is ON with no motion preference',
  await normal.evaluate(() => document.querySelector('model-viewer')?.hasAttribute('auto-rotate')) === true)
await normal.close()

// ───────── D2. A model that never loads must bank NO poster ─────────
// A GLB with a valid 12-byte header and corrupt chunks passes the mint gate
// (which reads only the header) and then fails to render. Capturing in that
// state produces a blank-but-valid JPEG, which would defeat the mint's
// "refuse rather than ship a posterless 3D moment" guard — the poster is not
// null, just empty. Instrument the composite so a pre-load capture cannot be
// reintroduced silently.
console.log('\nD2. A model that never loads')
const corrupt = Buffer.concat([GLB.subarray(0, 12), Buffer.alloc(GLB.length - 12, 0x41)])
corrupt.writeUInt32LE(corrupt.length, 8)
fs.writeFileSync(path.join(DIR, 'corrupt.glb'), corrupt)
const bad = await ctx.newPage()
await bad.addInitScript(() => {
  window.__composites = 0
  const orig = HTMLCanvasElement.prototype.toBlob
  HTMLCanvasElement.prototype.toBlob = function (...a) {
    window.__composites++
    return orig.apply(this, a)
  }
})
await bad.goto(`${BASE}/mint`, { waitUntil: 'load' })
await bad.waitForSelector(MEDIA_INPUT, { state: 'attached', timeout: 30000 })
const badOutcome = await pickMedia(bad, 'corrupt.glb')
const mounted = (await bad.locator('model-viewer').count()) === 1
check('a header-valid but corrupt GLB still reaches the preview (the gate reads the header only)',
  mounted, badOutcome)
await bad.waitForTimeout(6000)
// Guarded on `mounted`: with no element, `?.loaded !== true` and a zero
// composite count are both trivially true, and the section would pass while
// testing nothing.
check('...and it genuinely never loads',
  mounted && (await bad.evaluate(() => document.querySelector('model-viewer')?.loaded !== true)))
const composites = await bad.evaluate(() => window.__composites)
check('NO poster is captured for a model that never rendered',
  mounted && composites === 0, String(composites))
await bad.close()

// ───────── E. Slow load: still stays, progress shows ─────────
// The 856-byte fixture loads instantly, so the loading state this feature
// adds for big models on slow links is never otherwise observed. Delay the
// bytes to actually look at it.
console.log('\nE. Slow model load — the state a big model on a slow link hits')
const slow = await ctx.newPage()
await slow.route('**/arweave.net/**', async (route) => {
  const u = route.request().url()
  if (u.includes('model-txid')) {
    await new Promise((r) => setTimeout(r, 4000))
    return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: GLB })
  }
  return route.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER })
})
await slow.goto(ART, { waitUntil: 'domcontentloaded' })
await slow.locator('button:has-text("view in 3D")').click()
await slow.waitForTimeout(1200)
// The bytes are 4 s away, so right now the request has no answer. The
// readout must say so — not "50%", which is what model-viewer's aggregate
// tracker reported here before a single byte (the lighting environment's
// half) and what the artist read as a frozen download.
const loadingText = await readoutOf(slow)
check('before any byte the readout says "connecting", never a percentage',
  /loading 3D…\s*connecting/.test(loadingText) && !/\d+%/.test(loadingText), JSON.stringify(loadingText))
check('no WebGL context exists while the bytes are still on their way',
  (await slow.locator('model-viewer').count()) === 0)
const centreDuringLoad = await centerOf(slow, mediaBoxOf(slow))
check('the still is ACTUALLY VISIBLE while the model downloads — centre pixel is the poster, not the backdrop',
  isPosterGreen(centreDuringLoad), JSON.stringify(centreDuringLoad))
check('a cancel control is offered during the download',
  await slow.locator('button[aria-label="Cancel 3D load"]').isVisible())
await slow.screenshot({ path: path.join(SHOTS, '09-detail-loading.png'), clip: { x: 0, y: 100, width: 700, height: 760 } })
await slow.waitForSelector('model-viewer', { timeout: 30000 })
const stillDuringParse = await stillOpacityOf(slow)
check('the still layer stays opaque while model-viewer parses the blob', stillDuringParse === '1', String(stillDuringParse))
// React 19 sets `src` on a custom element as a PROPERTY (the element has
// one), so it is read as a property here, not an attribute.
const viewerSrc = await slow.evaluate(() => document.querySelector('model-viewer')?.src ?? null)
check('the viewer is handed a blob: URL, never a gateway URL model-viewer could cache',
  typeof viewerSrc === 'string' && viewerSrc.startsWith('blob:'), String(viewerSrc))
await slow.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, { timeout: 30000 })
await slow.waitForTimeout(600)
check('the still fades only AFTER the model paints', await waitStillFaded(slow))
await slow.close()

// ───────── E2. A gateway that accepts the connection and never answers ─────────
// The artist's actual failure: arweave.net took the request and sent nothing.
// model-viewer sat at "50%" forever with no timeout and nowhere to walk. Now
// the stall watchdog (20 s of silence) aborts the attempt and the walk
// continues to the proxy, which is guaranteed present as the last URL.
console.log('\nE2. Stalled gateway — watchdog, then the walk to the proxy')
const stalled = await ctx.newPage()
const stalledRequests = []
stalled.on('request', (r) => { if (r.url().includes('model-txid')) stalledRequests.push(r.url()) })
let heldRoute = null
await stalled.route('**/arweave.net/**', async (route) => {
  const u = route.request().url()
  if (u.includes('model-txid')) { heldRoute = route; return } // never answered
  return route.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER })
})
await stalled.goto(ART, { waitUntil: 'domcontentloaded' })
const t0stall = Date.now()
await stalled.locator('button:has-text("view in 3D")').click()
await stalled.waitForTimeout(3000)
check('while the gateway is silent the readout still says "connecting"',
  /connecting/.test(await readoutOf(stalled)), await readoutOf(stalled))
check('...and the still is still on screen', isPosterGreen(await centerOf(stalled, mediaBoxOf(stalled))))
await stalled.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, { timeout: 45000 })
const stallElapsed = Date.now() - t0stall
check('the watchdog gave up on the silent gateway and the proxy delivered the model',
  stalledRequests.some((u) => u.includes('/api/img')), JSON.stringify(stalledRequests))
check('...within the watchdog window (20 s of silence), not a browser timeout',
  stallElapsed > 15000 && stallElapsed < 40000, `${stallElapsed} ms`)
await stalled.screenshot({ path: path.join(SHOTS, '12-detail-after-stall.png'), clip: { x: 0, y: 100, width: 700, height: 760 } })
if (heldRoute) await heldRoute.abort().catch(() => {})
await stalled.close()

// ───────── E3. A failed walk, then a retry that really re-fetches ─────────
// model-viewer caches a failed load as an empty model and exposes no way to
// clear it: with the old wiring "retry 3D" errored instantly from cache with
// ZERO requests until a page reload. Every attempt now fetches afresh.
console.log('\nE3. Failed walk, then retry')
const retry = await ctx.newPage()
const retryRequests = []
retry.on('request', (r) => { if (r.url().includes('model-txid')) retryRequests.push(r.url()) })
let gatewayUp = false
await retry.route('**/arweave.net/**', (route) => {
  const u = route.request().url()
  if (u.includes('model-txid')) {
    return gatewayUp
      ? route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: GLB })
      : route.fulfill({ status: 404, body: '' })
  }
  return route.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER })
})
await retry.route('**/api/img**', (route) => {
  const u = decodeURIComponent(route.request().url())
  if (u.includes('model-txid')) {
    return gatewayUp
      ? route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: GLB })
      : route.fulfill({ status: 502, body: 'upstream unavailable' })
  }
  return route.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER })
})
await retry.goto(ART, { waitUntil: 'domcontentloaded' })
await retry.locator('button:has-text("view in 3D")').click()
await retry.locator('button:has-text("retry 3D")').waitFor({ timeout: 20000 })
const firstWalk = retryRequests.length
check('every URL in the walk was tried before giving up (gateway, then proxy)',
  firstWalk >= 2 && retryRequests.some((u) => u.includes('/api/img')), JSON.stringify(retryRequests))
check('the failure is explained and the retry affordance is offered',
  await retry.locator('text=This 3D model could not be loaded.').isVisible())
check('...and the still is still on screen behind it',
  await retry.locator('img[alt="E2E Cube"]').first().isVisible())
gatewayUp = true
await retry.locator('button:has-text("retry 3D")').click()
await retry.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, { timeout: 30000 })
check('retry re-fetches — new requests were made, nothing served from a failure cache',
  retryRequests.length > firstWalk, `${firstWalk} -> ${retryRequests.length}`)
check('...and the model loads once the gateway is back', true)
await retry.close()

// ───────── E4. Exiting during the download cancels it ─────────
// Before, the download kept running after exit with no way to stop it (a
// 30 MB fetch finishing for nobody, on mobile data). Now the exit control
// aborts the request, and a late response can never mount a viewer.
console.log('\nE4. Cancel mid-download')
const cancelPage = await ctx.newPage()
const cancelFailures = []
cancelPage.on('requestfailed', (r) => { if (r.url().includes('model-txid')) cancelFailures.push(r.failure()?.errorText ?? 'failed') })
await cancelPage.route('**/arweave.net/**', async (route) => {
  const u = route.request().url()
  if (u.includes('model-txid')) {
    await new Promise((r) => setTimeout(r, 5000))
    return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: GLB }).catch(() => {})
  }
  return route.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER })
})
await cancelPage.goto(ART, { waitUntil: 'domcontentloaded' })
await cancelPage.locator('button:has-text("view in 3D")').click()
await cancelPage.waitForTimeout(800)
await cancelPage.locator('button[aria-label="Cancel 3D load"]').click()
await cancelPage.waitForTimeout(300)
check('cancel returns to the idle affordance immediately',
  await cancelPage.locator('button:has-text("view in 3D")').isVisible())
await cancelPage.waitForTimeout(6000)
check('a response arriving after the cancel never mounts a viewer',
  (await cancelPage.locator('model-viewer').count()) === 0)
check('the in-flight request was actually aborted (not left to finish for nobody)',
  cancelFailures.length >= 1, JSON.stringify(cancelFailures))
await cancelPage.close()

// ───────── G. Mint form: "optimize for web" ─────────
// A textured sphere: ~29k triangles and a 3000px albedo. The pass must
// shrink it (Draco on the geometry, the texture to 2K), replace the pick
// through the same gate, re-load the preview from the OPTIMIZED bytes — which
// is also the proof that the self-hosted Draco decoder decodes what the
// self-hosted encoder produced — and offer an undo that restores the original.
console.log('\nG. Mint form — optimize for web')
const opt = await ctx.newPage()
// Which decoder actually serves a Draco model. The self-hosted copies in
// public/model-decoders/ were assumed to be it since the collector-file
// feature — but model-viewer's constructor re-reads the location from the
// GLOBAL config and falls back to gstatic, and the static setter the app
// used never held. Only a request-level check can tell those apart.
const decoderResponses = []
opt.on('response', (r) => { if (/model-decoders\/draco\//.test(r.url())) decoderResponses.push(`${r.status()} ${new URL(r.url()).pathname}`) })
await opt.goto(`${BASE}/mint`, { waitUntil: 'load' })
await opt.waitForSelector(MEDIA_INPUT, { state: 'attached', timeout: 30000 })
// The fixture is over the 8 MB soft warning, so a toast is EXPECTED here and
// pickMedia's "a toast means rejection" shortcut does not apply: wait for
// the preview itself, then check the warning says what it should.
const texturedOutcome = await pickMedia(opt, 'textured.glb')
const texturedMounted = await opt.waitForSelector('model-viewer', { timeout: 30000 }).then(() => true).catch(() => false)
check('the textured fixture is accepted and previewed', texturedMounted, texturedOutcome)
if (TEXTURED_BYTES > 8 * 1024 * 1024) {
  const warn = opt.locator('[data-sonner-toast]', { hasText: 'Large 3D model' })
  let warned = true
  try { await warn.first().waitFor({ timeout: 10000 }) } catch { warned = false }
  const warnText = warned ? await warn.first().innerText() : ''
  check('a model over 8 MB gets the size warning, citing the published guideline',
    warned && /under 5 MB/.test(warnText) && /optimize for web/.test(warnText), warnText.slice(0, 160))
}
await opt.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, { timeout: 60000 })
const sizeChip = opt.locator('button:has-text("optimize for web")').locator('..')
check('the size chip offers "optimize for web" on a 3D pick', await sizeChip.isVisible())
const sizeBefore = await sizeChip.innerText()
const srcBefore = await opt.evaluate(() => document.querySelector('model-viewer')?.src ?? null)
await opt.locator('button:has-text("optimize for web")').click()
const optToast = opt.locator('[data-sonner-toast]', { hasText: 'Optimized for web' })
let optimizedOk = true
try { await optToast.first().waitFor({ timeout: 90000 }) } catch { optimizedOk = false }
const optToastText = optimizedOk ? await optToast.first().innerText() : (await opt.locator('[data-sonner-toast]').allInnerTexts()).join(' | ')
check('the pass completes and reports what it did', optimizedOk, optToastText.slice(0, 200))
check('...Draco compressed the geometry', /Draco/.test(optToastText), optToastText.slice(0, 200))
check('...and the 3000px texture was downscaled to 2K', /texture.*2048/.test(optToastText), optToastText.slice(0, 200))
// The pick was replaced, so the preview REMOUNTS on a new blob: URL — wait
// for that element, not the old one that was already loaded.
await opt.waitForFunction((prev) => {
  const mv = document.querySelector('model-viewer')
  return !!mv && mv.src !== prev && mv.loaded === true
}, srcBefore, { timeout: 60000 })
await opt.waitForTimeout(500)
const sizeAfter = await opt.locator('button:has-text("undo")').locator('..').innerText().catch(() => '')
const mb = (t) => Number((/([\d.]+) MB/.exec(t) || [])[1])
check('the chip now shows a smaller live size and what it was',
  /was/.test(sizeAfter) && mb(sizeAfter) < mb(sizeBefore), `${JSON.stringify(sizeBefore)} -> ${JSON.stringify(sizeAfter)}`)
console.log(`    optimize: ${(TEXTURED_BYTES / 1024 / 1024).toFixed(2)} MB fixture -> chip ${JSON.stringify(sizeAfter)}`)
check('the preview re-loads from the OPTIMIZED bytes (our Draco decoder decodes our Draco encoder)',
  await opt.evaluate(() => document.querySelector('model-viewer')?.loaded === true))
check('the Draco decoder that served was the SELF-HOSTED one, not gstatic',
  decoderResponses.some((r) => r.startsWith('200 ') && /draco_wasm_wrapper\.js/.test(r)) &&
  decoderResponses.some((r) => r.startsWith('200 ') && /draco_decoder\.wasm/.test(r)),
  JSON.stringify(decoderResponses))
check('the encoder the pass used was self-hosted too',
  decoderResponses.some((r) => r.startsWith('200 ') && /draco_encoder_wrapper\.js/.test(r)) &&
  decoderResponses.some((r) => r.startsWith('200 ') && /draco_encoder\.wasm/.test(r)),
  JSON.stringify(decoderResponses))
await opt.screenshot({ path: path.join(SHOTS, '13-mint-optimized.png'), clip: { x: 300, y: 150, width: 680, height: 800 } })
await opt.locator('button:has-text("undo")').click()
await opt.waitForTimeout(1500)
const sizeUndone = await opt.locator('button:has-text("optimize for web")').locator('..').innerText().catch(() => '')
check('undo restores the original file and size', mb(sizeUndone) === mb(sizeBefore) && !/was/.test(sizeUndone),
  `${JSON.stringify(sizeBefore)} -> ${JSON.stringify(sizeUndone)}`)
await opt.close()

// ───────── F. Feed surface: still renders, NO WebGL ─────────
console.log('\nF. Feed surface — the no-WebGL rule')
const MODEL_MOMENT = {
  address: '0x00000000000000000000000000000000000000aa',
  token_id: '1',
  metadata: MODEL_META.metadata,
  // A MomentAdmin, not a string: MomentCard reads creator.address for the
  // avatar (a string here crashed the profile grid with `undefined.replace`).
  creator: { address: '0x000000000000000000000000000000000000dEaD', username: null, avatarUrl: null },
}
await ctx.route(/\/api\/timeline/, (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ status: 'success', moments: [MODEL_MOMENT],
    pagination: { page: 1, limit: 20, total_pages: 1 } }),
}))
const feed = await ctx.newPage()
await feed.goto(`${BASE}/discover`, { waitUntil: 'domcontentloaded' })
await feed.waitForSelector('article', { timeout: 30000 })
await feed.waitForTimeout(3000)
// MarketOvals resolves a model through `media.src`, which is the STILL. Before
// that one-line change the tile would have been blank.
const tileImg = await feed.locator('article img[alt="E2E Cube"]').first().getAttribute('src').catch(() => null)
check('a 3D moment renders its still on the feed surface', !!tileImg, String(tileImg))
// THE load-bearing rule for this feature.
check('NO model-viewer is mounted anywhere in a feed',
  (await feed.locator('model-viewer').count()) === 0)
await feed.screenshot({ path: path.join(SHOTS, '07-feed-still.png'), clip: { x: 0, y: 80, width: 900, height: 500 } })
await feed.close()

// ── F2. A MomentCard grid, fed by the intercepted timeline ────────────────
// /discover is the market view (ovals, no cards) and the homepage seeds its
// featured feed server-side — seeded, it never fetches on the client, so the
// interception can't reach it. The profile page fetches
// `/api/timeline?creator=…` from the browser, so this is where a real
// MomentCard renders from stubbed data, badge included. The badge markup is
// shared with the homepage hero (components/ModelBadge).
const profile = await ctx.newPage()
await profile.goto(`${BASE}/profile/0x000000000000000000000000000000000000dEaD`, { waitUntil: 'domcontentloaded' })
const cardMounted = await profile.waitForSelector('article', { timeout: 30000 }).then(() => true).catch(() => false)
check('a MomentCard grid renders from the intercepted timeline (profile page)', cardMounted)
check('the feed card carries the 3D badge',
  cardMounted && (await profile.locator('article [aria-label="3D artwork"]').count()) >= 1)
check('NO model-viewer is mounted in the profile grid either',
  (await profile.locator('model-viewer').count()) === 0)
await profile.screenshot({ path: path.join(SHOTS, '08-profile-badge.png'), clip: { x: 0, y: 80, width: 900, height: 700 } })
await profile.close()

await browser.close()
console.log(fails === 0 ? '\nE2E: all assertions passed' : `\nE2E: ${fails} assertion(s) failed`)
process.exit(fails === 0 ? 0 : 1)
