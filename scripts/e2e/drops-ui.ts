/**
 * Claim drops in a real Chromium against the BUILT app: the pages a collector
 * and an artist use, with a wallet whose signatures come from real keys.
 *
 * The drops APIs the pages call are answered here by a small stateful fake
 * that checks every signature it is sent with viem, against the messages the
 * real routes rebuild (the routes themselves run for real in drops-flow.ts).
 * Base RPC calls from the browser go to a local chain that turns the artist's
 * airdrop transaction into the receipt and TransferSingle logs Base would
 * emit. So this covers the browser's half: what each state renders, and that
 * claiming and the four-step delivery send exactly what the routes expect, in
 * order, signed by the right wallet.
 *
 * Needs `npm run build` and Chromium. Run: `npm run e2e:drops:ui`.
 */
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  numberToHex,
  parseAbi,
  verifyTypedData,
  zeroAddress,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { startRealRedis } from './_upstash-redis.ts'
import { KISMET_INTENT_DOMAIN, MINT_INTENT_TYPES, buildMintIntent, type MintBody } from '@/lib/intent'
import { CLAIM_DROP_TYPES, buildClaimDropMessage, type ClaimView, type DropRecord } from '@/lib/drops'

// playwright is loaded ad hoc, not a repo dependency (scripts/e2e/README.md),
// so its types aren't here either: the slice this check uses is typed below.
interface PwRequest {
  url(): string
  method(): string
  postData(): string | null
  resourceType(): string
}
interface PwRoute {
  request(): PwRequest
  fulfill(r: { status: number; contentType: string; body: string | Buffer }): Promise<void>
  fallback(): Promise<void>
}
interface PwPage {
  goto(url: string, o?: { waitUntil?: 'domcontentloaded' }): Promise<unknown>
  bringToFront(): Promise<void>
  waitForSelector(selector: string, o?: { timeout?: number; state?: 'detached' }): Promise<unknown>
  waitForFunction(fn: () => boolean): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  isVisible(selector: string): Promise<boolean>
  click(selector: string): Promise<void>
  on(event: 'pageerror', fn: (e: Error) => void): void
}
interface PwContext {
  exposeFunction(name: string, fn: (...args: never[]) => unknown): Promise<void>
  addInitScript<A>(fn: (arg: A) => void, arg: A): Promise<void>
  route(url: RegExp | string, handler: (route: PwRoute) => unknown): Promise<void>
  newPage(): Promise<PwPage>
  close(): Promise<void>
}
interface PwBrowser {
  newContext(o: { viewport: { width: number; height: number }; userAgent: string }): Promise<PwContext>
  close(): Promise<void>
}
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch(): Promise<PwBrowser> } }

let passed = 0
let failed = 0
function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const section = (s: string) => console.log(`\n${s}`)

// ───────────────────────── fixtures ─────────────────────────

const artist = privateKeyToAccount(generatePrivateKey())
const collector = privateKeyToAccount(generatePrivateKey())
const others = [0, 1].map(() => privateKeyToAccount(generatePrivateKey()))
const KEY = `0x${'d1'.repeat(32)}` as Hex
const COLLECTION = `0x${'c0'.repeat(20)}` as Hex
const TOKEN_ID = '7'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const nowSec = () => Math.floor(Date.now() / 1000)

// ───────────────────────── the drops API, faked with real checks ─────────────────────────

interface State {
  drop: DropRecord
  claims: ClaimView[]
  settlement: { key: string; collection: string; tokenId: string; airdropTx: string; recipients: number } | null
  calls: string[]
  minted: { collection: string; tokenId: string } | null
  body: MintBody | null
  recipients: string[]
  notify: Record<string, unknown> | null
}
let state!: State
function reset(closesAt: number, claimers: string[]): void {
  state = {
    drop: {
      key: KEY,
      artist: artist.address.toLowerCase(),
      owner: artist.address.toLowerCase(),
      title: 'Dawn',
      description: 'first light',
      swarmRef: 'ab'.repeat(32),
      mime: 'image/png',
      closesAt,
      maxClaims: 10,
    },
    claims: claimers.map((owner, i) => ({ key: `0x${(i + 1).toString(16).padStart(64, '0')}`, collector: owner, owner, claimedAt: nowSec() - 100 + i })),
    settlement: null,
    calls: [],
    minted: null,
    body: null,
    recipients: [],
    notify: null,
  }
}
const nonces = new Map<string, number>()

// ───────────────────────── a local Base ─────────────────────────

const ADMIN_MINT = parseAbi(['function adminMint(address recipient, uint256 tokenId, uint256 quantity, bytes data)'])
const MULTICALL = parseAbi(['function multicall(bytes[] data) returns (bytes[])'])
const TRANSFER_SINGLE = parseAbi(['event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'])
let head = 30_000_000n
const receipts = new Map<string, Record<string, unknown>>()
const sent: { to: string; recipients: string[]; from: string }[] = []

function sendTransaction(tx: { from: string; to: string; data: Hex }): Hex {
  let calls: Hex[]
  try {
    calls = [...decodeFunctionData({ abi: MULTICALL, data: tx.data }).args[0]]
  } catch {
    calls = [tx.data]
  }
  const recipients = calls.map((c) => (decodeFunctionData({ abi: ADMIN_MINT, data: c }).args[0] as string).toLowerCase())
  sent.push({ to: tx.to.toLowerCase(), recipients, from: tx.from.toLowerCase() })
  head += 1n
  const hash = `0x${(sent.length).toString(16).padStart(64, 'f')}` as Hex
  receipts.set(hash, {
    transactionHash: hash,
    blockHash: `0x${head.toString(16).padStart(64, '0')}`,
    blockNumber: numberToHex(head),
    transactionIndex: '0x0',
    from: tx.from,
    to: tx.to,
    status: '0x1',
    gasUsed: '0x5208',
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    contractAddress: null,
    logsBloom: `0x${'00'.repeat(256)}`,
    type: '0x2',
    logs: recipients.map((to, i) => ({
      address: tx.to.toLowerCase(),
      topics: encodeEventTopics({ abi: TRANSFER_SINGLE, eventName: 'TransferSingle', args: { operator: tx.from as Hex, from: zeroAddress, to: to as Hex } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(TOKEN_ID), 1n]),
      blockNumber: numberToHex(head),
      transactionHash: hash,
      transactionIndex: '0x0',
      blockHash: `0x${head.toString(16).padStart(64, '0')}`,
      logIndex: numberToHex(i),
      removed: false,
    })),
  })
  return hash
}

function rpc(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_chainId':
      return '0x2105'
    case 'eth_blockNumber':
      return numberToHex(head)
    case 'eth_getTransactionReceipt':
      return receipts.get(String(params[0])) ?? null
    case 'eth_getTransactionByHash': {
      const r = receipts.get(String(params[0]))
      return r ? { hash: r.transactionHash, blockNumber: r.blockNumber, blockHash: r.blockHash, from: r.from, to: r.to, input: '0x', nonce: '0x0', value: '0x0', gas: '0x5208', type: '0x2', chainId: '0x2105', transactionIndex: '0x0', v: '0x0', r: '0x1', s: '0x1' } : null
    }
    case 'eth_getBlockByNumber':
      return { number: numberToHex(head), hash: `0x${head.toString(16).padStart(64, '0')}`, timestamp: numberToHex(nowSec()), baseFeePerGas: '0x1', transactions: [] }
    case 'eth_getLogs':
      return [...receipts.values()].flatMap((r) => r.logs as unknown[])
    // What a wallet client may ask while preparing a transaction.
    case 'eth_estimateGas':
      return '0x30d40'
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return '0x1'
    case 'eth_getTransactionCount':
      return '0x0'
    default:
      throw Object.assign(new Error(`not modelled: ${method}`), { code: -32601 })
  }
}

// ───────────────────────── boot ─────────────────────────

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })
}

const redis = await startRealRedis()
const port = await freePort()
const origin = `http://127.0.0.1:${port}`
const server: ChildProcess = spawn('npx', ['next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
  env: {
    ...process.env,
    UPSTASH_REDIS_REST_URL: redis.url,
    UPSTASH_REDIS_REST_TOKEN: 'local',
    DROPS_ENABLED: '1',
    ARKIV_WRITER_PRIVATE_KEY: generatePrivateKey(),
    CRON_INPROCESS: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout?.on('data', (d) => (serverLog += d))
server.stderr?.on('data', (d) => (serverLog += d))
for (let i = 0; i < 120; i++) {
  const up = await fetch(`${origin}/drops`).then((r) => r.status).catch(() => 0)
  if (up === 200) break
  await new Promise((r) => setTimeout(r, 500))
}

const browser = await chromium.launch()

async function open(wallet: ReturnType<typeof privateKeyToAccount> | null, path: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 CoinbaseWallet/1.0',
  })
  const signed: string[] = []
  if (wallet) {
    await context.exposeFunction('__e2eSign', async (json: string) => {
      const td = JSON.parse(json) as { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }
      const { EIP712Domain: _ignored, ...types } = td.types
      signed.push(td.primaryType)
      return wallet.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message } as never)
    })
    await context.exposeFunction('__e2eSend', async (tx: { from: string; to: string; data: Hex }) => sendTransaction(tx))
    await context.exposeFunction('__e2eRpc', async (method: string, params: unknown[]) => rpc(method, params))
    await context.addInitScript((addr: string) => {
      const provider = {
        isCoinbaseWallet: true,
        async request({ method, params }: { method: string; params?: unknown[] }) {
          const w = window as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [addr]
            case 'eth_chainId':
              return '0x2105'
            case 'net_version':
              return '8453'
            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain':
              return null
            case 'wallet_getPermissions':
            case 'wallet_requestPermissions':
              return [{ parentCapability: 'eth_accounts' }]
            case 'eth_signTypedData_v4':
              return w.__e2eSign(params![1])
            case 'eth_sendTransaction':
              return w.__e2eSend(params![0])
            default:
              return w.__e2eRpc(method, params ?? [])
          }
        },
        on() { return this },
        removeListener() { return this },
        removeAllListeners() { return this },
      }
      Object.defineProperty(window, 'ethereum', { value: provider, configurable: true })
    }, wallet.address)
  }

  // The browser's Base reads.
  await context.route(/mainnet\.base\.org/, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    const one = (m: { id: number; method: string; params?: unknown[] }) => {
      try {
        return { jsonrpc: '2.0', id: m.id, result: rpc(m.method, m.params ?? []) }
      } catch (e) {
        return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: (e as Error).message } }
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) })
  })
  // Images load (nothing external can in this sandbox).
  await context.route('**/*', (r) =>
    r.request().resourceType() === 'image' ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : r.fallback())

  // The drops API.
  await context.route(/\/api\/(drops|auth\/intent-nonce|session|airdrop\/notify)/, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const p = url.pathname
    const body = req.postData() ? JSON.parse(req.postData()!) : {}
    state.calls.push(`${req.method()} ${p}`)
    const view = () => ({ ...state.drop, claimCount: state.claims.length, delivered: state.settlement !== null })

    if (p === '/api/auth/intent-nonce') {
      const nonce = Math.random().toString(16).slice(2).padEnd(32, '0')
      const expiresAt = nowSec() + 300
      nonces.set(nonce, expiresAt)
      return json(200, { nonce, expiresAt })
    }
    if (p === '/api/session') return json(200, { address: wallet?.address.toLowerCase() })
    if (p === '/api/airdrop/notify') {
      state.notify = body
      return json(200, { ok: true })
    }
    if (p === '/api/drops') {
      const open = state.drop.closesAt > nowSec()
      return json(200, { open: open ? [view()] : [], settling: open ? [] : [view()] })
    }
    if (p === '/api/drops/claims') {
      const owner = url.searchParams.get('owner')?.toLowerCase()
      const mine = state.claims.filter((c) => c.owner === owner)
      return json(200, { claims: mine.map((c) => ({ claimKey: c.key, dropKey: KEY, title: state.drop.title, artist: state.drop.artist, closesAt: state.drop.closesAt, claimedAt: c.claimedAt, settlement: state.settlement })) })
    }
    if (p === `/api/drops/${KEY}/media`) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    if (p === `/api/drops/${KEY}`) {
      const viewer = url.searchParams.get('viewer')?.toLowerCase()
      return json(200, { drop: view(), claims: state.claims, settlement: state.settlement, viewerClaimed: !!viewer && state.claims.some((c) => c.owner === viewer) })
    }
    if (p === `/api/drops/${KEY}/claim`) {
      const { account, intent } = body as { account: Hex; intent: { signature: Hex; nonce: string; expiresAt: number } }
      const valid = nonces.delete(intent.nonce) && (await verifyTypedData({
        address: account,
        domain: KISMET_INTENT_DOMAIN,
        types: CLAIM_DROP_TYPES,
        primaryType: 'ClaimDrop',
        message: buildClaimDropMessage(account, KEY, intent.nonce, intent.expiresAt),
        signature: intent.signature,
      }))
      if (!valid) return json(401, { error: 'Invalid signature' })
      state.claims.push({ key: `0x${'ee'.repeat(32)}`, collector: account.toLowerCase(), owner: account.toLowerCase(), claimedAt: nowSec() })
      return json(200, { claimKey: `0x${'ee'.repeat(32)}`, txHash: `0x${'aa'.repeat(32)}` })
    }
    if (p === `/api/drops/${KEY}/settle/prepare`) {
      state.recipients = [...state.claims.map((c) => c.owner), state.drop.artist]
      state.body = {
        account: artist.address,
        contract: { name: state.drop.title, uri: 'ar://collection' },
        token: {
          tokenMetadataURI: 'ar://token',
          salesConfig: { type: 'fixedPrice', pricePerToken: '0', saleStart: '0', saleEnd: '1' },
          mintToCreatorCount: 0,
          maxSupply: state.recipients.length,
          payoutRecipient: artist.address,
        },
      } as MintBody
      return json(200, { body: state.body, recipients: state.recipients, minted: state.minted })
    }
    if (p === `/api/drops/${KEY}/settle/mint`) {
      const { intent } = body as { intent: { signature: Hex; nonce: string; expiresAt: number } }
      const valid = nonces.delete(intent.nonce) && (await verifyTypedData({
        address: artist.address,
        domain: KISMET_INTENT_DOMAIN,
        types: MINT_INTENT_TYPES,
        primaryType: 'MintIntent',
        message: buildMintIntent(state.body!, 'mint', intent.nonce, intent.expiresAt),
        signature: intent.signature,
      }))
      if (!valid) return json(401, { error: 'Invalid signature' })
      state.minted = { collection: COLLECTION, tokenId: TOKEN_ID }
      return json(200, state.minted)
    }
    if (p === `/api/drops/${KEY}/settle`) {
      const tx = body.txHash as string | undefined
      const done = tx && sent.length > 0 && sent.at(-1)!.to === COLLECTION
        && state.recipients.every((r) => sent.at(-1)!.recipients.includes(r)) && sent.at(-1)!.from === state.drop.artist
      if (!done) return json(200, { delivered: false })
      state.settlement = { key: `0x${'5e'.repeat(32)}`, collection: COLLECTION, tokenId: TOKEN_ID, airdropTx: tx!, recipients: state.recipients.length }
      return json(200, { delivered: true, collection: COLLECTION, tokenId: TOKEN_ID })
    }
    return route.fallback()
  })

  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' })
  await page.bringToFront()
  return { page, context, signed, errors }
}

const text = (s: string) => `text=${s}`

try {
  section('collector — an open drop')
  reset(nowSec() + 3600, [others[0].address.toLowerCase()])
  {
    const { page, context, signed, errors } = await open(collector, `/drops/${KEY}`)
    await page.waitForSelector(text('Claim — free'), { timeout: 30_000 })
    ok(await page.isVisible(text('1 / 10 claimed')), 'the claim count reads from the drop')
    ok(await page.isVisible('button:has-text("share")'), 'a share action is offered while open')
    // The auto-connect lands a moment after hydration.
    await page.waitForFunction(() => (window as unknown as { ethereum?: unknown }).ethereum !== undefined)
    await page.waitForTimeout(1500)
    await page.click(text('Claim — free'))
    await page.waitForSelector(text('Claimed ✓'), { timeout: 30_000 })
    ok(signed.join() === 'ClaimDrop', 'claiming is one ClaimDrop signature', signed)
    ok(state.claims.some((c) => c.owner === collector.address.toLowerCase()), 'the claim was accepted with a valid signature for this wallet')
    ok(errors.length === 0, 'no page errors', errors)
    await context.close()
  }

  section('collector — the feed and their claims')
  {
    const { page, context, errors } = await open(collector, '/drops')
    await page.waitForSelector(text('Your claims'), { timeout: 30_000 })
    ok(await page.isVisible('a:has-text("Dawn")'), 'their claim is listed and links the drop')
    ok(await page.isVisible(text('Open now')), 'the open drop is in the feed')
    ok(errors.length === 0, 'no page errors', errors)
    await context.close()
  }

  section('the window closes while the page is open')
  reset(nowSec() + 4, [others[0].address.toLowerCase()])
  {
    const { page, context, errors } = await open(collector, `/drops/${KEY}`)
    await page.waitForSelector(text('Claim — free'), { timeout: 30_000 })
    await page.waitForSelector(text('Claim — free'), { state: 'detached', timeout: 15_000 }).catch(() => null)
    const late = Date.now() / 1000 - state.drop.closesAt
    ok(!(await page.isVisible(text('Claim — free'))) && (await page.isVisible('p:has-text("Claims closed")')) && late < 2,
      `the Claim button goes at the closing second, without a reload (${late.toFixed(2)}s after close)`, late)
    ok(errors.length === 0, 'no page errors', errors)
    await context.close()
  }

  section('artist — deliver a closed drop')
  reset(nowSec() - 60, [others[0].address.toLowerCase(), others[1].address.toLowerCase()])
  {
    const { page, context, signed, errors } = await open(artist, `/drops/${KEY}`)
    await page.waitForSelector(text('Deliver to 2 collectors'), { timeout: 30_000 })
    ok(await page.isVisible(text('Deliver this drop')), 'the artist sees the delivery panel')
    ok(await page.isVisible(text('mints an edition of 3')), 'it states the exact edition: each claim\'s owner plus the artist')
    await page.waitForTimeout(1500)
    await page.click(text('Deliver to 2 collectors'))
    await page.waitForSelector(text('Delivered ✓ — airdropped to 3 wallets.'), { timeout: 60_000 })
    const order = state.calls.filter((c) => /settle|intent-nonce|airdrop\/notify/.test(c))
    ok(order.join(' → ') === `POST /api/drops/${KEY}/settle/prepare → POST /api/auth/intent-nonce → POST /api/drops/${KEY}/settle/mint → POST /api/airdrop/notify → POST /api/drops/${KEY}/settle`
      || order.join(' → ') === `POST /api/drops/${KEY}/settle/prepare → POST /api/auth/intent-nonce → POST /api/drops/${KEY}/settle/mint → POST /api/drops/${KEY}/settle → POST /api/airdrop/notify`,
    'prepare → nonce → mint → airdrop → record, in order', order)
    ok(signed.join() === 'MintIntent', 'one MintIntent signature, valid over the prepared body', signed)
    const tx = sent.at(-1)
    ok(!!tx && tx.to === COLLECTION && tx.from === artist.address.toLowerCase() && tx.recipients.join() === state.recipients.join(),
      'one airdrop transaction from the artist, to every claimer and the artist', tx)
    ok(!!state.notify && (state.notify.recipients as string[]).length === 3 && state.notify.txHash === state.settlement?.airdropTx,
      'the airdrop is recorded like any Kismet airdrop (collectors get the airdrop notice)', state.notify)
    ok(await page.isVisible(`a[href="/artwork/${COLLECTION}/${TOKEN_ID}"]`), 'the delivered drop links its artwork')
    ok(errors.length === 0, 'no page errors', errors)
    await context.close()
  }

  section('artist — nobody claimed')
  reset(nowSec() - 60, [])
  {
    const { page, context, errors } = await open(artist, `/drops/${KEY}`)
    await page.waitForSelector(text('Nobody claimed this drop'), { timeout: 30_000 })
    ok(!(await page.isVisible('button:has-text("Deliver")')), 'no delivery is offered for a drop with no claims')
    ok(errors.length === 0, 'no page errors', errors)
    await context.close()
  }

  section('server-rendered pieces')
  {
    const og = await fetch(`${origin}/drops/${KEY}/opengraph-image`)
    ok(og.status === 200 && og.headers.get('content-type') === 'image/png', 'the share card renders (the bare card for a drop Arkiv doesn\'t have)', og.status)
    const html = await fetch(`${origin}/drops/${KEY}`).then((r) => r.text())
    ok(html.includes(`<link rel="canonical" href="https://kismet.art/drops/${KEY}"`) || html.includes(`/drops/${KEY}"`), 'the drop page server-renders with its canonical URL')
    const { page, context, errors } = await open(artist, '/drops/new')
    await page.waitForSelector(text('Open a claim drop'), { timeout: 30_000 })
    ok(await page.isVisible(text('Up to 199 — when it closes')), 'the open form states the 199-claim cap and the delivery')
    ok(errors.length === 0, 'no page errors on the open form', errors)
    await context.close()
  }

  section('collector — delivered')
  reset(nowSec() - 60, [collector.address.toLowerCase()])
  state.settlement = { key: `0x${'5e'.repeat(32)}`, collection: COLLECTION, tokenId: TOKEN_ID, airdropTx: `0x${'ab'.repeat(32)}`, recipients: 2 }
  {
    const { page, context, errors } = await open(collector, `/drops/${KEY}`)
    await page.waitForSelector(text('Delivered ✓ — your copy is in your wallet.'), { timeout: 30_000 })
    ok(await page.isVisible('a:has-text("airdrop on Base")'), 'the airdrop transaction is linked')
    ok(errors.length === 0, 'no page errors', errors)
    await context.close()
  }
} catch (err) {
  failed++
  console.error('\nerror:', err)
  console.error(serverLog.slice(-2000))
} finally {
  await browser.close()
  server.kill('SIGTERM')
  redis.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
