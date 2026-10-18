/**
 * Browser end-to-end check for zines (ZINE_READER_DESIGN.md).
 *
 * Everything below needs a real browser: a real pdf.js worker fetched from
 * OUR origin, real canvases, real gestures and a real layout. The oracle
 * (scripts/verify-zine-media.ts) pins the gate, the resolver and the copy;
 * this pins what only exists on screen — that the preview renders page 1's
 * pixels, that the reader opens lazily and only on a tap, that keys, taps,
 * swipes and the scrubber turn pages, that spreads appear on a wide screen
 * and not on a phone, that zoom zooms, that nothing leaves a canvas in the
 * DOM, and that the feed card wears the badge and never loads pdf.js.
 *
 * Deliberately NOT wired into `npm run check` — it needs a built app, a
 * running server and a browser. See scripts/e2e/README.md; the recipe is the
 * 3D one with `make-pdf.mjs` as the fixture step.
 */
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { rgbaToThumbHash } from 'thumbhash'
import { writeFixtures, PAGE_COLORS, IMAGE_RGB } from './make-pdf.mjs'

const DIR = process.env.E2E_DIR || path.join(process.cwd(), '.e2e')
const SHOTS = path.join(DIR, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3100'
const EXE = process.env.E2E_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

await writeFixtures(DIR)
const ZINE = fs.readFileSync(path.join(DIR, 'zine.pdf'))
const LONG = fs.readFileSync(path.join(DIR, 'long.pdf'))
const ODD = fs.readFileSync(path.join(DIR, 'odd.pdf'))
const COVER = fs.readFileSync(path.join(DIR, 'cover.jpg'))
// The cover's real thumbhash, as a mint would write it: the opening frame
// sizes the cover from it before any image loads, and the reading room takes
// its light from the colour it encodes.
const COVER_THUMBHASH = await (async () => {
  const { data, info } = await sharp(COVER).resize(100, 100, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64')
})()

let fails = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) fails++
}

const ZINE_META = {
  uri: 'ar://meta',
  owner: '0x000000000000000000000000000000000000dEaD',
  momentAdmins: [],
  saleConfig: null,
  metadata: {
    name: 'E2E Zine',
    description: 'A zine used to validate the reader end to end.',
    image: 'ar://cover-txid',
    animation_url: 'ar://zine-txid',
    content: { uri: 'ar://zine-txid', mime: 'application/pdf' },
    kismet_zine: { pages: 6, access: 'public' },
    kismet_thumbhash: COVER_THUMBHASH,
  },
}
const ART = `${BASE}/artwork/0x00000000000000000000000000000000000000aa/1`
/** The reader dialog (the opening frame is a dialog too, briefly). */
const READER = '[role="dialog"][aria-label^="Reading"]'

const browser = await chromium.launch({ executablePath: EXE })

/** The fixture a txid names. */
const PDF_BY_TXID = { 'zine-txid': ZINE, 'long-txid': LONG, 'odd-txid': ODD }
const pdfFor = (u) => Object.entries(PDF_BY_TXID).find(([txid]) => u.includes(txid))?.[1] ?? null

/** Serve the fixture bytes wherever the app resolves ar:// to. */
async function wire(ctx) {
  // Count the renders pdf.js is asked for (one GetOperatorList per page
  // render): the evidence that a flip past a queued page cancels it.
  await ctx.addInitScript(() => {
    window.__pdfRenders = 0
    const orig = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (msg, ...rest) {
      try { if (msg && typeof msg === 'object' && msg.action === 'GetOperatorList') window.__pdfRenders++ } catch {}
      return orig.call(this, msg, ...rest)
    }
  })
  await ctx.route('**/arweave.net/**', (route) => {
    const u = route.request().url()
    const pdf = pdfFor(u)
    if (pdf) return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf })
    if (u.includes('cover-txid')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: COVER })
    return route.fulfill({ status: 404, body: '' })
  })
  await ctx.route('**/api/img**', (route) => {
    const u = decodeURIComponent(route.request().url())
    const pdf = pdfFor(u)
    if (pdf) return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf })
    return route.fulfill({ status: 200, contentType: 'image/jpeg', body: COVER })
  })
  await ctx.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ZINE_META) }))
}

/** Count requests for pdf.js's runtime assets — the lazy-load evidence. */
function trackPdfjs(pg) {
  const seen = { worker: 0, fonts: 0, wasm: 0, any: 0 }
  pg.on('request', (req) => {
    const u = req.url()
    if (!u.includes('/pdfjs/')) return
    seen.any++
    if (u.includes('pdf.worker')) seen.worker++
    if (u.includes('/standard_fonts/')) seen.fonts++
    if (u.includes('/wasm/')) seen.wasm++
  })
  return seen
}

/** One rendered pixel at the centre of an element, read in the page. */
const centreOf = async (pg, locator) => {
  const buf = await locator.screenshot()
  const b64 = buf.toString('base64')
  return pg.evaluate(async (data) => {
    const img = new Image()
    await new Promise((r) => { img.onload = r; img.src = 'data:image/png;base64,' + data })
    const c = document.createElement('canvas')
    c.width = img.width; c.height = img.height
    const cx = c.getContext('2d')
    cx.drawImage(img, 0, 0)
    const px = cx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data
    c.width = 0; c.height = 0
    return [px[0], px[1], px[2]]
  }, b64)
}
const near = (px, rgb, tol = 40) => Math.abs(px[0] - rgb[0]) < tol && Math.abs(px[1] - rgb[1]) < tol && Math.abs(px[2] - rgb[2]) < tol
const page1Rgb = PAGE_COLORS[0].map((v) => Math.round(v * 255))
const imageRgb = [IMAGE_RGB.r, IMAGE_RGB.g, IMAGE_RGB.b]
const counterOf = async (pg) => (await pg.locator(`${READER} span.tabular-nums`).first().innerText()).trim()
const waitCounter = async (pg, want, ms = 8000) => {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < ms) {
    last = await counterOf(pg).catch(() => '')
    if (last === want) return last
    await pg.waitForTimeout(100)
  }
  return last
}
const pageImg = (pg, n) => pg.locator(`${READER} [data-view="current"] img[alt="Page ${n} of E2E Zine"]`).first()
// The chrome hides itself after a moment and, hidden, takes no pointer
// events — a mouse reveals it by moving, which Playwright's click does not
// do until its hit test passes. So move first, as a hand would.
const revealChrome = async (pg) => {
  await pg.mouse.move(600, 380)
  await pg.waitForTimeout(120)
  await pg.mouse.move(620, 400)
  await pg.waitForTimeout(200)
}

// ───────────────────────── A. Mint form ─────────────────────────
console.log('\nA. Mint form — picking a PDF zine')
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
await wire(desktop)
{
  const warm = await desktop.newPage()
  await warm.goto(`${BASE}/mint`, { waitUntil: 'load' }).catch(() => {})
  await warm.close()
}
const mint = await desktop.newPage()
const mintSeen = trackPdfjs(mint)
mint.on('console', (m) => { if (m.type() === 'error') console.log('    [console.error]', m.text().slice(0, 140)) })
await mint.goto(`${BASE}/mint`, { waitUntil: 'domcontentloaded' })
const MEDIA_INPUT = 'input[type="file"][accept^="image/*"][accept*="model/gltf-binary"]'
await mint.waitForSelector(MEDIA_INPUT, { state: 'attached', timeout: 30000 })
{
  const accept = (await mint.locator(MEDIA_INPUT).getAttribute('accept')) ?? ''
  check('media input is unique and advertises .pdf and application/pdf',
    (await mint.locator(MEDIA_INPUT).count()) === 1 && /application\/pdf/.test(accept) && /\.pdf/.test(accept), accept)
}
check('no pdf.js asset is fetched before a PDF is picked', mintSeen.any === 0, JSON.stringify(mintSeen))

const pickZine = async (pg, file, ms = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await pg.setInputFiles(MEDIA_INPUT, path.join(DIR, file))
    for (let i = 0; i < 16; i++) {
      await pg.waitForTimeout(250)
      if ((await pg.locator('img[alt="Page 1 preview"]').count()) > 0) return 'preview'
      if ((await pg.locator('[data-sonner-toast]').count()) > 0) return 'toast'
    }
  }
  return 'timeout'
}
check('a valid PDF is accepted and previewed', (await pickZine(mint, 'zine.pdf')) === 'preview')
await mint.waitForSelector('img[alt="Page 1 preview"]', { timeout: 30000 })
await mint.waitForTimeout(500)
check('picking a PDF fetched the worker from our origin, once', mintSeen.worker === 1, JSON.stringify(mintSeen))
// Informational: in a browser pdf.js maps an unembedded standard font onto a
// system font (`useSystemFonts` defaults to true) and only fetches the copied
// font data when it needs the glyph tables, so this count is machine-dependent.
console.log(`    pdf.js assets fetched by the mint form: ${JSON.stringify(mintSeen)}`)
const previewPx = await centreOf(mint, mint.locator('img[alt="Page 1 preview"]'))
check('the preview shows page 1’s pixels (not a blank)', near(previewPx, page1Rgb), JSON.stringify(previewPx))
check('the preview counter reads 1 / 6', (await mint.locator('text=/^1 \\/ 6$/').count()) === 1)
check('page 1 is marked as the cover', (await mint.locator('text=/^cover$/').count()) === 1)
check('the optional cover-image row is offered', await mint.locator('button:has-text("upload cover")').isVisible())
await mint.screenshot({ path: path.join(SHOTS, 'z01-mint-preview.png'), clip: { x: 300, y: 120, width: 680, height: 900 } })

await mint.locator('button[aria-label="Next page"]').first().click()
await mint.waitForSelector('img[alt="Page 2 preview"]', { timeout: 30000 })
await mint.waitForTimeout(400)
check('next turns the preview to page 2', (await mint.locator('text=/^2 \\/ 6$/').count()) === 1)
const page2Px = await centreOf(mint, mint.locator('img[alt="Page 2 preview"]'))
check('page 2 shows the DCT-encoded image at its centre', near(page2Px, imageRgb), JSON.stringify(page2Px))
const useAsCover = mint.locator('button:has-text("use as cover")')
check('a non-cover page offers "use as cover"', await useAsCover.isVisible())
await useAsCover.click()
await mint.waitForTimeout(300)
check('choosing a page makes it the cover', (await mint.locator('text=/^cover$/').count()) === 1 && (await useAsCover.count()) === 0)
// The optional cover IMAGE (not a page) — the headline cover feature: once
// uploaded it is what every card and share surface shows while the pages
// stay the PDF (checkCoverImage gates it, then it becomes the cover chip).
await mint.setInputFiles('input[type="file"][accept="image/*,.gif"]', path.join(DIR, 'cover.jpg'))
await mint.waitForTimeout(600)
check('uploading a cover image makes it the cover', (await mint.locator('text=/cover image · cover\\.jpg/').count()) === 1)
check('a cover image offers to be removed', await mint.locator('button:has-text("remove")').isVisible())
await mint.locator('button:has-text("remove")').click()
await mint.waitForTimeout(300)
check('removing the cover image restores the upload-cover prompt', await mint.locator('button:has-text("upload cover")').isVisible())
// Edge: a non-image dropped on the cover slot (the artist picks the zine
// itself by mistake) is refused with the cover's own copy, and nothing is set.
await mint.setInputFiles('input[type="file"][accept="image/*,.gif"]', path.join(DIR, 'zine.pdf'))
{
  const bad = mint.locator('[data-sonner-toast]', { hasText: 'Unsupported cover' })
  let badSeen = true
  try { await bad.first().waitFor({ timeout: 15000 }) } catch { badSeen = false }
  check('a non-image cover is refused (Unsupported cover)', badSeen)
  check('a refused cover never becomes the cover', (await mint.locator('text=/cover image · /').count()) === 0)
}
await mint.waitForTimeout(4500)
// Who can read it: public by default, collectors-only an explicit choice
// that takes over the collector-download slot.
const access = mint.locator('[role="radiogroup"][aria-label="Who can read it"]')
check('the access control is offered, public by default',
  (await access.locator('[role="radio"][aria-checked="true"]').innerText()).trim().toLowerCase() === 'everyone')
await access.locator('[role="radio"]', { hasText: 'collectors only' }).click()
await mint.waitForTimeout(300)
check('collectors-only takes the collector-download slot', (await mint.locator('text=the zine is the collector file').count()) === 1)
check('the slot’s own picker is hidden while the zine holds it', (await mint.locator('button:has-text("choose file")').count()) === 0)
await access.locator('[role="radio"]', { hasText: 'everyone' }).click()
await mint.waitForTimeout(300)
check('switching back frees the slot', (await mint.locator('button:has-text("choose file")').count()) === 1)
// The optimizer is offered; on a fixture this small it reports "already
// compact" rather than replacing the file.
check('the "optimize for phones" pass is offered on the preview', await mint.locator('button:has-text("optimize for phones")').isVisible())
await mint.locator('button:has-text("optimize for phones")').click()
const compact = mint.locator('[data-sonner-toast]', { hasText: 'Already compact' })
let compactSeen = true
try { await compact.first().waitFor({ timeout: 30000 }) } catch { compactSeen = false }
check('a tiny vector PDF is reported already compact (never made bigger)', compactSeen)

// ── A2. Optimize on a file it CAN shrink: the choices that belong to the
// zine — who can read it, the page chosen as the cover — must survive the
// re-pick the optimized file goes through, and the undo after it. (The
// re-pick runs the async gate, which resets a NEW pick's choices; a timer
// cannot restore them, a carry keyed on the installed file can.)
console.log('\nA2. Optimize — the zine’s choices survive the re-pick')
await mint.locator('button:has(svg.lucide-x)').first().click()
await mint.waitForSelector('img[alt^="Page"]', { state: 'detached', timeout: 10000 })
check('a heavy scan is accepted and previewed', (await pickZine(mint, 'heavy.pdf')) === 'preview')
await mint.waitForSelector('img[alt="Page 1 preview"]', { timeout: 60000 })
await mint.locator('button[aria-label="Next page"]').first().click()
await mint.waitForSelector('img[alt="Page 2 preview"]', { timeout: 60000 })
await mint.locator('button:has-text("use as cover")').click()
await mint.waitForTimeout(300)
await access.locator('[role="radio"]', { hasText: 'collectors only' }).click()
await mint.waitForTimeout(300)
await mint.locator('button:has-text("optimize for phones")').click()
const optimizedToast = mint.locator('[data-sonner-toast]', { hasText: 'Optimized for phones' })
let optimizedSeen = true
try { await optimizedToast.first().waitFor({ timeout: 180000 }) } catch { optimizedSeen = false }
check('a heavy scan is optimized (a smaller file is installed)', optimizedSeen)
await mint.locator('text=/^was /').first().waitFor({ timeout: 30000 }).catch(() => {})
await mint.waitForSelector('img[alt="Page 1 preview"]', { timeout: 60000 })
await mint.waitForTimeout(600)
const checkedAccess = async () => (await access.locator('[role="radio"][aria-checked="true"]').innerText()).trim().toLowerCase()
check('"collectors only" survives the optimized re-pick', (await checkedAccess()) === 'collectors only', await checkedAccess())
// Page 1 is not the cover (page 2 was chosen), so it still offers the button.
check('the page chosen as the cover survives the re-pick', (await mint.locator('button:has-text("use as cover")').count()) === 1)
await mint.locator('button:has-text("undo")').click()
await mint.locator('text=/^was /').first().waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
await mint.waitForSelector('img[alt="Page 1 preview"]', { timeout: 60000 })
await mint.waitForTimeout(600)
check('"collectors only" survives the undo as well', (await checkedAccess()) === 'collectors only', await checkedAccess())
check('the cover page survives the undo as well', (await mint.locator('button:has-text("use as cover")').count()) === 1)
// Leaving the pick mid-pass aborts the pass: no result, no error, nothing
// rendered for a file nobody will mint.
await mint.waitForTimeout(4500) // let the earlier toasts expire
await mint.locator('button:has-text("optimize for phones")').click()
await mint.waitForTimeout(500)
await mint.locator('button:has(svg.lucide-x)').first().click()
await mint.waitForSelector('img[alt^="Page"]', { state: 'detached', timeout: 10000 })
await mint.waitForTimeout(4000)
check('clearing the pick mid-optimize aborts the pass silently',
  (await mint.locator('[data-sonner-toast]', { hasText: /Optimized for phones|Could not optimize/ }).count()) === 0)

// Clear via the form's own × (unless the abort check already did), then the rejections.
if (await mint.locator('img[alt^="Page"]').count()) {
  await mint.locator('button:has(svg.lucide-x)').first().click()
  await mint.waitForSelector('img[alt^="Page"]', { state: 'detached', timeout: 10000 })
}
console.log('\nB. Mint gate — rejections')
for (const [file, expect] of [
  ['notapdf.pdf', 'or a PDF zine'],
  ['too-many.pdf', '420 pages'],
  // A real password-protected PDF and a real broken one: the oracle pins the
  // gate's REASONS with a fake inspector; these drive pdf.js itself, so the
  // PasswordException → PdfPasswordError → {kind:'password'} mapping and the
  // malformed → {kind:'unreadable'} mapping (lib/pdfjs.inspectPdfFile) are
  // proven against the real parser, not a stand-in.
  ['locked.pdf', 'without a password'],
  ['broken.pdf', 'could not be read'],
]) {
  await pickZine(mint, file)
  const toast = mint.locator('[data-sonner-toast]', { hasText: expect })
  let matched = true
  try { await toast.first().waitFor({ timeout: 15000 }) } catch { matched = false }
  check(`${file} is rejected with the right reason`, matched,
    matched ? '' : JSON.stringify((await mint.locator('[data-sonner-toast]').allInnerTexts()).join(' | ').slice(0, 160)))
  check(`${file} leaves no preview mounted`, (await mint.locator('img[alt^="Page"]').count()) === 0)
  await mint.waitForTimeout(4500)
}
// A zine over the 16 MiB soft warning is ACCEPTED (it is under the hard cap),
// with a warning that names the optimizer — the only place MintForm's
// ZINE_SOFT_WARN_BYTES branch fires.
await mint.setInputFiles(MEDIA_INPUT, path.join(DIR, 'big.pdf'))
{
  const warn = mint.locator('[data-sonner-toast]', { hasText: 'Large zine' })
  let warned = true
  try { await warn.first().waitFor({ timeout: 30000 }) } catch { warned = false }
  check('a zine over the soft limit warns and names "optimize for phones"', warned &&
    /Optimize for phones/i.test((await warn.first().innerText()).replace(/\s+/g, ' ')))
}
await mint.waitForSelector('img[alt="Page 1 preview"]', { timeout: 60000 })
check('…and is still accepted (previewed, not rejected)', (await mint.locator('img[alt="Page 1 preview"]').count()) === 1)
await mint.locator('button:has(svg.lucide-x)').first().click()
await mint.waitForSelector('img[alt^="Page"]', { state: 'detached', timeout: 10000 })
await mint.waitForTimeout(4500)

check('a one-page PDF is accepted (the page is the cover)', (await pickZine(mint, 'one-page.pdf')) === 'preview')
await mint.waitForTimeout(400)
check('its counter reads 1 / 1', (await mint.locator('text=/^1 \\/ 1$/').count()) === 1)
await mint.close()

// ───────────── C0. Opening: the cover becomes the reader before the file arrives ─────────────
console.log('\nC0. Opening — the cover expands into the reader before the file has arrived')
{
  const openPg = await desktop.newPage()
  // Hold the zine's bytes back: the frame must not wait for them.
  await openPg.route(/arweave\.net|api\/img/, async (r) => {
    if (!decodeURIComponent(r.request().url()).includes('zine-txid')) return r.fallback()
    await new Promise((res) => setTimeout(res, 1500))
    return r.fulfill({ status: 200, contentType: 'application/pdf', body: ZINE }).catch(() => {})
  })
  // The image optimizer refuses this cover, slowly (a heavy scan past its
  // body cap), so the slot's cover arrives through the proxy fallback — the
  // case where a second image component would start over at the optimizer
  // and expand a blank skeleton.
  await openPg.route('**/_next/image**', async (r) => {
    await new Promise((res) => setTimeout(res, 800))
    return r.fulfill({ status: 500, body: '' }).catch(() => {})
  })
  await openPg.goto(ART, { waitUntil: 'domcontentloaded' })
  const openBtn = openPg.locator('button:has-text("read · 6 pages")')
  await openBtn.waitFor({ timeout: 30000 })
  await openPg.locator('img[alt="E2E Zine"]').first().waitFor({ timeout: 30000 })
  // A reader taps a cover they can see: the slot's image has loaded.
  await openPg.waitForFunction(() => {
    const img = document.querySelector('img[alt="E2E Zine"]')
    return !!img && img.complete && img.naturalWidth > 0
  }, null, { timeout: 30000 })
  await openPg.waitForTimeout(600)
  const tTap = Date.now()
  await openBtn.click()
  const frame = openPg.locator('[role="dialog"][aria-label="Opening E2E Zine"]')
  await frame.waitFor({ timeout: 2000 })
  const upAfter = Date.now() - tTap
  // The frame draws the very bitmap that was tapped (the slot's decoded
  // image), so the expand never starts on a loading skeleton.
  const coverAtOnce = await frame.locator('img').first().evaluate((img) => img.complete && img.naturalWidth > 0)
  check('the opening frame is up at once, long before the file has arrived', upAfter < 600, `${upAfter} ms`)
  check('…with the cover itself in it from the first frame (already decoded, no skeleton)', coverAtOnce)
  await openPg.waitForTimeout(500) // the expand has played
  const frameCover = await frame.locator('img').first().boundingBox()
  check('the cover settles where the first page will sit (centred, fit to the stage)',
    !!frameCover && frameCover.height > 700 && Math.abs(frameCover.x + frameCover.width / 2 - 640) < 4, JSON.stringify(frameCover))
  check('the frame shows the download as it happens', (await frame.locator('[role="progressbar"]').count()) === 1)
  const frameLight = await frame.locator('div').first().evaluate((d) => d.style.background)
  // The fixture cover is magenta (190, 40, 150); the light must be that colour.
  const tint = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*0\.2\)/.exec(frameLight)
  check('the frame is lit by the cover’s own colour (from its thumbhash)',
    !!tint && +tint[1] > 140 && +tint[2] < 90 && +tint[3] > 100, frameLight.slice(0, 120))
  await openPg.locator(`${READER} [data-view="current"] img[alt="Page 1 of E2E Zine"]`).waitFor({ timeout: 30000 })
  await frame.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  check('the frame hands off to the reader and is gone', (await frame.count()) === 0)
  const firstPage = await pageImg(openPg, 1).boundingBox()
  check('page 1 lands where the cover was — no jump at the handoff',
    !!frameCover && !!firstPage && Math.abs(firstPage.x - frameCover.x) < 6 && Math.abs(firstPage.height - frameCover.height) < 8,
    `${JSON.stringify(frameCover)} → ${JSON.stringify(firstPage)}`)
  check('the reader keeps the frame’s light', /radial-gradient/.test(await openPg.locator(`${READER} > div`).first().evaluate((d) => d.style.background)))
  check('focus rests on the dialog, not on a hidden button',
    await openPg.evaluate(() => document.activeElement?.getAttribute('role') === 'dialog'))
  await openPg.keyboard.press('Escape')
  await openPg.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10000 })
  check('Escape closes the reader (a short fade, then gone)', (await openPg.locator('[role="dialog"]').count()) === 0)
  // Cancelling while the file is still on its way.
  await openBtn.click()
  await frame.waitFor({ timeout: 2000 })
  await openPg.waitForTimeout(300)
  await openPg.keyboard.press('Escape')
  await openPg.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {})
  check('Escape cancels from the opening frame, mid-download', (await openPg.locator('[role="dialog"]').count()) === 0 && (await openBtn.isVisible()))
  await openPg.waitForTimeout(2000) // the held response lands after the cancel
  check('…and a response that lands after the cancel opens nothing', (await openPg.locator('[role="dialog"]').count()) === 0)
  check('…and leaves the page scrollable again', await openPg.evaluate(() => document.body.style.overflow !== 'hidden'))
  await openPg.close()
}

// ───────────────── C. Artwork detail, desktop: the reader ─────────────────
console.log('\nC. Artwork detail (desktop) — the reader')
const page = await desktop.newPage()
const seen = trackPdfjs(page)
page.on('console', (m) => { if (m.type() === 'error') console.log('    [console.error]', m.text().slice(0, 140)) })
page.on('pageerror', (e) => console.log('    [pageerror]', String(e).slice(0, 300)))
await page.goto(ART, { waitUntil: 'domcontentloaded' })
const readBtn = page.locator('button:has-text("read · 6 pages")')
await readBtn.waitFor({ timeout: 30000 })
check('idle state offers "read · 6 pages"', await readBtn.isVisible())
check('the cover paints before any tap', await page.locator('img[alt="E2E Zine"]').first().isVisible().catch(() => false))
check('no pdf.js asset is fetched before the tap', seen.any === 0, JSON.stringify(seen))
check('no reader dialog exists before the tap', (await page.locator('[role="dialog"]').count()) === 0)
await page.screenshot({ path: path.join(SHOTS, 'z02-detail-idle.png'), clip: { x: 0, y: 100, width: 700, height: 760 } })

await readBtn.click()
await page.waitForSelector('[role="dialog"][aria-label="Reading E2E Zine"]', { timeout: 30000 })
await pageImg(page, 1).waitFor({ timeout: 30000 })
await page.waitForTimeout(400)
check('the tap fetched the worker once', seen.worker === 1, JSON.stringify(seen))
check('focus moves into the reader', await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))
// The chrome hides itself; keyboard focus landing on it brings it back, so
// Tab never rests on an invisible control.
const topBarOf = (pg) => pg.locator(`${READER} div.absolute.left-0.right-0.z-10`).first()
await page.waitForTimeout(3200)
check('the chrome hides on its own on a desktop too', ((await topBarOf(page).getAttribute('class')) ?? '').includes('opacity-0'))
await page.keyboard.press('Tab')
await page.waitForTimeout(250)
check('Tab reveals the hidden chrome', ((await topBarOf(page).getAttribute('class')) ?? '').includes('opacity-100'))
check('page 1 renders its pixels', near(await centreOf(page, pageImg(page, 1)), page1Rgb))
check('no canvas is left in the DOM (pages are images, canvases are zeroed and dropped)', (await page.locator('canvas').count()) === 0)
check('the cover opens alone even on a wide screen (a spread starts at page 2)', (await waitCounter(page, '1 / 6')) === '1 / 6')
check('the scrubber spans the document', (await page.locator('[role="dialog"] input[type="range"]').getAttribute('max')) === '6')
const dl = page.locator('[role="dialog"] a[aria-label="Download PDF"]')
check('"Download PDF" links to the gateway, not the proxy', ((await dl.getAttribute('href')) ?? '').includes('arweave.net/zine-txid'), String(await dl.getAttribute('href')))
await page.screenshot({ path: path.join(SHOTS, 'z03-reader-cover.png') })

await page.keyboard.press('ArrowRight')
check('ArrowRight on a wide screen turns to the 2–3 spread', (await waitCounter(page, '2–3 / 6')) === '2–3 / 6')
await pageImg(page, 2).waitFor({ timeout: 30000 })
await pageImg(page, 3).waitFor({ timeout: 30000 })
check('both pages of the spread are on screen', (await pageImg(page, 2).isVisible()) && (await pageImg(page, 3).isVisible()))
// The URL follows the page the reader settles on (a scrubber drag must not
// call replaceState once per page — WebKit throws past ~100 in 10 s).
await page.waitForFunction(() => location.search.includes('page=2'), null, { timeout: 3000 }).catch(() => {})
check('the URL carries the page for sharing', page.url().includes('page=2'), page.url())
await page.screenshot({ path: path.join(SHOTS, 'z04-reader-spread.png') })
await page.keyboard.press('End')
check('End goes to the back cover, alone', (await waitCounter(page, '6 / 6')) === '6 / 6')
await page.keyboard.press('Home')
check('Home returns to the cover', (await waitCounter(page, '1 / 6')) === '1 / 6')
await page.waitForFunction(() => !location.search.includes('page='), null, { timeout: 3000 }).catch(() => {})
check('page 1 drops the URL parameter', !page.url().includes('page='), page.url())

// Every page-turn key runs its branch (ArrowRight is above; here ArrowUp,
// PageUp, Backspace, Space and Shift+Space — the reader's whole key map).
// Focus the dialog, not the scrubber: a focused range input would eat the
// arrows natively (and the reader's handler early-returns on an INPUT target).
await page.locator('[role="dialog"]').first().focus()
for (const [key, to] of [
  ['ArrowRight', '2–3 / 6'], ['ArrowUp', '1 / 6'],
  ['ArrowRight', '2–3 / 6'], ['PageUp', '1 / 6'],
  ['ArrowRight', '2–3 / 6'], ['Backspace', '1 / 6'],
  ['Space', '2–3 / 6'], ['Shift+Space', '1 / 6'],
]) {
  await page.keyboard.press(key)
  check(`${key} turns the spread to ${to}`, (await waitCounter(page, to)) === to, await counterOf(page))
}

await revealChrome(page)
await page.locator('[role="dialog"] button[aria-label="Show single pages"]').click()
await page.keyboard.press('ArrowRight')
check('single-page mode turns one page at a time', (await waitCounter(page, '2 / 6')) === '2 / 6')
const img2 = pageImg(page, 2)
await img2.waitFor({ timeout: 30000 })
const before = await img2.boundingBox()
await img2.dblclick()
await page.waitForTimeout(500)
const after = await img2.boundingBox()
check('double-click zooms the page', !!before && !!after && after.width > before.width * 2, `${before?.width} -> ${after?.width}`)
await img2.dblclick()
await page.waitForTimeout(400)
const reset = await img2.boundingBox()
check('a second double-click resets the zoom', !!reset && Math.abs(reset.width - before.width) < 2, `${reset?.width}`)
// ctrl/⌘ + wheel (a trackpad pinch) zooms the reader and is consumed — the
// listener is native and non-passive, so the page behind never zooms too.
await page.evaluate(() => {
  window.__wheelPrevented = null
  window.addEventListener('wheel', (e) => { window.__wheelPrevented = e.defaultPrevented }, { passive: true })
})
const beforeWheel = await pageImg(page, 2).boundingBox()
await page.mouse.move(640, 400)
await page.keyboard.down('Control')
await page.mouse.wheel(0, -240)
await page.keyboard.up('Control')
await page.waitForTimeout(400)
const afterWheel = await pageImg(page, 2).boundingBox()
check('ctrl+wheel zooms the page and the event is consumed',
  (await page.evaluate(() => window.__wheelPrevented)) === true && !!beforeWheel && !!afterWheel && afterWheel.width > beforeWheel.width * 1.05,
  `prevented=${await page.evaluate(() => window.__wheelPrevented)} ${beforeWheel?.width} -> ${afterWheel?.width}`)
// Keyboard zoom (+/-/0), single-page mode only. Focus the dialog first so the
// keys reach the reader, not whatever control last held focus.
await page.locator('[role="dialog"]').first().focus()
const kz0 = await pageImg(page, 2).boundingBox()
await page.keyboard.press('=')
await page.waitForTimeout(250)
const kzIn = await pageImg(page, 2).boundingBox()
check('"=" zooms the page in', !!kz0 && !!kzIn && kzIn.width > kz0.width * 1.2, `${kz0?.width} -> ${kzIn?.width}`)
await page.keyboard.press('-')
await page.waitForTimeout(250)
const kzOut = await pageImg(page, 2).boundingBox()
check('"-" zooms the page back out', !!kzOut && !!kzIn && kzOut.width < kzIn.width, `${kzIn?.width} -> ${kzOut?.width}`)
await page.keyboard.press('0')
await page.waitForTimeout(300)
// Browser and system shortcuts stay theirs: with ⌘ (Meta) or Alt held, a
// reader key does nothing in the reader — ⌘R must reload, not rotate, and
// ⌘+ zoom the browser, not the page. (Ctrl+R would reload this very page.)
const km0 = await pageImg(page, 2).boundingBox()
await page.keyboard.press('Meta+=')
await page.keyboard.press('Alt+r')
await page.waitForTimeout(350)
const km1 = await pageImg(page, 2).boundingBox().catch(() => null)
check('with ⌘ or Alt held, the reader leaves the key to the browser (no zoom, no rotation)',
  !!km0 && !!km1 && Math.abs(km1.width - km0.width) < 2 && Math.abs(km1.height - km0.height) < 2, `${JSON.stringify(km0)} -> ${JSON.stringify(km1)}`)
// Should the guard ever break, undo what it let through: a rotation is
// remembered per artwork and would otherwise fail every later section.
if (km0 && (!km1 || Math.abs(km1.width / km1.height - km0.width / km0.height) > 0.2)) {
  await page.keyboard.press('Shift+R')
  await pageImg(page, 2).waitFor({ timeout: 30000 }).catch(() => {})
}
await page.keyboard.press('0')
await page.waitForTimeout(300)
// A plain wheel flick (no modifier, not zoomed) turns the page — the other
// half of the native wheel listener the ctrl+wheel check exercised.
await page.mouse.move(640, 400)
await page.mouse.wheel(0, 240)
check('a plain wheel flick turns the page forward', (await waitCounter(page, '3 / 6')) === '3 / 6', await counterOf(page))
await page.waitForTimeout(500) // the wheel has a 400 ms cooldown
await page.mouse.wheel(0, -240)
check('a wheel flick back turns the page back', (await waitCounter(page, '2 / 6')) === '2 / 6', await counterOf(page))
await revealChrome(page)
await page.locator('[role="dialog"] input[type="range"]').fill('5')
check('the scrubber jumps straight to a page', (await waitCounter(page, '5 / 6')) === '5 / 6')
// Rotation: a landscape scan read upright. The page's box flips its aspect
// and the counter stays put.
{
  try {
    await pageImg(page, 5).waitFor({ timeout: 30000 })
  } catch {
    // Diagnostics before the assertion below fails: what the stage holds.
    console.log('    stage after the scrubber jump:', JSON.stringify(await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')
      return {
        imgs: [...(d?.querySelectorAll('img') ?? [])].map((i) => i.getAttribute('alt')),
        tiles: [...(d?.querySelectorAll('[role="img"]') ?? [])].map((i) => i.getAttribute('aria-label')),
        skeletons: d?.querySelectorAll('.animate-pulse').length ?? 0,
        counter: d?.querySelector('span.tabular-nums')?.textContent,
      }
    })))
  }
  const portrait = await pageImg(page, 5).boundingBox()
  await revealChrome(page)
  await page.locator('[role="dialog"] button[aria-label="Rotate pages"]').click()
  await pageImg(page, 5).waitFor({ timeout: 30000 })
  await page.waitForTimeout(400)
  const turned = await pageImg(page, 5).boundingBox()
  check('rotating turns the page a quarter turn (aspect flips)',
    !!portrait && !!turned && portrait.height > portrait.width && turned.width > turned.height, `${JSON.stringify(portrait)} -> ${JSON.stringify(turned)}`)
  check('rotating keeps the place', (await counterOf(page)) === '5 / 6')
  await page.keyboard.press('r')
  await page.keyboard.press('r')
  await page.keyboard.press('r')
  await pageImg(page, 5).waitFor({ timeout: 30000 })
  await page.waitForTimeout(400)
  const back = await pageImg(page, 5).boundingBox()
  check('three more quarter turns are upright again', !!back && back.height > back.width)
  // Shift+R turns the OTHER way (rotateBack) — the key, not the button.
  await page.keyboard.press('Shift+R')
  await pageImg(page, 5).waitFor({ timeout: 30000 })
  await page.waitForTimeout(300)
  const other = await pageImg(page, 5).boundingBox()
  check('Shift+R turns the other way (aspect flips, place kept)',
    !!back && !!other && other.width > other.height && (await counterOf(page)) === '5 / 6')
  await page.keyboard.press('r') // restore upright
  await pageImg(page, 5).waitFor({ timeout: 30000 })
  await page.waitForTimeout(300)
}
await page.keyboard.press('Escape')
await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10000 })
check('Escape closes the reader', (await page.locator('[role="dialog"]').count()) === 0)
check('focus returns to the read button', await page.evaluate(() => (document.activeElement?.textContent ?? '').includes('read')))
check('closing restores the affordance', await page.locator('button:has-text("read · 6 pages")').isVisible())
check('closing leaves no reader entry behind (the URL is the artwork’s)', page.url().startsWith(ART) && !page.url().includes('page='), page.url())
// The back gesture closes the reader, not the artwork: opening pushes one
// history entry, and going back pops it.
await page.locator('button:has-text("read · 6 pages")').click()
await page.waitForSelector('[role="dialog"][aria-label="Reading E2E Zine"]', { timeout: 30000 })
// The reader was closed on page 5, so it reopens there (localStorage
// resume), not on the cover — on this wide viewport that is the 4–5 spread.
await pageImg(page, 5).waitFor({ timeout: 30000 })
check('reopening resumes at the last page read', (await counterOf(page)) === '4–5 / 6', await counterOf(page))
// One pdf.js worker per page session: the second open reuses the first
// open's worker (pdf.js only destroys a worker it created itself).
check('reopening reuses the worker (no second worker fetch)', seen.worker === 1, JSON.stringify(seen))
await page.keyboard.press('Home')
await waitCounter(page, '1 / 6')
await page.keyboard.press('ArrowRight')
await waitCounter(page, '2–3 / 6')
await page.goBack()
await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10000 })
check('browser back closes the reader', (await page.locator('[role="dialog"]').count()) === 0)
check('browser back stays on the artwork page', page.url().startsWith(ART), page.url())
check('the affordance is back after a history close', await page.locator('button:has-text("read · 6 pages")').isVisible())
// A reader entry left by an EARLIER open, reached through forward: the
// reader does not reopen on it, and a reader opened over it still closes
// with one press (per-open tokens, not a boolean marker).
await page.goForward()
await page.waitForTimeout(500)
check('forward onto an old reader entry does not reopen the reader', (await page.locator('[role="dialog"]').count()) === 0)
await page.locator('button:has-text("read · 6 pages")').click()
await page.waitForSelector('[role="dialog"][aria-label="Reading E2E Zine"]', { timeout: 30000 })
await page.locator(`${READER} [data-view="current"] img[alt^="Page "]`).first().waitFor({ timeout: 30000 })
await page.keyboard.press('Escape')
await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10000 }).catch(() => {})
check('one Escape closes a reader opened over an older reader entry', (await page.locator('[role="dialog"]').count()) === 0)
check('…and the artwork page is still the page', page.url().startsWith(ART), page.url())
await page.close()

// ───────────── C1. A long zine: render cancellation, the slot's real width ─────────────
console.log('\nC1. A long zine — flips cancel renders; a page is rendered for its real slot')
const LONG_META = { ...ZINE_META, metadata: { ...ZINE_META.metadata, name: 'E2E Long', animation_url: 'ar://long-txid', content: { uri: 'ar://long-txid', mime: 'application/pdf' }, kismet_zine: { pages: 60, access: 'public' } } }
const longPg = await desktop.newPage()
// Count the reader's URL writes (replaceState calls carrying ?page=).
await longPg.addInitScript(() => {
  window.__pageWrites = 0
  const orig = history.replaceState
  history.replaceState = function (state, unused, url) {
    if (url && String(url).includes('page=')) window.__pageWrites++
    return orig.call(this, state, unused, url)
  }
})
await longPg.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LONG_META) }))
await longPg.goto(ART, { waitUntil: 'domcontentloaded' })
await longPg.locator('button:has-text("read · 60 pages")').click()
await longPg.waitForSelector('[role="dialog"][aria-label="Reading E2E Long"]', { timeout: 30000 })
// The context remembers this artwork's reading position from the sections
// above (same key), so the reader may resume mid-document: go Home first.
await longPg.locator(`${READER} [data-view="current"] img[alt^="Page "]`).first().waitFor({ timeout: 60000 })
await longPg.keyboard.press('Home')
await longPg.locator(`${READER} [data-view="current"] img[alt="Page 1 of E2E Long"]`).waitFor({ timeout: 60000 })
await longPg.keyboard.press('ArrowRight')
const long2 = longPg.locator(`${READER} [data-view="current"] img[alt="Page 2 of E2E Long"]`)
await long2.waitFor({ timeout: 60000 })
await longPg.waitForTimeout(400)
const slot = await long2.evaluate((img) => ({ nw: img.naturalWidth, cw: img.clientWidth, dpr: window.devicePixelRatio }))
check('a landscape page is rendered for its real slot, not a guessed aspect', slot.nw >= slot.cw * slot.dpr * 0.95, JSON.stringify(slot))
await longPg.keyboard.press('Home')
await longPg.locator(`${READER} [data-view="current"] img[alt="Page 1 of E2E Long"]`).waitFor({ timeout: 60000 })
await longPg.waitForTimeout(1500)
// Drag the scrubber across the document: 59 steps as fast as the keyboard
// sends them. Every page is slow to render (the noise image); without
// cancellation each one would render to completion before page 60 could.
await revealChrome(longPg)
const slider = longPg.locator('[role="dialog"] input[type="range"]')
await slider.focus()
const rendersBefore = await longPg.evaluate(() => window.__pdfRenders)
const writesBefore = await longPg.evaluate(() => window.__pageWrites)
const t0 = Date.now()
for (let i = 0; i < 59; i++) await longPg.keyboard.press('ArrowRight')
await longPg.locator(`${READER} [data-view="current"] img[alt="Page 60 of E2E Long"]`).waitFor({ timeout: 30000 })
const landed = Date.now() - t0
const rendersDuring = (await longPg.evaluate(() => window.__pdfRenders)) - rendersBefore
check('a scrubber drag across 60 pages renders only what it lands on', rendersDuring <= 12, `${rendersDuring} renders started`)
check('…and the target page is on screen within seconds', landed < 15000, `${landed} ms`)
console.log(`    renders started during the drag: ${rendersDuring}; page 60 on screen after ${landed} ms`)
await longPg.waitForFunction(() => location.search.includes('page=60'), null, { timeout: 3000 }).catch(() => {})
const writes = (await longPg.evaluate(() => window.__pageWrites)) - writesBefore
check('…and writes the URL once it settles, not once per page (WebKit throws past ~100 in 10 s)',
  writes <= 3 && longPg.url().includes('page=60'), `${writes} URL writes; ${longPg.url()}`)
await longPg.keyboard.press('Escape')
await longPg.close()

// ───────────── C2. An odd page count: no phantom turn past the back cover ─────────────
console.log('\nC2. An odd page count — the last spread ends the book')
const ODD_META = { ...ZINE_META, metadata: { ...ZINE_META.metadata, name: 'E2E Odd', animation_url: 'ar://odd-txid', content: { uri: 'ar://odd-txid', mime: 'application/pdf' }, kismet_zine: { pages: 5, access: 'public' } } }
const oddPg = await desktop.newPage()
await oddPg.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ODD_META) }))
await oddPg.goto(ART, { waitUntil: 'domcontentloaded' })
await oddPg.locator('button:has-text("read · 5 pages")').click()
await oddPg.waitForSelector('[role="dialog"][aria-label="Reading E2E Odd"]', { timeout: 30000 })
await oddPg.locator(`${READER} [data-view="current"] img[alt^="Page "]`).first().waitFor({ timeout: 30000 })
await oddPg.keyboard.press('End')
check('End lands on the 4–5 spread', (await waitCounter(oddPg, '4–5 / 5')) === '4–5 / 5')
const oddUrl = oddPg.url()
await oddPg.keyboard.press('ArrowRight')
await oddPg.waitForTimeout(500)
check('ArrowRight past the last spread turns nothing', (await counterOf(oddPg)) === '4–5 / 5' && oddPg.url() === oddUrl)
await revealChrome(oddPg)
check('the next button is disabled on the last spread', await oddPg.locator('[role="dialog"] button[aria-label="Next page"]').isDisabled())
await oddPg.keyboard.press('Escape')
await oddPg.close()

// ───────────── C3. A failed open: no dead history entry ─────────────
console.log('\nC3. A failed open — the error state lives inside the history entry')
const failPg = await desktop.newPage()
await failPg.route(/arweave\.net|api\/img/, (r) => (decodeURIComponent(r.request().url()).includes('zine-txid') ? r.fulfill({ status: 500, body: 'nope' }) : r.fallback()))
await failPg.goto(ART, { waitUntil: 'domcontentloaded' })
await failPg.locator('button:has-text("read · 6 pages")').click()
await failPg.locator('button:has-text("retry")').waitFor({ timeout: 90000 })
const failUrl = failPg.url()
const lenAtError = await failPg.evaluate(() => history.length)
await failPg.locator('button:has-text("retry")').click()
await failPg.waitForTimeout(600)
await failPg.locator('button:has-text("retry")').waitFor({ timeout: 90000 })
check('a retry adds no history entry', (await failPg.evaluate(() => history.length)) === lenAtError)
await failPg.goBack()
await failPg.waitForTimeout(600)
check('back from a failed open restores the affordance, not a dead entry', (await failPg.locator('button:has-text("read · 6 pages")').count()) === 1 && failPg.url() === failUrl, failPg.url())
await failPg.close()
// No cover to show AND a file that will not open: the failure still stays in
// the frame — retry, the PDF itself — and closing it returns to the read
// button. The slot is never handed back mid-error.
{
  const nc = await desktop.newPage()
  const NO_COVER = { ...ZINE_META, metadata: { ...ZINE_META.metadata, image: undefined } }
  await nc.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NO_COVER) }))
  await nc.route(/arweave\.net|api\/img/, (r) => (decodeURIComponent(r.request().url()).includes('zine-txid') ? r.fulfill({ status: 500, body: 'nope' }) : r.fallback()))
  await nc.goto(ART, { waitUntil: 'domcontentloaded' })
  const ncRead = nc.locator('button:has-text("read · 6 pages")')
  await ncRead.waitFor({ timeout: 30000 })
  await ncRead.click()
  const ncRetry = nc.locator('[role="dialog"][aria-label^="Opening"] button:has-text("retry")')
  await ncRetry.waitFor({ timeout: 90000 }).catch(() => {})
  await nc.waitForTimeout(1000)
  check('with no cover and a file that will not open, the failure stays in the frame (retry, the PDF)',
    (await ncRetry.count()) === 1 && (await nc.locator('[role="dialog"] >> text=open the PDF').count()) === 1)
  await nc.keyboard.press('Escape')
  await nc.waitForTimeout(800)
  check('…and closing it returns to the read button, the artwork still the page', (await ncRead.isVisible().catch(() => false)) && nc.url() === ART, nc.url())
  await nc.close()
}

// ───────────── C3. Collectors-only zine: the card for a non-holder ─────────────
// The zine IS the collector file. Its record is seeded into the Redis stub
// (scripts/e2e/redis-stub.mjs keeps a plain SET), so the server-rendered
// page carries the public descriptor exactly as production does — the card
// mounts from first paint and, for a non-holder, never asks /status. The
// moment itself is an image moment (the cover) carrying the hint.
console.log('\nC3. Collectors-only zine — the card, seen by a non-holder')
const PRIVATE_META = {
  ...ZINE_META,
  metadata: {
    name: 'E2E Private Zine',
    description: 'Collectors only.',
    image: 'ar://cover-txid',
    kismet_zine: { pages: 6, access: 'collectors' },
  },
}
const redis = (cmd) => fetch('http://localhost:6399', { method: 'POST', body: JSON.stringify(cmd) }).then((r) => r.json())
const [, artAddress, artToken] = new URL(ART).pathname.match(/\/artwork\/([^/]+)\/([^/]+)/)
const CFILE_KEY = `kismetart:cfile:${artAddress.toLowerCase()}:${BigInt(artToken)}`
const seededAt = Date.now()
await redis(['SET', CFILE_KEY, JSON.stringify({
  current: { v: 1, blobSeq: 1, chunks: 1, size: 2400000, sha256: 'ab'.repeat(32), kind: 'pdf', pages: 6, name: 'issue-1.pdf', updatedAt: seededAt, updatedBy: '0x000000000000000000000000000000000000dead', stored: true },
  history: [], nextBlobSeq: 2, createdAt: seededAt,
})])
const priv = await desktop.newPage()
const privSeen = trackPdfjs(priv)
let statusFetches = 0
priv.on('request', (r) => { if (r.url().includes('/api/collector-file/status')) statusFetches++ })
await priv.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRIVATE_META) }))
await priv.goto(ART, { waitUntil: 'domcontentloaded' })
await priv.locator('text=collectors-only zine').first().waitFor({ timeout: 30000 }).catch(() => {})
await priv.waitForTimeout(1500)
check('the card names the zine with its page count', (await priv.locator('p', { hasText: /collectors-only zine · issue-1\.pdf · .* · 6 pages · v1/ }).count()) === 1)
check('a non-holder is told to collect to READ', (await priv.locator('text=collect to read').count()) === 1)
check('a non-holder gets no read button', (await priv.locator('button:has-text("read")').count()) === 0)
check('the media slot shows the cover, with no reader affordance (the pages are not in the metadata)',
  (await priv.locator('img[alt="E2E Private Zine"]').first().isVisible().catch(() => false)) && (await priv.locator('button:has-text("read · 6 pages")').count()) === 0)
check('nothing from pdf.js is fetched for a non-holder', privSeen.any === 0, JSON.stringify(privSeen))
check('a server-rendered page with a known descriptor costs a non-holder no status request', statusFetches === 0, String(statusFetches))
await priv.screenshot({ path: path.join(SHOTS, 'z08-private-card.png'), clip: { x: 0, y: 100, width: 1280, height: 900 } })
await priv.close()
// A PDF collector file that is NOT the artwork's zine — a print-res export
// beside a public zine (§11): readable like any PDF, never called a zine.
await redis(['SET', CFILE_KEY, JSON.stringify({
  current: { v: 1, blobSeq: 1, chunks: 1, size: 2400000, sha256: 'cd'.repeat(32), kind: 'pdf', pages: 6, name: 'print-res.pdf', updatedAt: seededAt, updatedBy: '0x000000000000000000000000000000000000dead', stored: true },
  history: [], nextBlobSeq: 2, createdAt: seededAt,
})])
const extraPg = await desktop.newPage()
await extraPg.goto(ART, { waitUntil: 'domcontentloaded' })
await extraPg.locator('text=print-res.pdf').first().waitFor({ timeout: 30000 }).catch(() => {})
await extraPg.waitForTimeout(1500)
check('a PDF collector file beside a public zine is a collector download, not a zine',
  (await extraPg.locator('p', { hasText: /collector download · print-res\.pdf · .* · 6 pages · v1/ }).count()) === 1 && (await extraPg.locator('text=collectors-only zine').count()) === 0)
check('…and a non-holder is told to collect to download', (await extraPg.locator('text=collect to download').count()) === 1)
await extraPg.close()
await redis(['DEL', CFILE_KEY])

// ───────────── C4. Dragging: the page follows the hand ─────────────
console.log('\nC4. Dragging — the page follows the hand, and lets go the way a page would')
{
  const dragPg = await desktop.newPage()
  await dragPg.goto(ART, { waitUntil: 'domcontentloaded' })
  await dragPg.locator('button:has-text("read · 6 pages")').click()
  await dragPg.waitForSelector(READER, { timeout: 30000 })
  await dragPg.locator(`${READER} [data-view="current"] img[alt^="Page "]`).first().waitFor({ timeout: 30000 })
  await dragPg.keyboard.press('Home')
  await waitCounter(dragPg, '1 / 6')
  await pageImg(dragPg, 1).waitFor({ timeout: 30000 })
  await dragPg.locator(`${READER} [data-view="next"] img[alt="Page 2 of E2E Zine"]`).waitFor({ state: 'attached', timeout: 30000 })
  await dragPg.waitForTimeout(600)
  const rest = await pageImg(dragPg, 1).boundingBox()
  const drag = async (x0, x1, { steps = 15, hold = 0, gap = 0 } = {}) => {
    await dragPg.mouse.move(x0, 400)
    await dragPg.mouse.down()
    for (let i = 1; i <= steps; i++) {
      await dragPg.mouse.move(x0 + ((x1 - x0) * i) / steps, 400)
      // Paced between moves, never after the last: a hand lifts while it
      // is still moving (a release long after the last move is a hand that
      // had stopped, and reads as no throw at all).
      if (gap && i < steps) await dragPg.waitForTimeout(gap)
    }
    if (hold) await dragPg.waitForTimeout(hold)
  }

  // Past the cover there is nothing to turn to: the drag gives like a rubber band.
  await drag(400, 700)
  const pulled = await pageImg(dragPg, 1).boundingBox()
  const give = pulled.x - rest.x
  check('dragging back from the cover is resisted (the page gives less than half the hand)', give > 40 && give < 150, `${Math.round(give)} px for a 300 px drag`)
  await dragPg.waitForTimeout(250)
  await dragPg.mouse.up()
  await dragPg.waitForTimeout(500)
  check('…and springs back to the cover', (await counterOf(dragPg)) === '1 / 6' && Math.abs((await pageImg(dragPg, 1).boundingBox()).x - rest.x) < 2)

  // Mid-drag the page tracks the hand and the next spread is already there.
  await drag(1000, 700)
  const mid = await pageImg(dragPg, 1).boundingBox()
  check('mid-drag the page follows the hand 1:1', Math.abs(rest.x - mid.x - 280) < 25, `moved ${Math.round(rest.x - mid.x)} px for a 300 px drag (less the slop)`)
  const nextBox = await dragPg.locator(`${READER} [data-view="next"] img[alt="Page 2 of E2E Zine"]`).boundingBox()
  check('…with the next spread already on screen beside it, painted', !!nextBox && nextBox.x < 1280 && nextBox.x > 600, JSON.stringify(nextBox))
  await dragPg.waitForTimeout(250) // the hand stops before letting go
  await dragPg.mouse.up()
  await dragPg.waitForTimeout(500)
  check('a short drag let go at rest settles back, nothing turned', (await counterOf(dragPg)) === '1 / 6' && Math.abs((await pageImg(dragPg, 1).boundingBox()).x - rest.x) < 2)

  // A slow drag past the middle turns.
  await drag(1150, 300, { steps: 20, hold: 250 })
  await dragPg.mouse.up()
  check('a slow drag past the middle turns the page', (await waitCounter(dragPg, '2–3 / 6')) === '2–3 / 6', await counterOf(dragPg))
  await dragPg.waitForTimeout(500)

  // A flick turns from a few pixels.
  await drag(900, 855, { steps: 3, gap: 16 })
  await dragPg.mouse.up()
  check('a flick turns the page from 45 px', (await waitCounter(dragPg, '4–5 / 6')) === '4–5 / 6', await counterOf(dragPg))
  await dragPg.waitForTimeout(500)

  // Past the middle, a pause, then the hand heads home and lets go: no turn.
  await drag(1150, 330, { steps: 20, gap: 8, hold: 150 })
  await dragPg.mouse.move(360, 400)
  await dragPg.waitForTimeout(16)
  await dragPg.mouse.move(390, 400)
  await dragPg.mouse.up()
  await dragPg.waitForTimeout(600)
  check('a drag past the middle whose hand turns back does not turn', (await counterOf(dragPg)) === '4–5 / 6', await counterOf(dragPg))

  // The opened spread is one sheet: one shadow, and the pages meet at the fold.
  const p4 = await pageImg(dragPg, 4).boundingBox()
  const p5 = await pageImg(dragPg, 5).boundingBox()
  check('a spread’s two pages meet at the fold (no gap)', !!p4 && !!p5 && Math.abs(p4.x + p4.width - p5.x) < 1.5, `${p4 && p4.x + p4.width} vs ${p5 && p5.x}`)
  const shadows = await dragPg.evaluate(() => [...document.querySelectorAll('[data-view="current"]')].map((e) => e.style.boxShadow || ''))
  check('…and cast one shadow between them, not two', shadows.every((b) => b === '') && (await dragPg.locator(`${READER} [data-sheet]`).count()) >= 1, JSON.stringify(shadows))
  check('the pages beside the view are hidden from screen readers',
    await dragPg.evaluate(() => [...document.querySelectorAll('[data-view="next"],[data-view="prev"]')].every((e) => e.getAttribute('aria-hidden') === 'true')))

  // Where you are, when the chrome has gone: one mark per page, lit to here.
  await dragPg.waitForTimeout(3000)
  const marks = dragPg.locator(`${READER} [data-position-marks]`)
  check('with the chrome away, the position marks show (one per page)',
    ((await marks.getAttribute('class')) ?? '').includes('opacity-100') && (await marks.locator('span').count()) === 6)
  check('…lit up to the page in view', (await marks.locator('[data-read]').count()) === 5)

  // A desktop cursor at an edge shows which way that click turns.
  await dragPg.mouse.move(60, 400)
  await dragPg.waitForTimeout(300)
  check('a cursor at the left edge shows the turn-back hint',
    ((await dragPg.locator(`${READER} [data-edge-hint="prev"]`).getAttribute('class')) ?? '').includes('opacity-100'))
  await dragPg.mouse.move(640, 400)
  await dragPg.waitForTimeout(300)
  check('…and in the middle, no hint', !((await dragPg.locator(`${READER} [data-edge-hint="prev"]`).getAttribute('class')) ?? '').includes('opacity-100'))
  // Pressed at the edge and dragged, the page is in hand: the hint steps
  // aside (a short drag, let go at rest, settles back — nothing turns).
  await dragPg.mouse.move(60, 400)
  await dragPg.waitForTimeout(300)
  await dragPg.mouse.down()
  await dragPg.mouse.move(200, 400, { steps: 4 })
  await dragPg.waitForTimeout(250)
  check('…and a drag that takes the page puts the hint away',
    !((await dragPg.locator(`${READER} [data-edge-hint="prev"]`).getAttribute('class')) ?? '').includes('opacity-100'))
  await dragPg.mouse.up()
  await dragPg.waitForTimeout(400)

  // A key turn is the same slide (the track animates its transform).
  await dragPg.locator(READER).focus()
  await dragPg.keyboard.press('ArrowRight')
  const sliding = await dragPg.evaluate(() => document.getAnimations().some((a) => {
    const k = a.effect?.getKeyframes?.() ?? []
    return k.some((f) => String(f.transform ?? '').includes('translate3d'))
  }))
  check('a key turn slides the page in (the same motion as a drag)', sliding)
  check('…to the back cover, alone', (await waitCounter(dragPg, '6 / 6')) === '6 / 6')
  await dragPg.keyboard.press('Escape')
  await dragPg.close()
}

// ───────────── C5. Reduced motion: no slide, no expand ─────────────
console.log('\nC5. Reduced motion — fades in place of slides and the expand')
{
  const calm = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await wire(calm)
  const cp = await calm.newPage()
  await cp.goto(ART, { waitUntil: 'domcontentloaded' })
  await cp.locator('button:has-text("read · 6 pages")').waitFor({ timeout: 30000 })
  await cp.waitForTimeout(500)
  await cp.locator('button:has-text("read · 6 pages")').click()
  await cp.locator('[role="dialog"]').first().waitFor({ timeout: 5000 })
  // Movement inside the zine's layers only (the artwork page may animate
  // things of its own).
  const movingIn = (pg) => pg.evaluate(() => document.getAnimations().filter((a) => {
    const target = a.effect?.target
    if (!target?.closest?.('[role="dialog"]')) return false
    const k = a.effect?.getKeyframes?.() ?? []
    return k.some((f) => /translate|scale/.test(String(f.transform ?? '')))
  }).length)
  check('reduced motion: the cover does not fly in', (await movingIn(cp)) === 0)
  await cp.locator(`${READER} [data-view="current"] img[alt^="Page "]`).first().waitFor({ timeout: 30000 })
  await cp.keyboard.press('Home')
  await waitCounter(cp, '1 / 6')
  await cp.waitForTimeout(400)
  await cp.keyboard.press('ArrowRight')
  check('reduced motion: a turn does not slide', (await movingIn(cp)) === 0)
  check('…but still turns', (await waitCounter(cp, '2–3 / 6')) === '2–3 / 6')
  // A long zine shows its place as one line: the fill jumps, never slides.
  const lp = await calm.newPage()
  await lp.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LONG_META) }))
  await lp.goto(ART, { waitUntil: 'domcontentloaded' })
  await lp.locator('button:has-text("read · 60 pages")').click()
  await lp.locator(`${READER} [data-view="current"] img[alt^="Page "]`).first().waitFor({ timeout: 60000 })
  await lp.waitForTimeout(400)
  await lp.keyboard.press('ArrowRight')
  check('reduced motion: a long zine’s position line does not slide', (await movingIn(lp)) === 0)
  await calm.close()

  // Pulled down to close: the page fades where it is let go, it does not fly.
  const calmPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  await wire(calmPhone)
  const pp = await calmPhone.newPage()
  await pp.goto(ART, { waitUntil: 'domcontentloaded' })
  await pp.locator('button:has-text("read · 6 pages")').click()
  await pp.locator(`${READER} [data-view="current"] img[alt^="Page "]`).first().waitFor({ timeout: 30000 })
  await pp.waitForTimeout(400)
  const pcdp = await calmPhone.newCDPSession(pp)
  const ptouch = (type, pts) => pcdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
  await ptouch('touchStart', [[195, 300]])
  for (let i = 1; i <= 14; i++) { await ptouch('touchMove', [[195, 300 + i * 22]]); await pp.waitForTimeout(16) }
  await ptouch('touchEnd', [])
  check('reduced motion: a page pulled down to close fades, it does not fly', (await movingIn(pp)) === 0)
  await pp.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {})
  check('…and the reader closes', (await pp.locator('[role="dialog"]').count()) === 0)
  await calmPhone.close()
}

// ───────────── C6. A failed page render: the tile, then a retry ─────────────
console.log('\nC6. A failed page render — the tile, then a retry once the reader moves on')
{
  const fp = await desktop.newPage()
  // One page encode fails (the canvas comes back empty, as under memory
  // pressure on iOS); every later one works.
  await fp.addInitScript(() => {
    window.__failEncodes = 0
    const orig = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
      if (window.__failEncodes > 0) {
        window.__failEncodes--
        setTimeout(() => cb(null), 0)
        return
      }
      return orig.call(this, cb, ...rest)
    }
  })
  await fp.goto(`${ART}?page=1`, { waitUntil: 'domcontentloaded' })
  const fpRead = fp.locator('button:has-text("read · 6 pages")')
  await fpRead.waitFor({ timeout: 30000 })
  await fp.evaluate(() => { window.__failEncodes = 1 })
  await fpRead.click()
  const tile = fp.locator(`${READER} [data-view="current"] [role="img"][aria-label="Page 1 could not be rendered"]`)
  await tile.waitFor({ timeout: 30000 }).catch(() => {})
  check('a page that fails to render shows its tile, and the reader opens all the same', await tile.isVisible().catch(() => false))
  await fp.waitForTimeout(800)
  await fp.locator(READER).focus()
  await fp.keyboard.press('ArrowRight')
  await waitCounter(fp, '2–3 / 6')
  await fp.waitForTimeout(800)
  await fp.keyboard.press('ArrowLeft')
  await waitCounter(fp, '1 / 6')
  const fp1 = fp.locator(`${READER} [data-view="current"] img[alt="Page 1 of E2E Zine"]`)
  await fp1.waitFor({ timeout: 10000 }).catch(() => {})
  check('…and once the reader moves on and back, the page renders (the failure is retried)', await fp1.isVisible().catch(() => false))
  await fp.keyboard.press('Escape')
  await fp.close()
}

// ───────────────── D. Artwork detail, phone: gestures ─────────────────
console.log('\nD. Artwork detail (phone) — swipe and tap zones')
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
await wire(phone)
const ph = await phone.newPage()
await ph.goto(ART, { waitUntil: 'domcontentloaded' })
await ph.locator('button:has-text("read · 6 pages")').waitFor({ timeout: 30000 })
await ph.locator('button:has-text("read · 6 pages")').click()
await ph.waitForSelector('[role="dialog"][aria-label="Reading E2E Zine"]', { timeout: 30000 })
await pageImg(ph, 1).waitFor({ timeout: 30000 })
check('a phone opens single pages, never a spread', (await waitCounter(ph, '1 / 6')) === '1 / 6' && (await ph.locator('[role="dialog"] button[aria-label^="Show"]').count()) === 0)
const box = await pageImg(ph, 1).boundingBox()
check('the page fits the phone viewport', !!box && box.width <= 390 && box.height <= 844, JSON.stringify(box))
await ph.screenshot({ path: path.join(SHOTS, 'z05-phone-cover.png') })
// A swipe: a pointer drag across the stage (Playwright has no touch drag;
// the reader's swipe logic reads pointer events regardless of their type).
await ph.mouse.move(300, 420)
await ph.mouse.down()
await ph.mouse.move(80, 425, { steps: 8 })
await ph.mouse.up()
check('swiping left turns the page', (await waitCounter(ph, '2 / 6')) === '2 / 6')
// Taps are TOUCH taps: a finger fires no pointermove, so these exercise the
// tap zones exactly as a phone does (a mouse click would first reveal the
// chrome by moving).
await ph.touchscreen.tap(20, 420)
check('tapping the left edge turns back', (await waitCounter(ph, '1 / 6')) === '1 / 6')
await ph.touchscreen.tap(370, 420)
check('tapping the right edge turns forward', (await waitCounter(ph, '2 / 6')) === '2 / 6')
const topBar = ph.locator(`${READER} > div.absolute.top-0`)
await ph.waitForTimeout(3000)
check('the chrome hides itself after a moment', ((await topBar.getAttribute('class')) ?? '').includes('opacity-0'))
await ph.touchscreen.tap(195, 420)
await ph.waitForTimeout(600)
check('a centre tap brings the chrome back', ((await topBar.getAttribute('class')) ?? '').includes('opacity-100'))
await ph.touchscreen.tap(195, 420)
await ph.waitForTimeout(600)
check('a second centre tap hides it again', ((await topBar.getAttribute('class')) ?? '').includes('opacity-0'))
await ph.touchscreen.tap(195, 420)
await ph.waitForTimeout(600)
await ph.screenshot({ path: path.join(SHOTS, 'z06-phone-page2.png') })
// Real multi-touch, through the DevTools protocol: Playwright's touchscreen
// only taps, but Chrome turns protocol touches into touch pointer events,
// exactly as a phone delivers them.
const cdp = await phone.newCDPSession(ph)
const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
const fit = await pageImg(ph, 2).boundingBox()
await touch('touchStart', [[165, 420], [225, 420]])
for (let i = 1; i <= 12; i++) { await touch('touchMove', [[165 - i * 8, 420], [225 + i * 8, 420]]); await ph.waitForTimeout(16) }
await touch('touchEnd', [])
await ph.waitForTimeout(400)
const pinched = await pageImg(ph, 2).boundingBox()
check('two fingers pinch the page bigger (real multi-touch)', !!fit && !!pinched && pinched.width > fit.width * 1.5, `${fit?.width} → ${pinched?.width}`)
await touch('touchStart', [[90, 420], [300, 420]])
for (let i = 1; i <= 12; i++) { await touch('touchMove', [[90 + i * 8, 420], [300 - i * 8, 420]]); await ph.waitForTimeout(16) }
await touch('touchEnd', [])
await ph.waitForTimeout(500)
const unpinched = await pageImg(ph, 2).boundingBox()
check('…and pinching in brings it back to fit', !!unpinched && Math.abs(unpinched.width - fit.width) < 3, `${unpinched?.width} vs ${fit?.width}`)
// Pull the page down: a short pull springs back, a long one closes.
await touch('touchStart', [[195, 300]])
for (let i = 1; i <= 4; i++) { await touch('touchMove', [[195, 300 + i * 15]]); await ph.waitForTimeout(16) }
await ph.waitForTimeout(120)
await touch('touchEnd', [])
await ph.waitForTimeout(500)
check('a short pull down springs back; the reader stays', (await ph.locator(READER).count()) === 1 && (await counterOf(ph)) === '2 / 6')
await touch('touchStart', [[195, 300]])
for (let i = 1; i <= 14; i++) { await touch('touchMove', [[195, 300 + i * 22]]); await ph.waitForTimeout(16) }
await touch('touchEnd', [])
await ph.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => {})
check('pulling the page down closes the reader (touch)', (await ph.locator('[role="dialog"]').count()) === 0)
check('…back on the artwork, read button ready', await ph.locator('button:has-text("read · 6 pages")').isVisible())
await ph.close()
await phone.close()

// ───────────────── E. Feed card: the badge, no pdf.js ─────────────────
console.log('\nE. Feed card — the badge and the no-pdf.js rule')
const ZINE_MOMENT = {
  address: '0x00000000000000000000000000000000000000aa',
  token_id: '1',
  metadata: ZINE_META.metadata,
  creator: { address: '0x000000000000000000000000000000000000dEaD', username: null, avatarUrl: null },
}
await desktop.route(/\/api\/timeline/, (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ status: 'success', moments: [ZINE_MOMENT], pagination: { page: 1, limit: 20, total_pages: 1 } }),
}))
const profile = await desktop.newPage()
const feedSeen = trackPdfjs(profile)
await profile.goto(`${BASE}/profile/0x000000000000000000000000000000000000dEaD`, { waitUntil: 'domcontentloaded' })
const cardMounted = await profile.waitForSelector('article', { timeout: 30000 }).then(() => true).catch(() => false)
check('a MomentCard grid renders from the intercepted timeline (profile page)', cardMounted)
check('the feed card carries the zine badge with its page count',
  cardMounted && (await profile.locator('article [aria-label="zine, 6 pages"]').count()) >= 1)
check('the card renders the COVER, not the PDF',
  cardMounted && !!(await profile.locator('article img[alt="E2E Zine"]').first().getAttribute('src').catch(() => null)))
// A collectors-only zine is an image moment with a hint; the hint badges it.
await desktop.route(/\/api\/timeline/, (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ status: 'success', moments: [{ ...ZINE_MOMENT, metadata: { name: 'E2E Private Zine', image: 'ar://cover-txid', kismet_zine: { pages: 6, access: 'collectors' } } }],
    pagination: { page: 1, limit: 20, total_pages: 1 } }),
}))
await profile.reload({ waitUntil: 'domcontentloaded' })
const privCard = await profile.waitForSelector('article', { timeout: 30000 }).then(() => true).catch(() => false)
check('a collectors-only zine card carries the badge from its hint',
  privCard && (await profile.locator('article [aria-label="zine, 6 pages, collectors only"]').count()) >= 1)
check('a collectors-only card renders its cover',
  privCard && !!(await profile.locator('article img[alt="E2E Private Zine"]').first().getAttribute('src').catch(() => null)))
// A collectors hint on a moment whose media is a model: the model's badge,
// never both on top of each other.
await desktop.route(/\/api\/timeline/, (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ status: 'success', moments: [{ ...ZINE_MOMENT, metadata: { name: 'E2E Model Zine', image: 'ar://cover-txid', animation_url: 'ar://model-txid', content: { uri: 'ar://model-txid', mime: 'model/gltf-binary' }, kismet_zine: { pages: 6, access: 'collectors' } } }],
    pagination: { page: 1, limit: 20, total_pages: 1 } }),
}))
await profile.reload({ waitUntil: 'domcontentloaded' })
const modelCard = await profile.waitForSelector('article', { timeout: 30000 }).then(() => true).catch(() => false)
check('a collectors hint never badges "zine" over a model\'s badge',
  modelCard && (await profile.locator('article [aria-label="3D artwork"]').count()) >= 1 && (await profile.locator('article [aria-label^="zine"]').count()) === 0)
await profile.waitForTimeout(1500)
check('no pdf.js asset is fetched by a feed', feedSeen.any === 0, JSON.stringify(feedSeen))
await profile.screenshot({ path: path.join(SHOTS, 'z07-profile-badge.png'), clip: { x: 0, y: 80, width: 900, height: 700 } })
await profile.close()

// ───────────── E2. The overlay route: Escape closes the zine, not the artwork ─────────────
// From a feed, an artwork opens as an overlay (the intercepting route) whose
// own Escape goes back. A zine layer above it must take Escape alone — two
// layers acting on one key would pop two history entries and drop the reader
// back on the feed.
console.log('\nE2. Overlay — Escape closes the zine layer, never the artwork overlay under it')
{
  const ov = await desktop.newPage()
  await ov.route(/\/api\/timeline/, (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'success', moments: [ZINE_MOMENT], pagination: { page: 1, limit: 20, total_pages: 1 } }),
  }))
  // The zine's bytes held back, so the opening frame is still up for the first Escape.
  let holdZine = true
  await ov.route(/arweave\.net|api\/img/, async (r) => {
    if (!decodeURIComponent(r.request().url()).includes('zine-txid')) return r.fallback()
    if (holdZine) await new Promise((res) => setTimeout(res, 1500))
    return r.fulfill({ status: 200, contentType: 'application/pdf', body: ZINE }).catch(() => {})
  })
  await ov.goto(`${BASE}/profile/0x000000000000000000000000000000000000dEaD`, { waitUntil: 'domcontentloaded' })
  await ov.waitForSelector('article', { timeout: 30000 })
  await ov.locator('a[href="/artwork/0x00000000000000000000000000000000000000aa/1"]').first().click()
  const ovRead = ov.locator('button:has-text("read · 6 pages")')
  await ovRead.waitFor({ timeout: 30000 })
  const overlay = ov.locator('[role="dialog"][aria-label="Artwork detail"]')
  const overlayUp = async () => ov.url().includes('/artwork/') && (await overlay.count()) === 1 && (await ovRead.isVisible().catch(() => false))
  check('a feed card opens the artwork over the feed (the overlay route)', await overlayUp(), ov.url())
  await ovRead.click()
  await ov.locator('[role="dialog"][aria-label="Opening E2E Zine"]').waitFor({ timeout: 3000 }).catch(() => {})
  await ov.waitForTimeout(200)
  await ov.keyboard.press('Escape')
  await ov.waitForTimeout(800)
  check('Escape on the opening frame cancels the zine — the artwork overlay stays', await overlayUp(), ov.url())
  holdZine = false
  if (ov.url().includes('/artwork/')) {
    await ovRead.click()
    await ov.locator(`${READER} [data-view="current"] img[alt^="Page "]`).first().waitFor({ timeout: 30000 }).catch(() => {})
    await ov.waitForTimeout(400)
    await ov.keyboard.press('Escape')
    await ov.waitForTimeout(800)
  }
  check('Escape in the reader closes the reader — the artwork overlay stays', await overlayUp(), ov.url())
  await ov.close()
}
await desktop.close()

await browser.close()
console.log(fails === 0 ? '\nE2E (zine): all assertions passed' : `\nE2E (zine): ${fails} assertion(s) failed`)
process.exit(fails === 0 ? 0 : 1)
