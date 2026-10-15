/**
 * Showcase: drive the REAL build with a REAL zine PDF and photograph what the
 * mint preview, the reader (desktop and phone) and the feed card show. No
 * assertions beyond "it rendered" — the point is the pictures and the
 * timings, for an artist's actual file rather than the e2e fixture.
 *
 *   E2E_ZINE_PDF=path/to/zine.pdf E2E_ZINE_COVER=path/to/cover.jpg \
 *   E2E_ZINE_TITLE="trpplzine issue #0" node scripts/e2e/zine-showcase.mjs
 *
 * Needs the server from scripts/e2e/README.md on :3100. Screenshots land in
 * $E2E_DIR/shots/showcase-*.png.
 */
import { chromium } from 'playwright'
import fs from 'fs'
import path from 'path'

const DIR = process.env.E2E_DIR || path.join(process.cwd(), '.e2e')
const SHOTS = path.join(DIR, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3100'
const EXE = process.env.E2E_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const PDF_PATH = process.env.E2E_ZINE_PDF
const COVER_PATH = process.env.E2E_ZINE_COVER
const TITLE = process.env.E2E_ZINE_TITLE || 'Zine'
if (!PDF_PATH || !COVER_PATH) {
  console.error('E2E_ZINE_PDF and E2E_ZINE_COVER are required')
  process.exit(2)
}
const ZINE = fs.readFileSync(PDF_PATH)
const COVER = fs.readFileSync(COVER_PATH)
const PAGES = Number(process.env.E2E_ZINE_PAGES || 0)

const META = {
  uri: 'ar://meta',
  owner: '0x000000000000000000000000000000000000dEaD',
  momentAdmins: [],
  saleConfig: null,
  metadata: {
    name: TITLE,
    description: 'Showcase.',
    image: 'ar://cover-txid',
    animation_url: 'ar://zine-txid',
    content: { uri: 'ar://zine-txid', mime: 'application/pdf' },
    ...(PAGES ? { kismet_zine: { pages: PAGES, access: 'public' } } : {}),
  },
}
const ART = `${BASE}/artwork/0x00000000000000000000000000000000000000aa/1`
const ms = (t0) => `${Date.now() - t0} ms`

async function wire(ctx) {
  await ctx.route('**/arweave.net/**', (route) => {
    const u = route.request().url()
    if (u.includes('zine-txid')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: ZINE })
    if (u.includes('cover-txid')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: COVER })
    return route.fulfill({ status: 404, body: '' })
  })
  await ctx.route('**/api/img**', (route) => {
    const u = decodeURIComponent(route.request().url())
    if (u.includes('zine-txid')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: ZINE })
    return route.fulfill({ status: 200, contentType: 'image/jpeg', body: COVER })
  })
  await ctx.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META) }))
  await ctx.route(/\/api\/timeline/, (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      status: 'success',
      moments: [{ address: '0x00000000000000000000000000000000000000aa', token_id: '1', metadata: META.metadata,
        creator: { address: '0x000000000000000000000000000000000000dEaD', username: null, avatarUrl: null } }],
      pagination: { page: 1, limit: 20, total_pages: 1 },
    }),
  }))
}

const browser = await chromium.launch({ executablePath: EXE })
const pageImg = (pg, n) => pg.locator(`[role="dialog"] img[alt="Page ${n} of ${TITLE}"]`).first()
const counter = async (pg) => (await pg.locator('[role="dialog"] span.tabular-nums').first().innerText()).trim()

// ── Mint preview (desktop) ────────────────────────────────────────────────
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
await wire(desktop)
{
  const warm = await desktop.newPage(); await warm.goto(`${BASE}/mint`, { waitUntil: 'load' }).catch(() => {}); await warm.close()
}
const mint = await desktop.newPage()
await mint.goto(`${BASE}/mint`, { waitUntil: 'domcontentloaded' })
const MEDIA_INPUT = 'input[type="file"][accept^="image/*"][accept*="model/gltf-binary"]'
await mint.waitForSelector(MEDIA_INPUT, { state: 'attached', timeout: 30000 })
let t0 = Date.now()
for (let i = 0; i < 40; i++) {
  await mint.setInputFiles(MEDIA_INPUT, PDF_PATH)
  await mint.waitForTimeout(500)
  if ((await mint.locator('img[alt="Page 1 preview"]').count()) > 0) break
}
await mint.waitForSelector('img[alt="Page 1 preview"]', { timeout: 60000 })
console.log(`mint: PDF picked → page 1 preview on screen in ${ms(t0)}`)
await mint.waitForTimeout(800)
await mint.screenshot({ path: path.join(SHOTS, 'showcase-01-mint-preview.png'), clip: { x: 300, y: 120, width: 680, height: 1000 } })
await mint.locator('button[aria-label="Next page"]').first().click()
await mint.waitForSelector('img[alt="Page 2 preview"]', { timeout: 60000 })
await mint.waitForTimeout(600)
await mint.screenshot({ path: path.join(SHOTS, 'showcase-02-mint-preview-page2.png'), clip: { x: 300, y: 120, width: 680, height: 1000 } })
// "Optimize for phones": re-render every page at a phone-sized long edge.
const optimize = mint.locator('button:has-text("optimize for phones")')
if (await optimize.count()) {
  t0 = Date.now()
  await optimize.click()
  const done = mint.locator('[data-sonner-toast]', { hasText: /Optimized for phones|Already compact/ })
  await done.first().waitFor({ timeout: 600000 })
  console.log(`mint: optimize for phones → ${(await done.first().innerText()).replace(/\s+/g, ' ').trim()} in ${ms(t0)}`)
  await mint.waitForTimeout(1500)
  await mint.screenshot({ path: path.join(SHOTS, 'showcase-02b-mint-optimized.png'), clip: { x: 300, y: 120, width: 680, height: 1000 } })
  // Measure the optimized file's page-1 render in the reader below by
  // serving it as the zine. The optimizer replaces the file in the form's
  // STATE (the <input> still holds the original pick), so read it off the
  // preview's `file` prop through the React fiber of a preview image.
  await mint.waitForSelector('img[alt="Page 1 preview"]', { timeout: 60000 })
  const optimizedBytes = await mint.evaluate(async () => {
    const node = document.querySelector('img[alt="Page 1 preview"]')
    const key = node && Object.keys(node).find((k) => k.startsWith('__reactFiber$'))
    let fiber = key ? node[key] : null
    let f = null
    while (fiber && !f) {
      const props = fiber.memoizedProps
      if (props && props.file instanceof File) f = props.file
      fiber = fiber.return
    }
    if (!f) return null
    const b = new Uint8Array(await f.arrayBuffer())
    let s = ''
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000))
    return btoa(s)
  })
  if (optimizedBytes) {
    fs.writeFileSync(path.join(DIR, 'optimized.pdf'), Buffer.from(optimizedBytes, 'base64'))
    console.log(`mint: optimized file saved (${(fs.statSync(path.join(DIR, 'optimized.pdf')).size / 1024).toFixed(0)} KB)`)
  }
}
await mint.close()

// ── Reader, desktop ───────────────────────────────────────────────────────
const page = await desktop.newPage()
await page.goto(ART, { waitUntil: 'domcontentloaded' })
await page.locator('button:has-text("read")').first().waitFor({ timeout: 30000 })
await page.waitForTimeout(1200)
await page.screenshot({ path: path.join(SHOTS, 'showcase-03-detail-idle.png'), clip: { x: 0, y: 60, width: 1280, height: 740 } })
t0 = Date.now()
await page.locator('button:has-text("read")').first().click()
await pageImg(page, 1).waitFor({ timeout: 60000 })
console.log(`desktop: tap → page 1 on screen in ${ms(t0)} (download + parse + render)`)
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(SHOTS, 'showcase-04-reader-cover.png') })
t0 = Date.now()
await page.keyboard.press('ArrowRight')
await pageImg(page, 2).waitFor({ timeout: 60000 })
await pageImg(page, 3).waitFor({ timeout: 60000 })
console.log(`desktop: ArrowRight → spread 2–3 on screen in ${ms(t0)} (counter ${await counter(page)})`)
await page.waitForTimeout(600)
await page.screenshot({ path: path.join(SHOTS, 'showcase-05-reader-spread.png') })
await page.keyboard.press('Escape')
await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 10000 })

// ── Feed card ─────────────────────────────────────────────────────────────
const profile = await desktop.newPage()
await profile.goto(`${BASE}/profile/0x000000000000000000000000000000000000dEaD`, { waitUntil: 'domcontentloaded' })
await profile.waitForSelector('article', { timeout: 30000 }).catch(() => {})
await profile.waitForTimeout(2500)
await profile.screenshot({ path: path.join(SHOTS, 'showcase-06-feed-card.png'), clip: { x: 0, y: 80, width: 900, height: 700 } })
await profile.close()
await desktop.close()

// ── Reader, phone ─────────────────────────────────────────────────────────
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
await wire(phone)
const ph = await phone.newPage()
await ph.goto(ART, { waitUntil: 'domcontentloaded' })
await ph.locator('button:has-text("read")').first().waitFor({ timeout: 30000 })
await ph.waitForTimeout(1000)
await ph.screenshot({ path: path.join(SHOTS, 'showcase-07-phone-detail.png') })
t0 = Date.now()
await ph.locator('button:has-text("read")').first().click()
await pageImg(ph, 1).waitFor({ timeout: 60000 })
console.log(`phone (DPR 3): tap → page 1 on screen in ${ms(t0)}`)
await ph.waitForTimeout(600)
await ph.screenshot({ path: path.join(SHOTS, 'showcase-08-phone-cover.png') })
// A reader dwells on the cover; the window renders page 2 meanwhile, so a
// 0–50 ms turn here means the prerender did its job.
await ph.waitForTimeout(1500)
t0 = Date.now()
await ph.touchscreen.tap(370, 420)
await pageImg(ph, 2).waitFor({ timeout: 60000 })
console.log(`phone: tap right after a 1.5 s dwell → page 2 on screen in ${ms(t0)} (0–50 ms = prerendered)`)
await ph.waitForTimeout(600)
await ph.screenshot({ path: path.join(SHOTS, 'showcase-09-phone-page2.png') })
// Zoom in on the page (double-tap) to show the re-render at zoom.
await ph.touchscreen.tap(195, 500)
await ph.waitForTimeout(80)
await ph.touchscreen.tap(195, 500)
await ph.waitForTimeout(900)
await ph.screenshot({ path: path.join(SHOTS, 'showcase-10-phone-zoomed.png') })
await ph.touchscreen.tap(195, 500)
await ph.waitForTimeout(80)
await ph.touchscreen.tap(195, 500)
await ph.waitForTimeout(400)
// Rotate: a scan of a landscape spread on a portrait sheet reads upright.
const rotateBtn = ph.locator('[role="dialog"] button[aria-label="Rotate pages"]')
if (await rotateBtn.count()) {
  await ph.touchscreen.tap(195, 420) // bring the chrome back
  await ph.waitForTimeout(500)
  await rotateBtn.click()
  await pageImg(ph, 2).waitFor({ timeout: 60000 })
  await ph.waitForTimeout(1200)
  await ph.screenshot({ path: path.join(SHOTS, 'showcase-11a-phone-rotated-once.png') })
  // This print file's sheets need the OTHER quarter turn (the first one
  // lands upside down): shift+r twice from 90° is 270°, the touch path
  // being two more taps of the button.
  await ph.keyboard.press('Shift+R')
  await ph.keyboard.press('Shift+R')
  await pageImg(ph, 2).waitFor({ timeout: 60000 })
  await ph.waitForTimeout(1200)
  await ph.screenshot({ path: path.join(SHOTS, 'showcase-11-phone-rotated.png') })
  console.log('phone: rotated once (clockwise) → upside down for this print file; two more turns → upright (showcase-11)')
}
await ph.close()
await phone.close()

// ── The optimized file, phone timings ──────────────────────────────────────
const optimizedPath = path.join(DIR, 'optimized.pdf')
if (fs.existsSync(optimizedPath)) {
  const OPT = fs.readFileSync(optimizedPath)
  const phone2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  await phone2.route('**/arweave.net/**', (route) => {
    const u = route.request().url()
    if (u.includes('zine-txid')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: OPT })
    if (u.includes('cover-txid')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: COVER })
    return route.fulfill({ status: 404, body: '' })
  })
  await phone2.route('**/api/img**', (route) => {
    const u = decodeURIComponent(route.request().url())
    if (u.includes('zine-txid')) return route.fulfill({ status: 200, contentType: 'application/pdf', body: OPT })
    return route.fulfill({ status: 200, contentType: 'image/jpeg', body: COVER })
  })
  await phone2.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META) }))
  const p2 = await phone2.newPage()
  await p2.goto(ART, { waitUntil: 'domcontentloaded' })
  await p2.locator('button:has-text("read")').first().waitFor({ timeout: 30000 })
  t0 = Date.now()
  await p2.locator('button:has-text("read")').first().click()
  await pageImg(p2, 1).waitFor({ timeout: 60000 })
  console.log(`phone, OPTIMIZED file (${(OPT.length / 1024).toFixed(0)} KB): tap → page 1 on screen in ${ms(t0)}`)
  await p2.waitForTimeout(1500)
  t0 = Date.now()
  await p2.touchscreen.tap(370, 420)
  await pageImg(p2, 2).waitFor({ timeout: 60000 })
  console.log(`phone, OPTIMIZED file: tap right after a 1.5 s dwell → page 2 on screen in ${ms(t0)}`)
  await p2.waitForTimeout(600)
  await p2.screenshot({ path: path.join(SHOTS, 'showcase-12-phone-optimized-page2.png') })
  await p2.close()
  await phone2.close()
}
await browser.close()
console.log(`shots in ${SHOTS}`)
