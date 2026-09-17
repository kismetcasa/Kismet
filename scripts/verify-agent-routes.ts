/**
 * Agent surface ROUTE-LEVEL end-to-end harness. Boots the REAL built server
 * (`next start`) with every external dependency pointed at local mocks —
 * Upstash REST, Base JSON-RPC, mainnet RPC — and drives the HTTP routes the way
 * an assistant and the profile UI do. This proves the wiring the module-level
 * oracles cannot: content negotiation on the GET prepares, the envelopes as
 * actually served (link, summary, record.getUrl, caps), the on-chain liveness
 * guard on buy, the session-bound scout config lifecycle including turn-off
 * with the revoke queue, and record-by-GET delegating in-process to the
 * on-chain-verified record handler (with its after() work running).
 *
 * Needs a build first (`next build`). Run:
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
 *     --import ./scripts/register-ts-alias.mjs scripts/verify-agent-routes.ts
 */

import http from 'node:http'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { AddressInfo } from 'node:net'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  parseAbi,
  type Hex,
} from 'viem'
import { createMockUpstash } from './_mock-upstash.ts'
import { SEAPORT_ABI, buildSellOrder, serializeOrder } from '@/lib/seaport'
import { PLATFORM_FEE_RECIPIENT } from '@/lib/platformFee'
import { shortAddress } from '@/lib/inprocess'

// ───────────────────────── tiny test runner ─────────────────────────

let passed = 0
let failed = 0
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  }
}

// ───────────────────────── fixtures ─────────────────────────

const USER = getAddress(`0x${'aa'.repeat(20)}`)
const BUYER = getAddress(`0x${'ab'.repeat(20)}`)
const SELLER = getAddress(`0x${'ba'.repeat(20)}`)
const ARTIST = getAddress(`0x${'dd'.repeat(20)}`)
const COLLECTION = getAddress(`0x${'c0'.repeat(20)}`)
const SPENDER = getAddress(`0x${'cc'.repeat(20)}`)
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const RECORD_TX = `0x${'7a'.repeat(32)}` as Hex
const PRICE = 1_000_000_000_000_000n // 0.001 ETH
const MINT_FEE = 111_000_000_000_000n
const LISTING_PRICE = 50_000_000_000_000_000n // 0.05 ETH

// ───────────────────────── mock Base + mainnet JSON-RPC ─────────────────────────

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const SEAPORT = '0x00000000000000adc04c56bf30ac9d3c0aaf14dc'
const MULTICALL3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
])
const FPSS_SALE_ABI = parseAbi([
  'function sale(address tokenContract, uint256 tokenId) view returns ((uint64 saleStart, uint64 saleEnd, uint64 maxTokensPerAddress, uint96 pricePerToken, address fundsRecipient))',
])
const TOKEN_INFO_ABI = parseAbi(['function getTokenInfo(uint256 tokenId) view returns ((string uri, uint256 maxSupply, uint256 totalMinted))'])
const BALANCE_ABI = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)'])
const MINT_FEE_ABI = parseAbi(['function mintFee() view returns (uint256)'])
const TRANSFER_SINGLE = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
])

const rpcState = { filled: false, cancelled: false, counter: 0n }
const CHAIN_NOW = 1_800_000_000

function handleEthCall(to: string, data: Hex): Hex {
  const target = to.toLowerCase()
  if (target === MULTICALL3) {
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
    const results = args[0].map((c) => ({ success: true, returnData: handleEthCall(c.target, c.callData) }))
    return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: results })
  }
  if (target === SEAPORT) {
    const { functionName } = decodeFunctionData({ abi: SEAPORT_ABI, data })
    if (functionName === 'getCounter') return encodeFunctionResult({ abi: SEAPORT_ABI, functionName, result: rpcState.counter })
    return encodeFunctionResult({
      abi: SEAPORT_ABI,
      functionName: 'getOrderStatus',
      result: [true, rpcState.cancelled, rpcState.filled ? 1n : 0n, 1n],
    })
  }
  try {
    decodeFunctionData({ abi: FPSS_SALE_ABI, data })
    return encodeFunctionResult({
      abi: FPSS_SALE_ABI,
      functionName: 'sale',
      result: { saleStart: 0n, saleEnd: BigInt(CHAIN_NOW) + 10_000_000n, maxTokensPerAddress: 0n, pricePerToken: PRICE, fundsRecipient: ARTIST },
    })
  } catch {}
  try {
    decodeFunctionData({ abi: TOKEN_INFO_ABI, data })
    return encodeFunctionResult({ abi: TOKEN_INFO_ABI, functionName: 'getTokenInfo', result: { uri: '', maxSupply: 0n, totalMinted: 3n } })
  } catch {}
  try {
    decodeFunctionData({ abi: BALANCE_ABI, data })
    return encodeFunctionResult({ abi: BALANCE_ABI, functionName: 'balanceOf', result: 0n })
  } catch {}
  decodeFunctionData({ abi: MINT_FEE_ABI, data }) // anything else (e.g. the ENS universal resolver) throws → RPC error → fail-open paths
  return encodeFunctionResult({ abi: MINT_FEE_ABI, functionName: 'mintFee', result: MINT_FEE })
}

const MOCK_BLOCK = {
  number: '0x10',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: `0x${CHAIN_NOW.toString(16)}`,
  nonce: '0x0000000000000000',
  difficulty: '0x0',
  gasLimit: '0x1c9c380',
  gasUsed: '0x0',
  miner: `0x${'00'.repeat(20)}`,
  extraData: '0x',
  logsBloom: `0x${'00'.repeat(256)}`,
  sha3Uncles: `0x${'33'.repeat(32)}`,
  stateRoot: `0x${'44'.repeat(32)}`,
  receiptsRoot: `0x${'55'.repeat(32)}`,
  transactionsRoot: `0x${'66'.repeat(32)}`,
  size: '0x100',
  totalDifficulty: '0x0',
  transactions: [],
  uncles: [],
  baseFeePerGas: '0x1',
}

/** A successful mint receipt: one TransferSingle of token 42 to USER. */
function mockReceipt() {
  const topics = encodeEventTopics({
    abi: TRANSFER_SINGLE,
    eventName: 'TransferSingle',
    args: { operator: ARTIST, from: `0x${'00'.repeat(20)}`, to: USER },
  })
  return {
    blockHash: MOCK_BLOCK.hash,
    blockNumber: '0x10',
    contractAddress: null,
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    from: USER,
    gasUsed: '0x5208',
    logs: [
      {
        address: COLLECTION,
        blockHash: MOCK_BLOCK.hash,
        blockNumber: '0x10',
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [42n, 1n]),
        logIndex: '0x0',
        removed: false,
        topics,
        transactionHash: RECORD_TX,
        transactionIndex: '0x0',
      },
    ],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    to: COLLECTION,
    transactionHash: RECORD_TX,
    transactionIndex: '0x0',
    type: '0x2',
  }
}

function startRpcServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      const parsed = JSON.parse(body) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[]
      const one = (rpc: { id: number; method: string; params?: unknown[] }) => {
        try {
          if (rpc.method === 'eth_chainId') return { jsonrpc: '2.0', id: rpc.id, result: '0x2105' }
          if (rpc.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: rpc.id, result: '0x10' }
          if (rpc.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: rpc.id, result: MOCK_BLOCK }
          if (rpc.method === 'eth_getCode') return { jsonrpc: '2.0', id: rpc.id, result: '0x6080' }
          if (rpc.method === 'eth_getTransactionReceipt') {
            const hash = String((rpc.params as [string])[0]).toLowerCase()
            return { jsonrpc: '2.0', id: rpc.id, result: hash === RECORD_TX ? mockReceipt() : null }
          }
          if (rpc.method === 'eth_call') {
            const call = (rpc.params as [{ to: string; data: Hex }])[0]
            return { jsonrpc: '2.0', id: rpc.id, result: handleEthCall(call.to, call.data) }
          }
          return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unhandled ${rpc.method}` } }
        } catch (e) {
          return { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: `mock: ${String(e)}` } }
        }
      }
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}

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
  const log = createWriteStream(`${process.env.TMPDIR ?? '/tmp'}/verify-agent-routes.next.log`)
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
      const r = await fetch(`${base}/api/agent/manifest`)
      if (r.ok) return { base, child }
    } catch {}
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode} (see verify-agent-routes.next.log)`)
    if (Date.now() > deadline) throw new Error('next start did not become ready in 90s')
    await new Promise((r) => setTimeout(r, 500))
  }
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const upstash = createMockUpstash()
  const [redisUrl, rpcUrl] = await Promise.all([upstash.start(), startRpcServer()])
  const { base, child } = await startNext({
    UPSTASH_REDIS_REST_URL: redisUrl,
    UPSTASH_REDIS_REST_TOKEN: 'mock-token',
    BASE_RPC_URL: rpcUrl,
    MAINNET_RPC_URL: rpcUrl,
    NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS: SPENDER,
    SCOUT_SPENDER_PRIVATE_KEY: '',
    CDP_API_KEY_ID: '',
  })
  const stop = () => {
    child.kill('SIGTERM')
    upstash.close()
  }
  process.on('exit', stop)

  try {
    const json = async (path: string, init?: RequestInit) => {
      const r = await fetch(`${base}${path}`, init)
      const text = await r.text()
      let body: unknown = null
      try {
        body = JSON.parse(text)
      } catch {}
      return { status: r.status, headers: r.headers, body: body as Record<string, unknown> | null, text }
    }
    const momentKey = `kismetart:moment-meta:${COLLECTION.toLowerCase()}:42`
    upstash.store.set(momentKey, { v: JSON.stringify({ creator: ARTIST.toLowerCase(), name: 'Dawn' }) })

    // ── 1. manifest ──
    console.log('manifest')
    const manifest = await json('/api/agent/manifest')
    const fields = (manifest.body?.envelope as { fields?: Record<string, string> })?.fields ?? {}
    ok(manifest.status === 200 && typeof fields.link === 'string' && /getUrl/.test(fields.record ?? ''), 'manifest serves and documents link + record.getUrl', manifest.status)

    // ── 2. prepare-collect GET: JSON by default, page on a navigation, format=json wins ──
    console.log('\nprepare-collect — GET content negotiation + envelope')
    const collectPath = `/api/agent/prepare-collect?collection=${COLLECTION}&tokenId=42&account=${USER}&amount=2`
    const asJson = await json(`${collectPath}&format=json`)
    const env = asJson.body as {
      calls?: { to: string; value: string }[]
      link?: { url: string; note: string }
      summary?: string
      record?: { method: string; url: string; getUrl?: string; bodyTemplate: Record<string, unknown> }
      caps?: { maxValueEth?: string }
    } | null
    ok(asJson.status === 200 && (asJson.headers.get('content-type') ?? '').includes('application/json'), 'format=json → JSON envelope', asJson.status)
    ok(asJson.headers.get('cache-control') === 'private, no-store', 'JSON envelope is private, no-store')
    ok(env?.calls?.length === 1 && env.calls[0].to.toLowerCase() === COLLECTION.toLowerCase(), 'one mint call on the collection', env?.calls)
    ok(env?.calls?.[0].value === `0x${((PRICE + MINT_FEE) * 2n).toString(16)}` && env?.caps?.maxValueEth === ((PRICE + MINT_FEE) * 2n).toString(), 'value and cap = (price + mint fee) × 2', { value: env?.calls?.[0].value, caps: env?.caps })
    ok(
      env?.summary === `Collect “Dawn” (token #42) ×2 for 0.001 ETH each + 0.000111 ETH mint fee each, 0.002222 ETH total → to ${shortAddress(USER)}.`,
      'summary names the artwork, the fee and the total',
      env?.summary,
    )
    ok(typeof env?.link?.url === 'string' && env.link.url.startsWith('https://base.app/base-pay?p='), 'Base app approve link present for an ETH mint', env?.link)
    ok(
      env?.record?.method === 'POST' && env.record.url === '/api/collect' && (env.record.getUrl ?? '').startsWith('/api/agent/record?verb=collect&') && (env.record.getUrl ?? '').endsWith('&txHash=<REPLACE_WITH_send_calls_txHash>'),
      'record hint carries the GET form with the txHash placeholder',
      env?.record?.getUrl,
    )
    const asPage = await json(collectPath, { headers: { 'sec-fetch-dest': 'document' } })
    ok(asPage.status === 200 && (asPage.headers.get('content-type') ?? '').includes('text/html'), 'a document navigation gets the HTML approve page', asPage.headers.get('content-type'))
    ok(asPage.text.includes('Approve in the Base app') && asPage.text.includes('&quot;action&quot;: &quot;collect&quot;'), 'the page carries the approve button and the escaped envelope')
    // Next appends its own Vary members (RSC, Next-Router-*), so check membership.
    ok(
      (asPage.headers.get('vary') ?? '').split(',').map((v) => v.trim().toLowerCase()).includes('sec-fetch-dest') && (asPage.headers.get('x-robots-tag') ?? '').includes('noindex'),
      'page headers: Vary includes Sec-Fetch-Dest, X-Robots-Tag noindex',
      { vary: asPage.headers.get('vary'), robots: asPage.headers.get('x-robots-tag') },
    )
    const forcedJson = await json(`${collectPath}&format=json`, { headers: { 'sec-fetch-dest': 'document' } })
    ok(forcedJson.status === 200 && (forcedJson.headers.get('content-type') ?? '').includes('application/json'), 'format=json overrides a navigation')
    const fetcher = await json(collectPath)
    ok(fetcher.status === 200 && (fetcher.headers.get('content-type') ?? '').includes('application/json'), 'a server-side fetcher (no Sec-Fetch-Dest) gets JSON')
    ok(upstash.evals.some((e) => e.keys[0]?.includes('agent-prepare-collect')), 'the per-IP rate limiter ran for the prepare')

    // ── 3. prepare-buy: envelope, then the on-chain liveness guard ──
    console.log('\nprepare-buy — envelope + Seaport order status guard')
    const order = buildSellOrder({
      offerer: SELLER,
      collectionAddress: COLLECTION,
      tokenId: '7',
      sellerProceeds: LISTING_PRICE - 2_000_000_000_000_000n - 500_000_000_000_000n,
      royaltyReceiver: ARTIST,
      royaltyAmount: 2_000_000_000_000_000n,
      platformFee: 500_000_000_000_000n,
      platformFeeRecipient: PLATFORM_FEE_RECIPIENT,
      counter: 0n,
      currency: 'eth',
    })
    const listing = {
      id: 'lst1',
      collectionAddress: COLLECTION,
      tokenId: '7',
      seller: SELLER,
      price: LISTING_PRICE.toString(),
      sellerProceeds: (LISTING_PRICE - 2_500_000_000_000_000n).toString(),
      royaltyReceiver: ARTIST,
      royaltyAmount: '2000000000000000',
      currency: 'eth',
      platformFee: '500000000000000',
      platformFeeRecipient: PLATFORM_FEE_RECIPIENT,
      orderComponents: serializeOrder(order),
      signature: `0x${'ab'.repeat(65)}`,
      createdAt: Date.now() - 1000,
      expiresAt: Date.now() + 86_400_000,
      status: 'active',
      name: 'Nice “art”',
    }
    upstash.store.set('kismetart:listing:lst1', { v: JSON.stringify(listing) })
    const buy = await json(`/api/agent/prepare-buy?listingId=lst1&account=${BUYER}&format=json`)
    const buyEnv = buy.body as { summary?: string; link?: { url: string }; record?: { getUrl?: string }; caps?: { maxValueEth?: string } } | null
    ok(buy.status === 200, 'active listing → 200', buy.text.slice(0, 200))
    ok(buyEnv?.summary === `Buy “Nice ’art’” (token #7) from ${shortAddress(SELLER)} for 0.05 ETH.`, 'buy summary: sanitized title, seller, price', buyEnv?.summary)
    ok(typeof buyEnv?.link?.url === 'string' && buyEnv?.caps?.maxValueEth === LISTING_PRICE.toString(), 'buy link + cap', buyEnv?.caps)
    ok(buyEnv?.record?.getUrl === '/api/agent/record?verb=buy&listingId=lst1&txHash=<REPLACE_WITH_send_calls_txHash>', 'buy record GET form', buyEnv?.record)
    rpcState.filled = true
    const filled = await json(`/api/agent/prepare-buy?listingId=lst1&account=${BUYER}&format=json`)
    ok(filled.status === 409 && /filled or cancelled on-chain/.test(String(filled.body?.error)), 'an order Seaport reports filled → 409, though the stored row still says active', filled.body)
    rpcState.filled = false
    rpcState.cancelled = true
    const cancelled = await json(`/api/agent/prepare-buy?listingId=lst1&account=${BUYER}&format=json`)
    ok(cancelled.status === 409, 'an order Seaport reports cancelled → 409')
    rpcState.cancelled = false
    rpcState.counter = 5n
    const invalidated = await json(`/api/agent/prepare-buy?listingId=lst1&account=${BUYER}&format=json`)
    ok(invalidated.status === 409 && /invalidated/.test(String(invalidated.body?.error)), 'a seller counter past the signed one (incrementCounter) → 409, though getOrderStatus reads untouched', invalidated.body)
    rpcState.counter = 0n

    // ── 4. scout config lifecycle (session-bound) ──
    console.log('\nscout — GET / PUT / DELETE with the revoke queue')
    const token = 'deadbeef'.repeat(8)
    upstash.store.set(`kismetart:session:${token}`, { v: USER.toLowerCase() })
    const cookie = `__Host-kismet_session=${token}`
    const unauth = await json('/api/agent/scout')
    ok(unauth.status === 401, 'no session → 401')
    const now = Math.floor(Date.now() / 1000)
    const permission = {
      signature: '0x01',
      chainId: 8453,
      permission: {
        account: USER,
        spender: SPENDER,
        token: NATIVE_ETH,
        allowance: '1000000000000000000',
        period: 604_800,
        start: now,
        end: now + 365 * 86_400,
        salt: '0',
        extraData: '0x',
      },
    }
    const draft = {
      mode: 'auto',
      status: 'active',
      budget: { currency: 'eth', allowance: '1000000000000000000', periodSeconds: 604_800, start: now, end: now + 365 * 86_400 },
      policy: {
        collections: [],
        creators: [ARTIST.toLowerCase()],
        blockedCollections: [],
        blockedCreators: [],
        maxItemPrice: '1000000000000000',
        maxItemsPerPeriod: 5,
        maxEditionsPerDrop: 1,
        mediaTypes: [],
      },
    }
    const put = await json('/api/agent/scout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ scout: draft, permission, away: true, artistLabels: { [ARTIST.toLowerCase()]: 'dee' } }),
    })
    ok(put.status === 200 && (put.body?.scout as { status?: string })?.status === 'active' && put.body?.away === true, 'PUT stores the agent', put.text.slice(0, 300))
    ok(upstash.store.has(`kismetart:scout:${USER.toLowerCase()}`), 'record persisted under the session owner')
    const get1 = await json('/api/agent/scout', { headers: { cookie } })
    ok(get1.status === 200 && (get1.body?.scout as { status?: string })?.status === 'active' && get1.body?.lastRun === null, 'GET returns the agent; no run history yet')
    const lastRunKey = `kismetart:scout-lastrun:${USER.toLowerCase()}`
    upstash.store.set(lastRunKey, { v: JSON.stringify({ at: now, collected: 1, skipped: 2, skips: { 'over-item-price': 2 } }) })
    const paused = await json('/api/agent/scout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ scout: { ...draft, status: 'paused' }, away: true, artistLabels: {} }),
    })
    const get2 = await json('/api/agent/scout', { headers: { cookie } })
    ok(paused.status === 200 && (get2.body?.scout as { status?: string })?.status === 'paused', 'a pause PUT is honored')
    ok((get2.body?.lastRun as { collected?: number })?.collected === 1, 'run history survives a config PUT (it lives on its own key)')
    ok((get2.body?.permission as { permission?: { end?: number } })?.permission?.end === now + 365 * 86_400, 'the stored grant keeps its finite end')

    const del = await json('/api/agent/scout', { method: 'DELETE', headers: { cookie } })
    ok(del.status === 200 && del.body?.ok === true && del.body?.revoked === false, 'DELETE with no spender configured answers ok + revoked:false', del.body)
    ok(!upstash.store.has(`kismetart:scout:${USER.toLowerCase()}`) && !upstash.store.has(lastRunKey), 'record and run history deleted')
    const queued = upstash.hashes.get(`kismetart:scout-pending-revoke:${USER.toLowerCase()}`)
    ok(queued?.size === 1 && upstash.sets.get('kismetart:scout-pending-revoke:owners')?.has(USER.toLowerCase()) === true, 'the un-revoked grant is queued for retry, owner indexed')
    const get3 = await json('/api/agent/scout', { headers: { cookie } })
    ok(get3.status === 200 && get3.body?.scout === null && get3.body?.lastRun === null, 'after turn-off GET is empty')

    const reput = await json('/api/agent/scout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ scout: draft, permission, away: true, artistLabels: {} }),
    })
    ok(reput.status === 200 && queued?.size === 0 && (upstash.sets.get('kismetart:scout-pending-revoke:owners')?.size ?? 0) === 0, 're-adopting the same grant dequeues it (a later drain cannot kill the new agent)')

    // ── 5. record-by-GET delegates to the on-chain-verified record handler ──
    console.log('\nrecord — GET form delegates to /api/collect and PATCH /api/listings')
    const noHash = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}`)
    ok(noHash.status === 400 && /txHash/.test(String(noHash.body?.error)), 'missing txHash → 400')
    const badVerb = await json(`/api/agent/record?verb=nope&txHash=${RECORD_TX}`)
    ok(badVerb.status === 400, 'unknown verb → 400')
    upstash.zadds.length = 0
    const rec = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=1&currency=eth&pricePerToken=${PRICE}&txHash=${RECORD_TX}`)
    ok(rec.status === 200 && rec.body?.ok === true, 'a collect whose receipt shows the TransferSingle is recorded (200 ok)', rec.text.slice(0, 200))
    ok(rec.headers.get('cache-control') === 'private, no-store', 'record response is private, no-store')
    await new Promise((r) => setTimeout(r, 300)) // let after() work land
    const artistNotice = upstash.zadds.find((z) => z.key === `kismetart:notif:${ARTIST.toLowerCase()}` && z.member.includes('"collect"'))
    ok(!!artistNotice && artistNotice.member.includes(USER.toLowerCase()), "the artist gets the 'collect' notification naming the collector", artistNotice?.member.slice(0, 160))
    const again = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=1&currency=eth&pricePerToken=${PRICE}&txHash=${RECORD_TX}`)
    ok(again.status === 200 && again.body?.ok === true, 'recording the same tx again is idempotent (200)', again.text.slice(0, 120))
    // A case variant of the same hash is the same tx: it must not re-run the
    // side effects (a second artist notice, another trending bump).
    const upper = `0x${RECORD_TX.slice(2).toUpperCase()}`
    const variant = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=1&currency=eth&pricePerToken=${PRICE}&txHash=${upper}`)
    await new Promise((r) => setTimeout(r, 300))
    const artistNotices = upstash.zadds.filter((z) => z.key === `kismetart:notif:${ARTIST.toLowerCase()}` && z.member.includes('"collect"'))
    ok(variant.status === 200 && artistNotices.length === 1, 'an upper-case variant of the same tx is recorded once, not twice (canonical txHash)', { status: variant.status, notices: artistNotices.length })
    const wrongTx = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&txHash=0x${'99'.repeat(32)}`)
    ok(wrongTx.status === 403 && /not verified/.test(String(wrongTx.body?.error)), 'a tx with no matching receipt is refused by the verified handler (403)', wrongTx.body)
    ok(
      noHash.headers.get('cache-control') === 'private, no-store' && (noHash.headers.get('x-robots-tag') ?? '').includes('noindex'),
      'validation errors are also no-store + noindex (the non-canonical-host rule in next.config merges its own value in here)',
      { cc: noHash.headers.get('cache-control'), robots: noHash.headers.get('x-robots-tag') },
    )
    const head = await fetch(`${base}/api/agent/record?verb=collect&txHash=${RECORD_TX}`, { method: 'HEAD' })
    ok(head.status === 405, 'HEAD (link previews) is refused, never runs a record', head.status)
    const buyRec = await json(`/api/agent/record?verb=buy&listingId=nope&txHash=${RECORD_TX}`)
    ok(buyRec.status === 404, 'buy record for an unknown listing → 404 from the listing handler', buyRec.body)

    console.log(`\n${failed === 0 ? 'OK' : 'FAILED'} — agent routes end-to-end: ${passed} passed, ${failed} failed`)
    stop()
    process.exit(failed === 0 ? 0 : 1)
  } catch (e) {
    console.error('harness error:', e)
    stop()
    process.exit(1)
  }
}

main()
