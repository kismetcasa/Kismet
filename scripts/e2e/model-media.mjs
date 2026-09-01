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
const viewerBg = await page.evaluate(() =>
  getComputedStyle(document.querySelector('model-viewer')).backgroundColor)
check('the live viewer renders on the SAME backdrop as the still, not transparent',
  viewerBg === 'rgb(255, 255, 255)', viewerBg)
// model-viewer ships shadow-intensity at 0; an untextured model reads as a
// flat silhouette without this, worst of all on the white default.
check('a grounding shadow is enabled on the viewer',
  Number(await page.locator('model-viewer').getAttribute('shadow-intensity')) > 0)
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
  getComputedStyle(document.querySelector('model-viewer')).backgroundColor)
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
await slow.waitForSelector('model-viewer', { timeout: 30000 })
await slow.waitForTimeout(1200)
const loadingText = await slow.locator('text=/loading 3D…/').first().innerText().catch(() => '')
check('a progress readout is shown while the model downloads',
  /loading 3D…\s*\d+%/.test(loadingText), JSON.stringify(loadingText))
const stillDuringLoad = await stillOpacityOf(slow)
check('the still is STILL VISIBLE while the model downloads (no empty box)',
  stillDuringLoad === '1', String(stillDuringLoad))
await slow.screenshot({ path: path.join(SHOTS, '09-detail-loading.png'), clip: { x: 0, y: 100, width: 700, height: 760 } })
await slow.waitForFunction(() => document.querySelector('model-viewer')?.loaded === true, { timeout: 30000 })
await slow.waitForTimeout(600)
check('the still fades only AFTER the model paints', await waitStillFaded(slow))
await slow.close()

// ───────── F. Feed surface: still renders, NO WebGL ─────────
console.log('\nF. Feed surface — the no-WebGL rule')
const MODEL_MOMENT = {
  address: '0x00000000000000000000000000000000000000aa',
  token_id: '1',
  metadata: MODEL_META.metadata,
  creator: '0x000000000000000000000000000000000000dEaD',
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

await browser.close()
console.log(fails === 0 ? '\nE2E: all assertions passed' : `\nE2E: ${fails} assertion(s) failed`)
process.exit(fails === 0 ? 0 : 1)
