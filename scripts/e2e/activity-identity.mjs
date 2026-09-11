/**
 * Browser end-to-end check for the activity panel's identity display
 * (components/MomentActivity): the one-shot in-view retry that re-resolves
 * senders whose identity came back unresolved, and the In Process username
 * fallback. These are the two client behaviors `verify:profile-identity`
 * cannot execute — it pins the cache primitive they use, but the wiring
 * lives in a React effect and a render expression. Drives a real Chromium
 * against the real built app; /api/moment, /api/moment/comments and
 * /api/profiles are intercepted IN THE BROWSER, so every assertion is about
 * the component, not the upstreams.
 *
 * Deliberately NOT wired into `npm run check`: it needs a built app, a
 * running server and a browser. See scripts/e2e/README.md.
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import sharp from 'sharp'

const APP_PORT = Number(process.env.E2E_PORT || 3109)
const REDIS_PORT = 6399 // scripts/e2e/redis-stub.mjs listens here
const BASE = `http://127.0.0.1:${APP_PORT}`
const EXE = process.env.E2E_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

let fails = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) fails++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Three senders, three identity situations:
//   A — no upstream username; unresolved on the first batch, resolves on the
//       retry (the ENS warm landing server-side) → must upgrade in-view.
//   B — upstream username, never resolves → the username must show and stay.
//   C — upstream username AND resolves on the retry → the resolved identity
//       must outrank the upstream handle.
const A = '0x78b2de47fe499e0a6f7a67dbf965b8ec765d2d9d'
const B = '0x1111111111111111111111111111111111111111'
const C = '0x2222222222222222222222222222222222222222'
const COLLECTION = '0x00000000000000000000000000000000000000aa'
const ART = `${BASE}/artwork/${COLLECTION}/1`

const META = {
  uri: 'ar://meta',
  owner: '0x000000000000000000000000000000000000dEaD',
  momentAdmins: [],
  saleConfig: null,
  metadata: {
    name: 'E2E Activity',
    description: 'A moment used to validate the activity panel end to end.',
    image: 'ar://poster-txid',
  },
}
const now = Date.now()
const ROWS = {
  comments: [
    { sender: A, comment: '', timestamp: now - 60_000 },
    { sender: B, comment: '', timestamp: now - 120_000, username: 'inprocessperson' },
    { sender: C, comment: '', timestamp: now - 180_000, username: 'cee_upstream' },
  ],
  hasMore: false,
}
const POSTER = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 120, b: 90 } } }).jpeg().toBuffer()

// ── servers ─────────────────────────────────────────────────────────────────
const stub = spawn(process.execPath, ['scripts/e2e/redis-stub.mjs'], { stdio: 'ignore' })
const app = spawn('node_modules/.bin/next', ['start', '-p', String(APP_PORT)], {
  env: {
    ...process.env,
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${REDIS_PORT}`,
    UPSTASH_REDIS_REST_TOKEN: 'stub',
    MAINNET_RPC_URL: 'http://127.0.0.1:9', // never reached: /api/profiles is intercepted in the browser
    NEXT_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
app.stdout.on('data', (d) => { appLog += d })
app.stderr.on('data', (d) => { appLog += d })
let browser
const shutdown = async () => {
  try { await browser?.close() } catch {}
  app.kill('SIGTERM'); stub.kill('SIGTERM')
}
process.on('exit', () => { app.kill('SIGTERM'); stub.kill('SIGTERM') })

const ready = await (async () => {
  for (let i = 0; i < 120; i++) {
    if (app.exitCode !== null) return false
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true } catch {}
    await sleep(500)
  }
  return false
})()
if (!ready) {
  console.log('  FAIL  next start never became ready\n' + appLog.slice(-2000))
  await shutdown()
  process.exit(1)
}

// ── browser ─────────────────────────────────────────────────────────────────
browser = await chromium.launch({ executablePath: EXE })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } })
const profileCalls = []
await ctx.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(META) }))
await ctx.route(/\/api\/moment\/comments\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROWS) }))
await ctx.route(/\/api\/profiles\?/, (r) => {
  const addrs = (new URL(r.request().url()).searchParams.get('addresses') ?? '').split(',').filter(Boolean)
  profileCalls.push(addrs)
  // First batch: the server's cold answer (nothing resolved). Retry: the
  // warm landed for A and C; B is still unresolved.
  const resolved = profileCalls.length === 1 ? {} : { [A]: 'yonfrula.eth', [C]: 'cee.eth' }
  const profiles = Object.fromEntries(addrs.map((a) => [a, { name: resolved[a] ?? '', avatarUrl: undefined }]))
  return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ profiles }) })
})
await ctx.route('**/arweave.net/**', (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER }))
await ctx.route('**/api/img**', (r) => r.fulfill({ status: 200, contentType: 'image/jpeg', body: POSTER }))

// Warm the route once: a freshly started server compiles the detail view's
// lazy chunks on the first request, and a cold run can lose a selector race
// that says nothing about the code.
{
  const warm = await ctx.newPage()
  await warm.goto(ART, { waitUntil: 'load' }).catch(() => {})
  await warm.close()
  profileCalls.length = 0
}

const page = await ctx.newPage()
const nameOf = async (addr) =>
  (await page.locator(`a[href="/profile/${addr}"]`).allInnerTexts()).map((t) => t.trim()).filter(Boolean).join('|')
const waitForName = async (addr, want, ms) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if ((await nameOf(addr)) === want) return true
    await sleep(150)
  }
  return false
}

await page.goto(ART, { waitUntil: 'domcontentloaded' })

// ════════════════════════════════════════════════════════════════════════════
console.log('\nA. The panel renders and the first (cold) batch lands')
await page.locator(`a[href="/profile/${A}"]`).first().waitFor({ timeout: 45_000 })
for (let i = 0; i < 100 && profileCalls.length < 1; i++) await sleep(100)
check('one batch request resolved every sender', profileCalls.length === 1 && [...profileCalls[0]].sort().join() === [A, B, C].sort().join(),
  JSON.stringify(profileCalls))
check('A (no identity yet) renders the truncated address', await waitForName(A, '0x78b2…2d9d', 3_000), await nameOf(A))
check('B renders its upstream username instead of the address', await waitForName(B, 'inprocessperson', 3_000), await nameOf(B))
check('C renders its upstream username instead of the address', await waitForName(C, 'cee_upstream', 3_000), await nameOf(C))

// ════════════════════════════════════════════════════════════════════════════
console.log('\nB. The one-shot retry upgrades the rows in-view (~2.5s later)')
check('A upgrades to yonfrula.eth without a reload', await waitForName(A, 'yonfrula.eth', 8_000), await nameOf(A))
check('C: a resolved identity outranks the upstream username', await waitForName(C, 'cee.eth', 3_000), await nameOf(C))
check('B: still unresolved, keeps the upstream username', (await nameOf(B)) === 'inprocessperson', await nameOf(B))
check('the retry asked only for the unresolved senders (all three, once)',
  profileCalls.length === 2 && [...profileCalls[1]].sort().join() === [A, B, C].sort().join(), JSON.stringify(profileCalls))

// ════════════════════════════════════════════════════════════════════════════
console.log('\nC. Exactly one retry — B stays unresolved and nothing retries again')
await sleep(3_500)
check('no further /api/profiles requests after the one-shot retry', profileCalls.length === 2, `saw ${profileCalls.length}`)
check('B remains the upstream username', (await nameOf(B)) === 'inprocessperson')

console.log(fails === 0 ? '\ne2e activity-identity: all checks passed' : `\ne2e activity-identity: ${fails} FAILED`)
await shutdown()
process.exit(fails === 0 ? 0 : 1)
