/**
 * Browser end-to-end check — the sweep. Drives a REAL Chromium against the
 * REAL built app (`next start`), with the app's server pointed at the mock
 * Upstash (scripts/_mock-upstash.ts) and the fake chain
 * (scripts/_sweep-fake-chain.ts) over HTTP, the browser's RPC traffic to
 * viem's default Base endpoint intercepted and answered by the SAME fake chain
 * in-process, and an EIP-1193 wallet shim injected into the page (the app
 * treats the Coinbase WebView user agent as a host wallet and auto-connects
 * its injected provider — lib/miniAppEnv, hooks/useBaseAppAutoConnect).
 *
 * WHAT IT COVERS that no module oracle can: the button in the discover
 * header at phone and desktop widths (the row must not overflow at 375 px and
 * the stats block must wrap under, then sit beside at 1280 px), the sheet's
 * painted states (verifying → ready → the exact total → remove/undo → wallet
 * prompt → confirming → done → "sweep the next N"), the exact transaction the
 * wallet is asked to sign (Multicall3, Σ value, every sub-call strict, mintTo
 * = the user, the ERC-8021 builder suffix appended), the receipt-driven
 * finish, the records the server verifies against the same fake chain, the
 * funnel beacons landing in Redis exactly once each, the ownership exclusion
 * on the next round, the "needs more ETH" state, the hidden button once the
 * flag is off, and the direct-mint path for a single item.
 *
 * Deliberately NOT wired into `npm run check`: it needs a built app, a
 * running server and a browser (see scripts/e2e/README.md). Run:
 *
 *   npm run build && npm i --no-save playwright@1.56.0
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
 *     --import ./scripts/register-ts-alias.mjs scripts/e2e/sweep.ts
 *
 * Screenshots land in .e2e/shots/.
 */

import { chromium, type Route } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { decodeAbiParameters, decodeFunctionData, getAddress, hexToBigInt, parseAbi, type Address, type Hex } from 'viem'
import { createMockUpstash } from '../_mock-upstash.ts'
import { RpcErr, createFakeChain, handleRpc, liveSale, mineTransaction, startFakeRpcServer, tokenKey } from '../_sweep-fake-chain.ts'
import { FPSS, MINT_1155_ABI, REFERRAL } from '../_agent-verify-helpers.ts'
import { formatPrice, DEFAULT_COLLECT_COMMENT } from '@/lib/inprocess'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
import { MULTICALL3_ADDRESS } from '@/lib/zoraMint'

const EXE = process.env.E2E_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const SHOTS = process.env.E2E_DIR ? `${process.env.E2E_DIR}/shots` : '.e2e/shots'
mkdirSync(SHOTS, { recursive: true })

let passed = 0
let failed = 0
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}` : ''}`)
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(pred: () => boolean | Promise<boolean>, ms: number, step = 250): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await pred()) return true
    await sleep(step)
  }
  return pred()
}

// ───────────────────────── fixtures ─────────────────────────

const USER = getAddress(`0x${'71'.repeat(20)}`)
const ADMIN = getAddress(`0x${'ad'.repeat(20)}`)
const COL_A = `0x${'a1'.repeat(20)}` as Address
const COL_B = `0x${'b2'.repeat(20)}` as Address
const ARTIST_X = `0x${'11'.repeat(20)}`
const ARTIST_Y = `0x${'22'.repeat(20)}`
const FEE = 111_000_000_000_000n
const ETH = 10n ** 18n
const price = (id: number) => 100_000_000_000_000n * BigInt(id) // 0.0001 ETH × id
const outlay = (id: number) => price(id) + FEE
const colOf = (id: number) => (id <= 8 ? COL_A : COL_B)
const AGG3V_ABI = parseAbi([
  'function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
])
const SUFFIX = (BUILDER_DATA_SUFFIX ?? '0x').slice(2)

const poolRow = (id: number) => ({
  address: colOf(id),
  tokenId: String(id),
  // Deliberately wrong index numbers: the sheet must show and sign the LIVE ones.
  priceWei: '1',
  feeWei: '1',
  outlayWei: '2',
  maxPerAddress: '0',
  remaining: null,
  saleEnd: '18446744073709551615',
  creator: id % 2 ? ARTIST_X : ARTIST_Y,
  artist: id % 2 ? ARTIST_X : ARTIST_Y,
  createdAt: new Date(1_700_000_000_000 + id * 60_000).toISOString(),
  name: `Piece ${id}`,
})

// ───────────────────────── the built server ─────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

async function startNext(env: Record<string, string>): Promise<{ base: string; child: ChildProcess }> {
  const port = await freePort()
  const log = createWriteStream(`${process.env.TMPDIR ?? '/tmp'}/e2e-sweep.next.log`)
  const child = spawn('npx', ['next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    env: { ...process.env, ...env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      const r = await fetch(`${base}/api/sweep?n=10`)
      if (r.ok) return { base, child }
    } catch {}
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode} (see e2e-sweep.next.log)`)
    if (Date.now() > deadline) throw new Error('next start did not become ready in 90s')
    await sleep(500)
  }
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const upstash = createMockUpstash()
  const chain = createFakeChain({ now: BigInt(Math.floor(Date.now() / 1000)), ethBalance: ETH })
  chain.fees.set(COL_A, FEE)
  chain.fees.set(COL_B, FEE)
  for (let id = 1; id <= 12; id++) chain.tokens.set(tokenKey(colOf(id), BigInt(id)), { sale: liveSale(price(id)) })
  const [redisUrl, rpc] = await Promise.all([upstash.start(), startFakeRpcServer(chain)])

  // Seed: flag on, a 12-row pool, an admin session for the flag flips below.
  upstash.store.set('kismetart:sweep-enabled', { v: '1' })
  const pool = { updatedAt: Date.now(), eligible: 12, items: Array.from({ length: 12 }, (_, i) => poolRow(i + 1)) }
  upstash.store.set('kismetart:sweep-index', { v: JSON.stringify(pool) })
  upstash.store.set('kismetart:auth-session:e2e-admin', { v: ADMIN.toLowerCase() })

  const { base, child } = await startNext({
    UPSTASH_REDIS_REST_URL: redisUrl,
    UPSTASH_REDIS_REST_TOKEN: 'mock-token',
    BASE_RPC_URL: rpc.url,
    MAINNET_RPC_URL: rpc.url,
    ADMIN_ADDRESS: ADMIN,
  })
  const adminPost = (enabled: boolean) =>
    fetch(`${base}/api/admin/sweep`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: '__Host-kismetart-admin=e2e-admin' },
      body: JSON.stringify({ enabled }),
    })

  const browser = await chromium.launch({ executablePath: EXE, headless: true })
  const stop = () => {
    browser.close().catch(() => {})
    child.kill('SIGTERM')
    upstash.close()
    rpc.close()
  }
  process.on('exit', stop)

  try {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      // The Coinbase WebView user agent: the app registers the injected
      // connector and auto-connects it on mount (no RainbowKit picker).
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CoinbaseWallet/28.0 Mobile/15E148 Safari/604.1',
    })
    // The wallet shim: every EIP-1193 request is forwarded to a same-origin
    // path this harness answers (CSP-safe), so wallet logic lives in Node.
    await context.addInitScript(() => {
      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {}
      const ethereum = {
        isCoinbaseWallet: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          const res = await fetch('/__e2e_wallet', { method: 'POST', body: JSON.stringify({ method, params: params ?? [] }) })
          const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string } }
          if (json.error) {
            const e = new Error(json.error.message) as Error & { code: number }
            e.code = json.error.code
            throw e
          }
          return json.result
        },
        on: (ev: string, fn: (...a: unknown[]) => void) => {
          ;(listeners[ev] ||= []).push(fn)
        },
        removeListener: (ev: string, fn: (...a: unknown[]) => void) => {
          listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn)
        },
      }
      Object.defineProperty(window, 'ethereum', { value: ethereum, configurable: true })
    })

    const wallet = { sent: [] as { from: Address; to: Address; value: bigint; data: Hex }[] }
    const funnel: Record<string, number> = {}
    const pageErrors: string[] = []

    const walletRpc = (method: string, params: unknown[]): unknown => {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [USER]
        case 'eth_chainId':
          return '0x2105'
        case 'net_version':
          return '8453'
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
        case 'wallet_requestPermissions':
          return null
        case 'wallet_getCapabilities':
          return {}
        case 'eth_sendTransaction': {
          const tx = params[0] as { from: string; to: string; value?: string; data?: string }
          const t = {
            from: getAddress(tx.from),
            to: getAddress(tx.to),
            value: tx.value ? hexToBigInt(tx.value as Hex) : 0n,
            data: (tx.data ?? '0x') as Hex,
          }
          wallet.sent.push(t)
          return mineTransaction(chain, t)
        }
        default:
          return handleRpc(chain, method, params) // a read through the wallet provider
      }
    }
    const rpcEnvelope = (body: string) => {
      const parsed = JSON.parse(body) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[]
      const one = (r: { id: number; method: string; params?: unknown[] }) => {
        try {
          return { jsonrpc: '2.0', id: r.id, result: handleRpc(chain, r.method, r.params ?? []) }
        } catch (e) {
          return { jsonrpc: '2.0', id: r.id, error: { code: e instanceof RpcErr ? e.code : -32000, message: e instanceof Error ? e.message : String(e) } }
        }
      }
      return JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed))
    }

    const page = await context.newPage()
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.route('**/*', async (route: Route) => {
      const req = route.request()
      const url = req.url()
      if (url.startsWith(base)) {
        if (url.startsWith(`${base}/__e2e_wallet`)) {
          const { method, params } = JSON.parse(req.postData() ?? '{}') as { method: string; params: unknown[] }
          try {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: walletRpc(method, params) }) })
          } catch (e) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: { code: e instanceof RpcErr ? e.code : -32000, message: String(e) } }) })
          }
        }
        if (url.startsWith(`${base}/api/funnel`)) {
          const m = /"event"\s*:\s*"([a-z_]+)"/.exec(req.postData() ?? '')
          if (m) funnel[m[1]] = (funnel[m[1]] ?? 0) + 1
        }
        return route.continue()
      }
      if (/mainnet\.base\.org/.test(url)) {
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: rpcEnvelope(req.postData() ?? '{}') })
      }
      // Hermetic: nothing else leaves the machine (ENS, fonts, images, inprocess).
      return route.abort()
    })

    // ── 1. the button in the discover header, phone width ──
    console.log('discover header')
    await page.goto(`${base}/discover`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    const sweepBtn = page.getByRole('button', { name: /^sweep$/i })
    await sweepBtn.waitFor({ state: 'visible', timeout: 60_000 })
    ok(true, 'the sweep button renders once /api/sweep answers with a pool')
    const toggle = page.getByRole('button', { name: /^primary$/i })
    const statsBtn = page.getByRole('button', { name: /^stats$/i })
    const rowMetrics = async () => {
      const row = await sweepBtn.evaluateHandle((el) => el.parentElement!)
      const m = await row.evaluate((el: HTMLElement) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }))
      const t = (await toggle.boundingBox())!
      const s = (await statsBtn.boundingBox())!
      const b = (await sweepBtn.boundingBox())!
      return { ...m, toggle: t, stats: s, button: b }
    }
    const m375 = await rowMetrics()
    ok(m375.scrollWidth <= m375.clientWidth, 'at 375 px the header row does not overflow', m375)
    ok(m375.stats.y >= m375.toggle.y + m375.toggle.height - 1, 'at 375 px the stats block wraps under the toggle and the button', m375)
    ok(Math.abs(m375.button.y - m375.toggle.y) < m375.toggle.height, 'at 375 px the button sits on the toggle\'s row', m375)
    await page.screenshot({ path: `${SHOTS}/sweep-header-375.png` })
    await page.setViewportSize({ width: 1280, height: 800 })
    await sleep(300)
    const m1280 = await rowMetrics()
    ok(Math.abs(m1280.stats.y - m1280.toggle.y) < m1280.toggle.height * 2, 'at 1280 px the stats block sits on the same row, at the right', m1280)
    ok(m1280.stats.x > m1280.button.x + m1280.button.width, 'at 1280 px the stats block is right of the button', m1280)
    await page.screenshot({ path: `${SHOTS}/sweep-header-1280.png` })
    await page.setViewportSize({ width: 375, height: 812 })

    // ── 2. the sheet: verify → ready, live values, remove / undo ──
    console.log('sheet')
    await sweepBtn.click()
    const dialog = page.getByRole('dialog', { name: 'Sweep' })
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    const primary = dialog.locator('button.w-full')
    const label = async () => ((await primary.textContent()) ?? '').trim()
    const total10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].reduce((s, id) => s + outlay(id), 0n)
    ok(await until(async () => (await label()) === `sweep 10 for ${formatPrice(total10.toString(), 'eth')}`, 30_000), 'ready: "sweep 10 for <Σ live price + fee>" — the index\'s fake numbers never show', await label())
    ok((await dialog.getByRole('button', { name: /^Remove / }).count()) === 10, 'ten basket rows with a remove control; the two reserve rows are hidden')
    ok((await dialog.getByRole('listitem').count()) === 10, 'no other rows are painted')
    const row1 = dialog.getByRole('listitem').filter({ has: page.getByText('Piece 1', { exact: true }) })
    ok((await row1.textContent())?.includes(`${formatPrice(price(1).toString(), 'eth')} + fee`) === true, 'a row shows its LIVE price with the fee suffix', await row1.textContent())
    await page.screenshot({ path: `${SHOTS}/sweep-sheet-ready.png` })
    await dialog.getByRole('button', { name: 'Remove Piece 1', exact: true }).click()
    const total9 = total10 - outlay(1)
    ok(await until(async () => (await label()) === `sweep 9 for ${formatPrice(total9.toString(), 'eth')}`, 5_000), 'removing a row re-totals: "sweep 9 for …"', await label())
    ok((await dialog.getByRole('button', { name: /^undo$/i }).count()) === 1, 'the removed row offers undo')
    ok(funnel.sweep_open === undefined || funnel.sweep_open === 1, 'sweep_open beaconed at most once so far', funnel)

    // ── 3. the wallet prompt: the exact transaction ──
    console.log('wallet prompt')
    await primary.click()
    ok(await until(() => wallet.sent.length === 1, 20_000), 'exactly one transaction reaches the wallet')
    const tx = wallet.sent[0]
    ok(tx.to.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase(), 'to = Multicall3', tx.to)
    ok(tx.value === total9, 'value = Σ (live price + fee) of the 9 remaining rows', tx.value)
    ok(SUFFIX.length > 0 && tx.data.endsWith(SUFFIX), 'the ERC-8021 builder suffix is appended to the calldata')
    const calldata = tx.data.slice(0, tx.data.length - SUFFIX.length) as Hex
    let decodedOk = false
    try {
      const { functionName, args } = decodeFunctionData({ abi: AGG3V_ABI, data: calldata })
      const calls = args[0]
      const mints = calls.map((c) => {
        const { functionName: fn, args: a } = decodeFunctionData({ abi: MINT_1155_ABI, data: c.callData })
        const [to, comment] = decodeAbiParameters([{ type: 'address' }, { type: 'string' }], a[4] as Hex)
        return { fn, target: c.target, allowFailure: c.allowFailure, value: c.value, minter: a[0] as string, id: a[1] as bigint, qty: a[2] as bigint, referral: (a[3] as string[])[0], to, comment }
      })
      decodedOk =
        functionName === 'aggregate3Value' &&
        mints.length === 9 &&
        mints.every((m) => m.fn === 'mint' && m.allowFailure === false && m.qty === 1n && getAddress(m.to) === USER && m.comment === DEFAULT_COLLECT_COMMENT && getAddress(m.minter) === getAddress(FPSS) && getAddress(m.referral) === getAddress(REFERRAL)) &&
        mints.map((m) => Number(m.id)).join() === '2,3,4,5,6,7,8,9,10' &&
        mints.every((m) => m.value === outlay(Number(m.id)) && m.target.toLowerCase() === colOf(Number(m.id)).toLowerCase())
      ok(decodedOk, 'aggregate3Value of 9 strict mint sub-calls: ids 2–10, quantity 1, mintTo = user, the treasury referral, each value = live price + fee, each to its own collection', mints.map((m) => ({ id: m.id, v: m.value, af: m.allowFailure })))
    } catch (e) {
      ok(false, 'the calldata decodes as aggregate3Value(mint…)', String(e))
    }

    // ── 4. confirming → done; records; beacons ──
    console.log('done')
    ok(await until(async () => /swept 9 artworks/.test((await dialog.textContent()) ?? ''), 45_000), 'the sheet reaches "swept 9 artworks" from the receipt', (await dialog.textContent())?.slice(0, 200))
    const link = dialog.getByRole('link', { name: /view on basescan/i })
    const receiptHash = [...chain.receipts.keys()][0]
    ok((await link.getAttribute('href')) === `https://basescan.org/tx/${receiptHash}`, 'the Basescan link carries the transaction hash')
    ok((await label()) === 'sweep the next 10', 'the primary offers the next round')
    ok((await dialog.getByText(/^swept$/).count()) === 9, 'the nine swept rows are marked')
    ok((await dialog.getByRole('button', { name: /^undo$/i }).isDisabled()), 'undo is inert after the sweep landed')
    await page.screenshot({ path: `${SHOTS}/sweep-sheet-done.png` })
    const recordKeys = () => [...upstash.store.keys()].filter((k) => k.startsWith(`verify:collect:${receiptHash.toLowerCase()}:`))
    ok(await until(() => recordKeys().length === 9, 30_000), 'nine /api/collect records verified on-chain by the server (one per swept row)', recordKeys().length)
    const funnelKeys = (ev: string) => [...upstash.store.entries()].filter(([k]) => k.startsWith(`kismetart:funnel:${ev}:`)).map(([, v]) => v.v)
    ok(await until(() => funnelKeys('sweep_success').join() === '1', 10_000), 'sweep_success counted once in Redis', funnelKeys('sweep_success'))
    ok(funnelKeys('sweep_attempt').join() === '1', 'sweep_attempt counted once', funnelKeys('sweep_attempt'))
    ok(funnelKeys('sweep_open').join() === '1', 'sweep_open counted once', funnelKeys('sweep_open'))

    // ── 5. the next round excludes what the wallet now owns ──
    console.log('next round')
    await primary.click()
    const next3 = outlay(1) + outlay(11) + outlay(12)
    ok(await until(async () => (await label()) === `sweep 3 for ${formatPrice(next3.toString(), 'eth')}`, 30_000), 'the next round holds only the three the wallet does not own (the removed one and the two reserve rows)', await label())
    ok(funnelKeys('sweep_open').join() === '1', 're-opening for the next round is NOT a new sweep_open', funnelKeys('sweep_open'))

    // ── 6. needs more ETH ──
    console.log('needs more ETH')
    chain.ethBalance = 0n
    await dialog.getByRole('button', { name: '20', exact: true }).click()
    ok(await until(async () => (await label()) === 'add ETH, then re-check', 30_000), 'an empty wallet reads "add ETH, then re-check"', await label())
    ok(/3 more need more ETH/.test((await dialog.textContent()) ?? ''), 'the footnote counts the unaffordable rows')
    ok(!(await primary.isDisabled()), 'the re-check button stays enabled')
    await page.screenshot({ path: `${SHOTS}/sweep-sheet-unaffordable.png` })
    await page.keyboard.press('Escape')
    ok(await until(async () => (await dialog.count()) === 0, 5_000), 'Escape closes the sheet')
    chain.ethBalance = ETH

    // ── 7. flag off → no button ──
    console.log('flag off')
    ok((await adminPost(false)).status === 200, 'admin POST { enabled: false }')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await statsBtn.waitFor({ state: 'visible', timeout: 60_000 })
    await sleep(3_000)
    ok((await sweepBtn.count()) === 0, 'with the flag off the header renders no sweep button')

    // ── 8. a single eligible item takes the direct mint ──
    console.log('single item')
    ok((await adminPost(true)).status === 200, 'admin POST { enabled: true }')
    upstash.store.set('kismetart:sweep-index', { v: JSON.stringify({ updatedAt: Date.now(), eligible: 1, items: [poolRow(1)] }) })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await sweepBtn.waitFor({ state: 'visible', timeout: 60_000 })
    await sweepBtn.click()
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    ok(await until(async () => (await label()) === `sweep 1 for ${formatPrice(outlay(1).toString(), 'eth')}`, 30_000), 'one row: "sweep 1 for …"', await label())
    await primary.click()
    ok(await until(() => wallet.sent.length === 2, 20_000), 'the transaction reaches the wallet')
    const single = wallet.sent[1]
    ok(single.to.toLowerCase() === COL_A.toLowerCase() && single.value === outlay(1) && single.data.endsWith(SUFFIX), 'a lone item is a direct 1155.mint to the collection (Purchased.sender stays the user), with the builder suffix', { to: single.to, value: single.value })
    try {
      const { functionName, args } = decodeFunctionData({ abi: MINT_1155_ABI, data: single.data.slice(0, single.data.length - SUFFIX.length) as Hex })
      const [to] = decodeAbiParameters([{ type: 'address' }, { type: 'string' }], args[4] as Hex)
      ok(functionName === 'mint' && args[1] === 1n && args[2] === 1n && getAddress(to) === USER, 'mint(FPSS, 1, 1, [referral], (user, comment))')
    } catch (e) {
      ok(false, 'the direct mint calldata decodes', String(e))
    }
    ok(await until(async () => /swept 1 artwork\b/.test((await dialog.textContent()) ?? ''), 45_000), 'the sheet reaches "swept 1 artwork"')
    ok(await until(() => [...upstash.store.keys()].filter((k) => k.startsWith(`verify:collect:${[...chain.receipts.keys()][1].toLowerCase()}:`)).length === 1, 30_000), 'the record is verified server-side')

    ok(pageErrors.length === 0, 'no uncaught page errors during the run', pageErrors)
    console.log(`\n${failed === 0 ? 'OK' : 'FAILED'} — sweep browser e2e: ${passed} passed, ${failed} failed`)
    stop()
    process.exit(failed === 0 ? 0 : 1)
  } catch (e) {
    console.error('e2e error:', e)
    try {
      const pages = browser.contexts().flatMap((c) => c.pages())
      if (pages[0]) await pages[0].screenshot({ path: `${SHOTS}/sweep-failure.png` })
    } catch {}
    stop()
    process.exit(1)
  }
}

main()
