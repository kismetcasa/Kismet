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
import { existsSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createMockUpstash } from './_mock-upstash.ts'
import { SEAPORT_ABI, buildSellOrder, listingOrderHash, serializeOrder } from '@/lib/seaport'
import { PLATFORM_FEE_RECIPIENT } from '@/lib/platformFee'
import { shortAddress } from '@/lib/inprocess'
import { USDC_BASE, ZORA_ERC20_MINTER, ZORA_FIXED_PRICE_STRATEGY } from '@/lib/zoraMint'

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
const RECORD_TX2 = `0x${'7b'.repeat(32)}` as Hex
/** A Seaport fill of listing lst1 by BUYER. */
const FILL_TX = `0x${'7c'.repeat(32)}` as Hex
/** A reverted transaction. */
const REVERTED_TX = `0x${'7d'.repeat(32)}` as Hex
/** A mint whose TransferSingle goes to OTHER, not USER. */
const OTHERS_TX = `0x${'7e'.repeat(32)}` as Hex
const OTHER = getAddress(`0x${'ac'.repeat(20)}`)
const PRICE = 1_000_000_000_000_000n // 0.001 ETH
const USDC_PRICE = 5_000_000n // $5
const MINT_FEE = 111_000_000_000_000n
const LISTING_PRICE = 50_000_000_000_000_000n // 0.05 ETH
const USDC_LISTING_PRICE = 12_000_000n // $12

// Token ids with a fixed sale shape, so every eligibility branch is reachable:
//   42 active ETH sale, open edition (the happy path)
//   43 ETH sale that ended
//   44 ETH sale with a per-wallet cap of 1 that USER already hit
//   45 ETH sale, sold out (maxSupply reached)
//   46 no ETH sale; an active USDC sale on the ERC20 minter
//   7  no sale; USER holds one (list happy path)   8 no sale, USER holds none
//   9  no sale; USER holds one and the royalty equals the price (fees exceed)
const TOKEN_ENDED = 43n
const TOKEN_CAPPED = 44n
const TOKEN_SOLD_OUT = 45n
const TOKEN_USDC = 46n
const TOKEN_HELD = 7n
const TOKEN_ROYALTY_ALL = 9n

// ───────────────────────── mock Base + mainnet JSON-RPC ─────────────────────────

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const SEAPORT = '0x00000000000000adc04c56bf30ac9d3c0aaf14dc'
const MULTICALL3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
])
const FPSS_SALE_ABI = parseAbi([
  'function sale(address tokenContract, uint256 tokenId) view returns ((uint64 saleStart, uint64 saleEnd, uint64 maxTokensPerAddress, uint96 pricePerToken, address fundsRecipient))',
])
const ERC20_SALE_ABI = parseAbi([
  'function sale(address tokenContract, uint256 tokenId) view returns ((uint64 saleStart, uint64 saleEnd, uint64 maxTokensPerAddress, uint256 pricePerToken, address fundsRecipient, address currency))',
])
const TOKEN_INFO_ABI = parseAbi(['function getTokenInfo(uint256 tokenId) view returns ((string uri, uint256 maxSupply, uint256 totalMinted))'])
const BALANCE_ABI = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)'])
const ALLOWANCE_ABI = parseAbi(['function allowance(address owner, address spender) view returns (uint256)'])
const APPROVED_ALL_ABI = parseAbi(['function isApprovedForAll(address account, address operator) view returns (bool)'])
const ROYALTY_ABI = parseAbi(['function royaltyInfo(uint256 tokenId, uint256 salePrice) view returns (address, uint256)'])
const MINT_FEE_ABI = parseAbi(['function mintFee() view returns (uint256)'])
const TRANSFER_SINGLE = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
])
// Same signature lib/seaport.ts decodes fulfillments with (Seaport 1.5).
const ORDER_FULFILLED = parseAbi([
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
])

const rpcState = {
  filled: false,
  cancelled: false,
  counter: 0n,
  /** eth_call answers a JSON-RPC error (chain read failure). */
  failing: false,
  /** The universal signature validator's answer (a deployless eth_call, no `to`). */
  sigValid: true,
  /** How many receipt reads still answer null before the receipt "indexes". */
  pendingReceipts: 0,
  lastOrderHash: '',
  lastCounterOfferer: '',
  /** USDC allowance USER/BUYER have granted (to the ERC20 minter / Seaport). */
  usdcAllowance: 0n,
}
/** Receipts by hash, registered as the tests need them. */
const receipts = new Map<string, unknown>()
const CHAIN_NOW = 1_800_000_000

function handleEthCall(to: string, data: Hex): Hex {
  const target = to.toLowerCase()
  if (target === MULTICALL3) {
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
    const results = args[0].map((c) => ({ success: true, returnData: handleEthCall(c.target, c.callData) }))
    return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: results })
  }
  if (target === SEAPORT) {
    const { functionName, args } = decodeFunctionData({ abi: SEAPORT_ABI, data })
    if (functionName === 'getCounter') {
      rpcState.lastCounterOfferer = String(args[0]).toLowerCase()
      return encodeFunctionResult({ abi: SEAPORT_ABI, functionName, result: rpcState.counter })
    }
    if (functionName === 'getOrderStatus') rpcState.lastOrderHash = String(args[0]).toLowerCase()
    return encodeFunctionResult({
      abi: SEAPORT_ABI,
      functionName: 'getOrderStatus',
      result: [true, rpcState.cancelled, rpcState.filled ? 1n : 0n, 1n],
    })
  }
  const future = BigInt(CHAIN_NOW) + 10_000_000n
  const noSale = { saleStart: 0n, saleEnd: 0n, maxTokensPerAddress: 0n, pricePerToken: 0n, fundsRecipient: `0x${'00'.repeat(20)}` as `0x${string}` }
  if (target === ZORA_FIXED_PRICE_STRATEGY.toLowerCase()) {
    const { args } = decodeFunctionData({ abi: FPSS_SALE_ABI, data })
    const id = args[1]
    const sale =
      id === TOKEN_ENDED
        ? { saleStart: 0n, saleEnd: BigInt(CHAIN_NOW) - 1n, maxTokensPerAddress: 0n, pricePerToken: PRICE, fundsRecipient: ARTIST }
        : id === TOKEN_CAPPED
          ? { saleStart: 0n, saleEnd: future, maxTokensPerAddress: 1n, pricePerToken: PRICE, fundsRecipient: ARTIST }
          : id === TOKEN_USDC || id === TOKEN_HELD || id === TOKEN_HELD + 1n || id === TOKEN_ROYALTY_ALL
            ? noSale
            : { saleStart: 0n, saleEnd: future, maxTokensPerAddress: 0n, pricePerToken: PRICE, fundsRecipient: ARTIST }
    return encodeFunctionResult({ abi: FPSS_SALE_ABI, functionName: 'sale', result: sale })
  }
  if (target === ZORA_ERC20_MINTER.toLowerCase()) {
    const { args } = decodeFunctionData({ abi: ERC20_SALE_ABI, data })
    const sale =
      args[1] === TOKEN_USDC
        ? { saleStart: 0n, saleEnd: future, maxTokensPerAddress: 0n, pricePerToken: USDC_PRICE, fundsRecipient: ARTIST, currency: USDC_BASE }
        : { ...noSale, currency: USDC_BASE }
    return encodeFunctionResult({ abi: ERC20_SALE_ABI, functionName: 'sale', result: sale })
  }
  if (target === USDC_BASE.toLowerCase()) {
    decodeFunctionData({ abi: ALLOWANCE_ABI, data })
    return encodeFunctionResult({ abi: ALLOWANCE_ABI, functionName: 'allowance', result: rpcState.usdcAllowance })
  }
  try {
    const { args } = decodeFunctionData({ abi: TOKEN_INFO_ABI, data })
    const soldOut = args[0] === TOKEN_SOLD_OUT
    return encodeFunctionResult({ abi: TOKEN_INFO_ABI, functionName: 'getTokenInfo', result: { uri: '', maxSupply: soldOut ? 5n : 0n, totalMinted: soldOut ? 5n : 3n } })
  } catch {}
  try {
    const { args } = decodeFunctionData({ abi: BALANCE_ABI, data })
    const [account, id] = args
    const held = account.toLowerCase() === USER.toLowerCase() && (id === TOKEN_CAPPED || id === TOKEN_HELD || id === TOKEN_ROYALTY_ALL)
    return encodeFunctionResult({ abi: BALANCE_ABI, functionName: 'balanceOf', result: held ? 1n : 0n })
  } catch {}
  try {
    decodeFunctionData({ abi: APPROVED_ALL_ABI, data })
    return encodeFunctionResult({ abi: APPROVED_ALL_ABI, functionName: 'isApprovedForAll', result: false })
  } catch {}
  try {
    const { args } = decodeFunctionData({ abi: ROYALTY_ABI, data })
    const [id, salePrice] = args
    return encodeFunctionResult({ abi: ROYALTY_ABI, functionName: 'royaltyInfo', result: [ARTIST, id === TOKEN_ROYALTY_ALL ? salePrice : salePrice / 20n] })
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

function receiptShell(hash: Hex, from: string, to: string, logs: unknown[], status: '0x1' | '0x0' = '0x1') {
  return {
    blockHash: MOCK_BLOCK.hash,
    blockNumber: '0x10',
    contractAddress: null,
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    from,
    gasUsed: '0x5208',
    logs,
    logsBloom: `0x${'00'.repeat(256)}`,
    status,
    to,
    transactionHash: hash,
    transactionIndex: '0x0',
    type: '0x2',
  }
}

/** A successful mint receipt: one TransferSingle of token 42 to `to`. */
function mockReceipt(hash: Hex, to = USER) {
  const topics = encodeEventTopics({
    abi: TRANSFER_SINGLE,
    eventName: 'TransferSingle',
    args: { operator: ARTIST, from: `0x${'00'.repeat(20)}`, to },
  })
  return receiptShell(hash, to, COLLECTION, [
    {
      address: COLLECTION,
      blockHash: MOCK_BLOCK.hash,
      blockNumber: '0x10',
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [42n, 1n]),
      logIndex: '0x0',
      removed: false,
      topics,
      transactionHash: hash,
      transactionIndex: '0x0',
    },
  ])
}

/** A Seaport OrderFulfilled receipt for a stored listing, filled by `recipient`. */
function fillReceipt(hash: Hex, listing: { seller: string; orderComponents: ReturnType<typeof serializeOrder> }, recipient: string) {
  const oc = listing.orderComponents
  const topics = encodeEventTopics({ abi: ORDER_FULFILLED, eventName: 'OrderFulfilled', args: { offerer: listing.seller as Hex, zone: oc.zone as Hex } })
  const inputs = ORDER_FULFILLED[0].inputs.filter((i) => !('indexed' in i && i.indexed))
  const data = encodeAbiParameters(inputs, [
    listingOrderHash(listing),
    recipient as Hex,
    oc.offer.map((o) => ({ itemType: Number(o.itemType), token: o.token as Hex, identifier: BigInt(o.identifierOrCriteria), amount: BigInt(o.startAmount) })),
    oc.consideration.map((c) => ({ itemType: Number(c.itemType), token: c.token as Hex, identifier: BigInt(c.identifierOrCriteria), amount: BigInt(c.startAmount), recipient: c.recipient as Hex })),
  ])
  return receiptShell(hash, recipient, SEAPORT, [
    { address: SEAPORT, blockHash: MOCK_BLOCK.hash, blockNumber: '0x10', data, logIndex: '0x0', removed: false, topics, transactionHash: hash, transactionIndex: '0x0' },
  ])
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
          // An outage fails every method, as a dead endpoint would.
          if (rpcState.failing) return { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'mock: chain read failure' } }
          if (rpc.method === 'eth_chainId') return { jsonrpc: '2.0', id: rpc.id, result: '0x2105' }
          if (rpc.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: rpc.id, result: '0x10' }
          if (rpc.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: rpc.id, result: MOCK_BLOCK }
          if (rpc.method === 'eth_getCode') {
            // Only USER is a deployed smart wallet; anyone else is an EOA.
            const addr = String((rpc.params as [string])[0]).toLowerCase()
            return { jsonrpc: '2.0', id: rpc.id, result: addr === USER.toLowerCase() ? '0x6080' : '0x' }
          }
          if (rpc.method === 'eth_getTransactionReceipt') {
            const hash = String((rpc.params as [string])[0]).toLowerCase()
            if (rpcState.pendingReceipts > 0) {
              rpcState.pendingReceipts--
              return { jsonrpc: '2.0', id: rpc.id, result: null }
            }
            return { jsonrpc: '2.0', id: rpc.id, result: receipts.get(hash) ?? null }
          }
          if (rpc.method === 'eth_call') {
            const call = (rpc.params as [{ to?: string; data: Hex }])[0]
            // No `to`: viem's deployless universal-signature-validator call
            // (verifyTypedData / verifyHash) — answer the boolean it expects.
            if (!call.to) return { jsonrpc: '2.0', id: rpc.id, result: `0x${'00'.repeat(31)}${rpcState.sigValid ? '01' : '00'}` }
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
  const upstash = createMockUpstash({ modelSets: (k) => k.startsWith('kismetart:scout-pending-revoke') || k === 'kismetart:hidden-listings' })
  receipts.set(RECORD_TX, mockReceipt(RECORD_TX))
  receipts.set(RECORD_TX2, mockReceipt(RECORD_TX2))
  receipts.set(OTHERS_TX, mockReceipt(OTHERS_TX, OTHER))
  receipts.set(REVERTED_TX, receiptShell(REVERTED_TX, USER, COLLECTION, [], '0x0'))
  // Cached Farcaster misses, so the gate's sibling expansion never leaves the sandbox.
  for (const a of [USER, OTHER, BUYER, SELLER]) upstash.store.set(`kismetart:fc:fid-by-addr:${a.toLowerCase()}`, { v: '' })
  // The hidden-listings set is memoized in-process for 15 minutes on first
  // read, so the hide must exist before the server's first listing read.
  upstash.sets.set('kismetart:hidden-listings', new Set([`${COLLECTION.toLowerCase()}:11:${SELLER.toLowerCase()}`]))
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
      // One retry: a keep-alive socket the server closed during a long idle
      // (a browser step) surfaces as EPIPE on the next request.
      const r = await fetch(`${base}${path}`, init).catch(() => fetch(`${base}${path}`, init))
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

    // ── 1b. discover: parameter handling ──
    console.log('\ndiscover — parameters')
    const noCollection = await json('/api/agent/discover?kind=collect')
    ok(noCollection.status === 400 && /collection/.test(String(noCollection.body?.error)), 'kind=collect without a collection → 400')
    const badDiscoverAccount = await json('/api/agent/discover?kind=listings&account=nope')
    ok(badDiscoverAccount.status === 400, 'a malformed account → 400')
    const listingsFeed = await json('/api/agent/discover?kind=listings&limit=999&maxPrice=1')
    ok(listingsFeed.status === 200 && listingsFeed.body?.kind === 'listings' && Array.isArray(listingsFeed.body?.rows), 'listings: an oversized limit is clamped and maxPrice without currency is ignored (200)', listingsFeed.body)
    const unknownKind = await json('/api/agent/discover?kind=whatever')
    ok(unknownKind.status === 200 && unknownKind.body?.kind === 'listings', 'an unknown kind falls back to listings')

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

    // ── 2b. prepare-collect: every input edge, every eligibility branch, USDC ──
    console.log('\nprepare-collect — validation, amounts, eligibility, USDC')
    const pc = (q: string) => json(`/api/agent/prepare-collect?${q}&format=json`)
    const short = (s: string) => s.replace(USER, 'USER').replace(OTHER, 'OTHER').replace(COLLECTION, 'COLLECTION')
    const collectCases: Array<[string, number, RegExp]> = [
      [`collection=0x123&tokenId=42&account=${USER}`, 400, /./],
      [`collection=${COLLECTION}&tokenId=abc&account=${USER}`, 400, /./],
      [`collection=${COLLECTION}&tokenId=42`, 400, /account/i],
      [`collection=${COLLECTION}&tokenId=42&account=0xnot`, 400, /account/i],
      [`tokenId=42&account=${USER}`, 400, /./],
    ]
    for (const [q, status, re] of collectCases) {
      const r = await pc(q)
      ok(r.status === status && re.test(String(r.body?.error)), `collect ${short(q)} → ${status}`, r.body)
    }
    const byUrl = await pc(`url=${encodeURIComponent(`https://kismet.art/artwork/${COLLECTION}/42`)}&account=${USER}`)
    ok(byUrl.status === 200 && (byUrl.body?.calls as unknown[])?.length === 1, 'the url form resolves the same artwork')
    const posted = await json('/api/agent/prepare-collect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collection: COLLECTION, tokenId: '42', account: USER, amount: 2 }) })
    ok(posted.status === 200 && posted.body?.summary === env?.summary, 'POST with the same params yields the same envelope as GET')
    for (const [amount, qty] of [['0', 1n], ['51', 50n], ['2.7', 2n], ['abc', 1n], ['-3', 1n], ['1e1', 10n]] as const) {
      const r = await pc(`collection=${COLLECTION}&tokenId=42&account=${USER}&amount=${amount}`)
      const value = BigInt((r.body?.calls as { value: string }[])?.[0]?.value ?? '0x0')
      ok(r.status === 200 && value === (PRICE + MINT_FEE) * qty, `amount=${amount} → ${qty} edition(s)`, { status: r.status, value: value.toString() })
    }
    const commented = await pc(`collection=${COLLECTION}&tokenId=42&account=${USER}&comment=${'c'.repeat(1200)}`)
    ok(commented.status === 200 && String((commented.body?.record as { bodyTemplate?: { comment?: string } })?.bodyTemplate?.comment).length === 1000, 'an over-long comment is truncated to 1000, not rejected')
    const iframe = await json(collectPath, { headers: { 'sec-fetch-dest': 'iframe' } })
    ok(iframe.status === 200 && (iframe.headers.get('content-type') ?? '').includes('application/json'), 'an <iframe> navigation gets JSON, never the page (it cannot be framed)')
    const ended = await pc(`collection=${COLLECTION}&tokenId=${TOKEN_ENDED}&account=${USER}`)
    ok(ended.status === 409, 'a sale that ended → 409', ended.body)
    const capped = await pc(`collection=${COLLECTION}&tokenId=${TOKEN_CAPPED}&account=${USER}`)
    ok(capped.status === 409, 'a per-wallet cap USER already hit → 409', capped.body)
    const cappedOther = await pc(`collection=${COLLECTION}&tokenId=${TOKEN_CAPPED}&account=${OTHER}`)
    ok(cappedOther.status === 200, 'the same token for a wallet under the cap → 200 (eligibility is per account)', cappedOther.body)
    const soldOut = await pc(`collection=${COLLECTION}&tokenId=${TOKEN_SOLD_OUT}&account=${USER}`)
    ok(soldOut.status === 409, 'a sold-out edition → 409', soldOut.body)
    rpcState.usdcAllowance = 0n
    const usdc = await pc(`collection=${COLLECTION}&tokenId=${TOKEN_USDC}&account=${USER}&amount=2`)
    const usdcEnv = usdc.body as { calls?: { to: string; data: string; value: string }[]; link?: unknown; caps?: { maxValueUsdc?: string; maxValueEth?: string }; summary?: string } | null
    ok(
      usdc.status === 200 && usdcEnv?.calls?.length === 2 && usdcEnv.calls[0].to.toLowerCase() === USDC_BASE.toLowerCase() && usdcEnv.calls[0].data.startsWith('0x095ea7b3'),
      'a USDC sale with no allowance → [approve, mint]',
      usdcEnv?.calls?.map((c) => c.to) ?? usdc.body,
    )
    ok(usdcEnv?.caps?.maxValueUsdc === (USDC_PRICE * 2n).toString() && usdcEnv?.caps?.maxValueEth === undefined && usdcEnv?.calls?.every((c) => c.value === '0x0') === true, 'USDC cap = price × 2, no ETH cap, no native value', usdcEnv?.caps)
    ok(usdcEnv?.link === undefined && /one-time USDC approval/.test(usdcEnv?.summary ?? ''), 'the Base app link is withheld for an approve-prepended batch and the summary states the approval', usdcEnv?.summary)
    rpcState.usdcAllowance = USDC_PRICE * 10n
    const usdcCovered = await pc(`collection=${COLLECTION}&tokenId=${TOKEN_USDC}&account=${USER}`)
    const coveredEnv = usdcCovered.body as { calls?: unknown[]; link?: { url?: string } } | null
    ok(usdcCovered.status === 200 && coveredEnv?.calls?.length === 1 && typeof coveredEnv?.link?.url === 'string', 'with the allowance already granted → [mint] only, and the Base app link is back', coveredEnv)
    rpcState.usdcAllowance = 0n
    rpcState.failing = true
    const collectDown = await pc(`collection=${COLLECTION}&tokenId=42&account=${USER}`)
    ok(collectDown.status === 502 && !collectDown.body?.calls, 'a chain read failure → 502, no calls', collectDown.body)
    rpcState.failing = false

    // ── 2c. prepare-collect-batch ──
    console.log('\nprepare-collect-batch — basket edges')
    const batch = (body: unknown) => json('/api/agent/prepare-collect-batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const empty = await batch({ items: [], account: USER })
    ok(empty.status === 400, 'an empty basket → 400')
    const tooMany = await batch({ items: Array.from({ length: 21 }, (_, i) => ({ collection: COLLECTION, tokenId: String(i + 1) })), account: USER })
    ok(tooMany.status === 400 && /max 20/.test(String(tooMany.body?.error)), '21 items → 400 (max 20)')
    const badItem = await batch({ items: [{ collection: COLLECTION, tokenId: '42' }, { url: 'https://kismet.art/nope' }], account: USER })
    ok(badItem.status === 400 && /Invalid item/.test(String(badItem.body?.error)), 'one malformed ref rejects the whole basket (nothing silently dropped)')
    const badRecipient = await batch({ items: [{ collection: COLLECTION, tokenId: '42' }], account: USER, recipient: '0xnope' })
    ok(badRecipient.status === 400 && /recipient/.test(String(badRecipient.body?.error)), 'a malformed recipient → 400 (never coerced to the sender)')
    const allGone = await batch({ items: [{ collection: COLLECTION, tokenId: String(TOKEN_ENDED) }, { collection: COLLECTION, tokenId: String(TOKEN_SOLD_OUT) }], account: USER })
    ok(allGone.status === 409, 'a basket with nothing collectable → 409')
    const mixed = await batch({
      items: [{ collection: COLLECTION, tokenId: '42' }, { url: `https://kismet.art/artwork/${COLLECTION}/42` }, { collection: COLLECTION, tokenId: String(TOKEN_ENDED) }, { collection: COLLECTION, tokenId: String(TOKEN_USDC) }],
      account: USER,
      recipient: OTHER,
      comment: 'set',
    })
    const mixedEnv = mixed.body as {
      calls?: { to: string; value: string }[]
      records?: { bodyTemplate: { account: string; comment: string } }[]
      skipped?: { tokenId: string; reason: string }[]
      link?: unknown
      caps?: { maxValueEth?: string; maxValueUsdc?: string }
      summary?: string
    } | null
    ok(mixed.status === 200 && mixedEnv?.records?.length === 2 && mixedEnv.skipped?.length === 1 && mixedEnv.skipped[0].tokenId === String(TOKEN_ENDED), 'duplicates collapse, the unavailable item is reported in skipped, two records remain', { status: mixed.status, records: mixedEnv?.records?.length, skipped: mixedEnv?.skipped })
    ok(mixedEnv?.caps?.maxValueEth === (PRICE + MINT_FEE).toString() && mixedEnv?.caps?.maxValueUsdc === USDC_PRICE.toString(), 'a mixed basket carries BOTH ceilings', mixedEnv?.caps)
    ok(
      mixedEnv?.records?.every((r) => r.bodyTemplate.account.toLowerCase() === OTHER.toLowerCase() && r.bodyTemplate.comment === 'set') === true && (mixedEnv?.summary ?? '').includes(shortAddress(OTHER)),
      'records and the summary name the recipient, not the payer',
      mixedEnv?.summary,
    )
    ok(mixedEnv?.link === undefined && /one-time USDC approval/.test(mixedEnv?.summary ?? ''), 'the summed USDC approve is stated and the link withheld')

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
    ok(
      rpcState.lastOrderHash === listingOrderHash(listing).toLowerCase() && rpcState.lastCounterOfferer === SELLER.toLowerCase(),
      "the guard asks Seaport about THIS listing's order hash and THIS seller's counter",
      { hash: rpcState.lastOrderHash, offerer: rpcState.lastCounterOfferer },
    )
    rpcState.failing = true
    const down = await json(`/api/agent/prepare-buy?listingId=lst1&account=${BUYER}&format=json`)
    ok(down.status === 502 && !down.body?.calls, 'a chain read failure fails CLOSED: 502 and no calls handed out', down.body)
    rpcState.failing = false
    for (const [q, status] of [
      [`account=${BUYER}`, 400],
      [`listingId=lst1&account=0xnope`, 400],
      [`listingId=nope&account=${BUYER}`, 404],
      [`listingId=lst1&account=${SELLER}`, 400],
    ] as const) {
      const r = await json(`/api/agent/prepare-buy?${q}&format=json`)
      ok(r.status === status, `buy ${q.replace(BUYER, 'BUYER').replace(SELLER, 'SELLER')} → ${status}`, r.body)
    }
    upstash.store.set('kismetart:listing:lst-exp', { v: JSON.stringify({ ...listing, id: 'lst-exp', expiresAt: Date.now() - 1000 }) })
    const expired = await json(`/api/agent/prepare-buy?listingId=lst-exp&account=${BUYER}&format=json`)
    ok(expired.status === 409, 'an expired listing → 409')
    upstash.store.set('kismetart:listing:lst-filled', { v: JSON.stringify({ ...listing, id: 'lst-filled', status: 'filled' }) })
    const alreadyFilled = await json(`/api/agent/prepare-buy?listingId=lst-filled&account=${BUYER}&format=json`)
    ok(alreadyFilled.status === 409, 'a listing stored as filled → 409')
    const hiddenOrder = buildSellOrder({
      offerer: SELLER,
      collectionAddress: COLLECTION,
      tokenId: '11',
      sellerProceeds: LISTING_PRICE - 2_000_000_000_000_000n - 500_000_000_000_000n,
      royaltyReceiver: ARTIST,
      royaltyAmount: 2_000_000_000_000_000n,
      platformFee: 500_000_000_000_000n,
      platformFeeRecipient: PLATFORM_FEE_RECIPIENT,
      counter: 0n,
      currency: 'eth',
    })
    upstash.store.set('kismetart:listing:lst-hid', { v: JSON.stringify({ ...listing, id: 'lst-hid', tokenId: '11', orderComponents: serializeOrder(hiddenOrder) }) })
    const hidden = await json(`/api/agent/prepare-buy?listingId=lst-hid&account=${BUYER}&format=json`)
    ok(hidden.status === 404, 'an admin-hidden listing is indistinguishable from a missing one (404)', hidden.body)
    const buyPosted = await json('/api/agent/prepare-buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listingId: 'lst1', account: BUYER }) })
    ok(buyPosted.status === 200 && buyPosted.body?.summary === buyEnv?.summary, 'POST yields the same buy envelope as GET')
    const buyPage = await json(`/api/agent/prepare-buy?listingId=lst1&account=${BUYER}`, { headers: { 'sec-fetch-dest': 'document' } })
    ok(
      buyPage.status === 200 && (buyPage.headers.get('content-type') ?? '').includes('text/html') && buyPage.text.includes('Buy “Nice ’art’”') && (buyPage.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"),
      'a navigation to the buy prepare gets the approve page with a closed CSP',
      buyPage.headers.get('content-security-policy'),
    )
    // A USDC listing: the approve is prepended only while the allowance is short.
    const usdcOrder = buildSellOrder({
      offerer: SELLER,
      collectionAddress: COLLECTION,
      tokenId: '8',
      sellerProceeds: USDC_LISTING_PRICE - 120_000n - 600_000n,
      royaltyReceiver: ARTIST,
      royaltyAmount: 600_000n,
      platformFee: 120_000n,
      platformFeeRecipient: PLATFORM_FEE_RECIPIENT,
      counter: 0n,
      currency: 'usdc',
    })
    upstash.store.set('kismetart:listing:lst2', {
      v: JSON.stringify({ ...listing, id: 'lst2', tokenId: '8', price: USDC_LISTING_PRICE.toString(), sellerProceeds: (USDC_LISTING_PRICE - 720_000n).toString(), royaltyAmount: '600000', currency: 'usdc', platformFee: '120000', orderComponents: serializeOrder(usdcOrder), name: 'Dollar piece' }),
    })
    rpcState.usdcAllowance = 0n
    const usdcBuy = await json(`/api/agent/prepare-buy?listingId=lst2&account=${BUYER}&format=json`)
    const usdcBuyEnv = usdcBuy.body as { calls?: { to: string; data: string; value: string }[]; link?: unknown; caps?: Record<string, string>; summary?: string } | null
    ok(
      usdcBuy.status === 200 && usdcBuyEnv?.calls?.length === 2 && usdcBuyEnv.calls[0].to.toLowerCase() === USDC_BASE.toLowerCase() && usdcBuyEnv.calls[1].to.toLowerCase() === SEAPORT && usdcBuyEnv.calls.every((c) => c.value === '0x0'),
      'USDC listing, allowance short → [approve, fulfillOrder], no native value',
      usdcBuyEnv?.calls?.map((c) => c.to) ?? usdcBuy.body,
    )
    ok(usdcBuyEnv?.caps?.maxValueUsdc === USDC_LISTING_PRICE.toString() && usdcBuyEnv?.link === undefined && /one-time USDC approval/.test(usdcBuyEnv?.summary ?? '') && /\$12/.test(usdcBuyEnv?.summary ?? ''), 'USDC cap, link withheld, summary states approval and price', usdcBuyEnv?.summary)
    rpcState.usdcAllowance = USDC_LISTING_PRICE
    const usdcBuyCovered = await json(`/api/agent/prepare-buy?listingId=lst2&account=${BUYER}&format=json`)
    const coveredBuy = usdcBuyCovered.body as { calls?: unknown[]; link?: { url?: string } } | null
    ok(usdcBuyCovered.status === 200 && coveredBuy?.calls?.length === 1 && typeof coveredBuy?.link?.url === 'string', 'allowance covers the price → [fulfillOrder] only, link present')
    rpcState.usdcAllowance = 0n

    // ── 3b. prepare-list ──
    console.log('\nprepare-list — holder, floor, fees')
    const pl = (q: string) => json(`/api/agent/prepare-list?${q}&format=json`)
    for (const [q, status, re] of [
      [`collection=${COLLECTION}&tokenId=${TOKEN_HELD}&account=${USER}&price=0.01&currency=btc`, 400, /currency/],
      [`collection=${COLLECTION}&tokenId=${TOKEN_HELD}&account=${USER}&price=0&currency=eth`, 400, /price/i],
      [`collection=${COLLECTION}&tokenId=${TOKEN_HELD}&account=${USER}&price=0.000000000000000001&currency=eth`, 400, /minimum/i],
      [`collection=${COLLECTION}&tokenId=${TOKEN_HELD + 1n}&account=${USER}&price=0.01&currency=eth`, 403, /hold/i],
      [`collection=${COLLECTION}&tokenId=${TOKEN_ROYALTY_ALL}&account=${USER}&price=0.01&currency=eth`, 409, /exceed/i],
    ] as const) {
      const r = await pl(q)
      ok(r.status === status && re.test(String(r.body?.error)), `list ${short(q).replace(/&account=USER/, '')} → ${status}`, r.body)
    }
    const listed = await pl(`collection=${COLLECTION}&tokenId=${TOKEN_HELD}&account=${USER}&price=0.01&currency=eth`)
    const listEnv = listed.body as {
      calls?: { to: string; data: string }[]
      typedData?: { primaryType?: string; message?: { offerer?: string } }
      summary?: string
      record?: { method: string; url: string }
      caps?: unknown
      link?: unknown
    } | null
    ok(listed.status === 200 && listEnv?.typedData?.primaryType === 'OrderComponents' && listEnv.typedData.message?.offerer?.toLowerCase() === USER.toLowerCase(), 'a held token → the Seaport order to sign, offerer = account', listed.body)
    ok(listEnv?.calls?.length === 1 && listEnv.calls[0].to.toLowerCase() === COLLECTION.toLowerCase() && listEnv.calls[0].data.startsWith('0xa22cb465'), 'first listing on the collection → one setApprovalForAll call first', listEnv?.calls)
    ok(/you receive 0\.0094 ETH after the 1% Kismet fee/.test(listEnv?.summary ?? '') && /royalty/.test(listEnv?.summary ?? ''), 'summary states proceeds after the fee and the on-chain royalty', listEnv?.summary)
    ok(listEnv?.record?.method === 'POST' && listEnv.record.url === '/api/listings' && listEnv.caps === undefined && listEnv.link === undefined, 'record posts the listing; no caps, no Base app link', listEnv?.record)

    // ── 3c. prepare-mint: validation order and gates (hosting media is where the sandbox ends) ──
    console.log('\nprepare-mint — validation order, gates')
    const pm = (body: unknown) => json('/api/agent/prepare-mint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    const mintGet = await fetch(`${base}/api/agent/prepare-mint?account=${USER}&name=x`)
    ok(mintGet.status === 405, 'GET on the spending prepare is refused (405)', mintGet.status)
    for (const [label, body, status, re] of [
      ['no account', { name: 'x', media: PNG }, 400, /account/],
      ['no name', { account: USER, media: PNG }, 400, /name/],
      ['text + media', { account: USER, name: 'x', media: PNG, mediaType: 'text' }, 400, /text/],
      ['neither text nor media', { account: USER, name: 'x' }, 400, /media/],
      ['malformed data URI', { account: USER, name: 'x', media: 'data:image/png,%E0%A4%A' }, 400, /Malformed/],
      ['unsupported type', { account: USER, name: 'x', media: 'data:text/plain;base64,aGk=' }, 400, /Unsupported|accepted/],
      ['bad price', { account: USER, name: 'x', media: PNG, price: '-1' }, 400, /price/],
      ['bad editions', { account: USER, name: 'x', media: PNG, editions: 0 }, 400, /editions/],
      ['bad collection', { account: USER, name: 'x', media: PNG, collection: '0x1' }, 400, /collection/],
      ['bad payout', { account: USER, name: 'x', media: PNG, payoutRecipient: 'nope' }, 400, /payoutRecipient/],
    ] as const) {
      const r = await pm(body)
      ok(r.status === status && re.test(String(r.body?.error)), `mint ${label} → ${status}`, r.body)
    }
    // The gate config is cached in-process for 15 s (lib/gate.ts), so each
    // flag flip is polled until the server sees it.
    const mintUntil = async (body: unknown, status: number, ms = 20_000) => {
      const deadline = Date.now() + ms
      // Polling would trip the 20/min mint limit; the limiter itself is
      // asserted elsewhere, so reset its counter between polls.
      const resetLimit = () => [...upstash.store.keys()].filter((k) => k.startsWith('kismetart:rl:agent-prepare-mint:')).forEach((k) => upstash.store.delete(k))
      resetLimit()
      let r = await pm(body)
      while (r.status !== status && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 1_000))
        resetLimit()
        r = await pm(body)
      }
      return r
    }
    upstash.store.set('kismetart:platform:paused', { v: '1' })
    const pausedMint = await mintUntil({ account: USER, name: 'x', media: PNG }, 503)
    ok(pausedMint.status === 503 && /paused/.test(String(pausedMint.body?.error)), 'platform paused → 503 before any spend', pausedMint.body)
    upstash.store.delete('kismetart:platform:paused')
    upstash.store.set('kismetart:gate:enabled', { v: '1' })
    upstash.store.set('kismetart:gate:pass-collection', { v: COLLECTION.toLowerCase() })
    const gated = await mintUntil({ account: OTHER, name: 'x', media: PNG }, 403)
    ok(gated.status === 403 && /required/.test(String(gated.body?.error)), 'Pass gate on, no Pass → 403 before any spend', gated.body)
    upstash.store.delete('kismetart:gate:enabled')
    upstash.store.delete('kismetart:gate:pass-collection')
    const hosting = await mintUntil({ account: USER, name: 'x', media: PNG }, 502)
    ok(
      hosting.status >= 500 && hosting.status < 600 && typeof hosting.body?.error === 'string' && !/node_modules|\/home\/|    at /.test(String(hosting.body?.error)),
      'past every gate the sandbox cannot host media: a generic 5xx, no internals leaked',
      { status: hosting.status, error: hosting.body?.error },
    )

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
    ok(
      reput.status === 200 && (upstash.hashes.get(`kismetart:scout-pending-revoke:${USER.toLowerCase()}`)?.size ?? 0) === 0 && (upstash.sets.get('kismetart:scout-pending-revoke:owners')?.size ?? 0) === 0,
      're-adopting the same grant dequeues it (a later drain cannot kill the new agent)',
    )

    // The item counter is the server's. Only a NEW grant the wallet actually
    // signed resets it — never a resent config, never a forged permission.
    const recKey = `kismetart:scout:${USER.toLowerCase()}`
    const stored = () => JSON.parse(upstash.store.get(recKey)!.v) as { usage: { itemsThisPeriod: number }; supersededPermissions?: unknown[] }
    upstash.store.set(recKey, { v: JSON.stringify({ ...stored(), usage: { ...JSON.parse(upstash.store.get(recKey)!.v).usage, itemsThisPeriod: 3 } }) })
    const putWith = (body: Record<string, unknown>) =>
      json('/api/agent/scout', { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
    const resent = await putWith({ scout: { ...draft, budget: { ...draft.budget, start: now + 500 } }, permission, away: true, artistLabels: {} })
    ok(resent.status === 200 && stored().usage.itemsThisPeriod === 3, 'resending the same grant with a later budget.start keeps the item counter', resent.body?.usage)
    const noGrant = await putWith({ scout: draft, away: true, artistLabels: {} })
    ok(noGrant.status === 200 && stored().usage.itemsThisPeriod === 3, 'a config PUT without a permission keeps the counter')
    const forgedPermission = { ...permission, permission: { ...permission.permission, start: now + 1 } }
    rpcState.sigValid = false
    const forged = await putWith({ scout: draft, permission: forgedPermission, away: true, artistLabels: {} })
    ok(forged.status === 400 && /signature/.test(String(forged.body?.error)), 'a permission whose signature does not verify for the owner is refused (400)', forged.body)
    ok(stored().usage.itemsThisPeriod === 3 && !stored().supersededPermissions, 'the forged grant reset nothing and queued nothing')
    rpcState.sigValid = true
    rpcState.failing = true
    const unverifiable = await putWith({ scout: draft, permission: forgedPermission, away: true, artistLabels: {} })
    // viem's verifyHash answers false (not a throw) when the validator call
    // fails, so this refuses as 400; a transport-level throw would be the 503.
    ok(
      (unverifiable.status === 400 || unverifiable.status === 503) && stored().usage.itemsThisPeriod === 3 && !stored().supersededPermissions,
      'a signature the RPC cannot check is refused either way — nothing stored, nothing reset',
      unverifiable.body,
    )
    rpcState.failing = false
    const regrant = await putWith({ scout: draft, permission: forgedPermission, away: true, artistLabels: {} })
    ok(regrant.status === 200 && stored().usage.itemsThisPeriod === 0 && stored().supersededPermissions?.length === 1, 'a new grant that verifies starts a fresh counter and stashes the old grant for a spender-side revoke')
    const token2 = 'cafebabe'.repeat(8)
    upstash.store.set(`kismetart:session:${token2}`, { v: OTHER.toLowerCase() })
    const eoa = await json('/api/agent/scout', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: `__Host-kismet_session=${token2}` },
      body: JSON.stringify({ scout: draft, away: true, artistLabels: {} }),
    })
    ok(eoa.status === 403, 'an owner without code (EOA) cannot store an agent (403)', eoa.body)

    // ── 4b. scout PUT: every validation branch, coercions, label filtering; the run route ──
    console.log('\nscout — validation matrix + run route')
    upstash.store.delete(`kismetart:rl:agent-scout:${USER.toLowerCase()}`) // this block alone would trip the 30/min PUT limit
    const invalidJson = await fetch(`${base}/api/agent/scout`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: '{not json' })
    ok(invalidJson.status === 400, 'invalid JSON → 400')
    const many = Array.from({ length: 51 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`))
    for (const [label, body, re] of [
      ['no scout', {}, /Missing scout/],
      ['no artists', { scout: { ...draft, policy: { ...draft.policy, creators: [] } } }, /artist/],
      ['only invalid artists', { scout: { ...draft, policy: { ...draft.policy, creators: ['nope', '0x12'] } } }, /artist/],
      ['51 artists', { scout: { ...draft, policy: { ...draft.policy, creators: many } } }, /At most 50/],
      ['bad currency', { scout: { ...draft, budget: { ...draft.budget, currency: 'btc' } } }, /currency/],
      ['zero allowance', { scout: { ...draft, budget: { ...draft.budget, allowance: '0' } } }, /allowance/],
      ['decimal allowance', { scout: { ...draft, budget: { ...draft.budget, allowance: '1.5' } } }, /allowance/],
      ['zero period', { scout: { ...draft, budget: { ...draft.budget, periodSeconds: 0 } } }, /period/],
      ['end before start', { scout: { ...draft, budget: { ...draft.budget, end: draft.budget.start - 1 } } }, /window/],
      ['zero max item price', { scout: { ...draft, policy: { ...draft.policy, maxItemPrice: '0' } } }, /max item price/],
      ['fractional items per period', { scout: { ...draft, policy: { ...draft.policy, maxItemsPerPeriod: 1.5 } } }, /items per period/],
      ['11 editions', { scout: { ...draft, policy: { ...draft.policy, maxEditionsPerDrop: 11 } } }, /editions/],
      ['zero editions', { scout: { ...draft, policy: { ...draft.policy, maxEditionsPerDrop: 0 } } }, /editions/],
      ['permission for another account', { scout: draft, permission: { ...permission, permission: { ...permission.permission, account: OTHER } } }, /account/],
      ['permission to another spender', { scout: draft, permission: { ...permission, permission: { ...permission.permission, spender: OTHER } } }, /spender/],
      ['permission token ≠ budget currency', { scout: { ...draft, budget: { ...draft.budget, currency: 'usdc' } }, permission }, /token/],
    ] as const) {
      const r = await putWith({ away: true, artistLabels: {}, ...body })
      ok(r.status === 400 && re.test(String(r.body?.error)), `PUT ${label} → 400`, r.body)
    }
    const coerced = await putWith({
      scout: { ...draft, name: `  ${'n'.repeat(80)}  `, mode: 'weird', status: 'weird', policy: { ...draft.policy, creators: [ARTIST.toLowerCase(), 'nope', OTHER.toLowerCase()] } },
      away: 'yes',
      artistLabels: { [ARTIST.toLowerCase()]: `  ${'l'.repeat(60)} `, [USER.toLowerCase()]: 'not watched', [OTHER.toLowerCase()]: 42 },
    })
    const cs = coerced.body?.scout as { name: string; mode: string; status: string; policy: { creators: string[] } } | undefined
    ok(coerced.status === 200 && cs?.name.length === 60 && cs.mode === 'auto' && cs.status === 'active' && cs.policy.creators.length === 2, 'name trimmed + capped at 60; unknown mode/status coerced; non-address artists dropped', cs)
    const labels = coerced.body?.artistLabels as Record<string, string> | null
    ok(!!labels && Object.keys(labels).length === 1 && labels[ARTIST.toLowerCase()]?.length === 40, 'labels: only watched artists, strings only, capped at 40', labels)
    ok(coerced.body?.away === true, 'a non-boolean away keeps the stored value')
    const propose = await putWith({ scout: { ...draft, mode: 'propose', status: 'paused' }, away: false, artistLabels: {} })
    const ps = propose.body?.scout as { mode: string; status: string } | undefined
    ok(propose.status === 200 && ps?.mode === 'propose' && ps.status === 'paused' && propose.body?.away === false, 'propose mode, paused status and away=false are stored as sent')
    const restored = await putWith({ scout: draft, away: true, artistLabels: {} })
    ok(restored.status === 200, 'restored the active config for the sections below')
    const runNoSession = await fetch(`${base}/api/agent/scout/run`, { method: 'POST' })
    ok(runNoSession.status === 401, 'run without a session → 401')
    const runNoSpender = await json('/api/agent/scout/run', { method: 'POST', headers: { cookie } })
    ok(runNoSpender.status === 503 && !/CDP_|SCOUT_SPENDER_PRIVATE_KEY/.test(String(runNoSpender.body?.error)), 'run with no spender configured → 503 with a generic message (no env names)', runNoSpender.body)
    upstash.store.set(`kismetart:scout-run:${USER.toLowerCase()}`, { v: '1' })
    const runLocked = await json('/api/agent/scout/run', { method: 'POST', headers: { cookie } })
    ok(runLocked.status === 200 && runLocked.body?.ran === false && /in progress/.test(String(runLocked.body?.reason)), 'a run already in progress → ran:false, no second run')
    upstash.store.delete(`kismetart:scout-run:${USER.toLowerCase()}`)
    const noRecordDelete = await json('/api/agent/scout', { method: 'DELETE', headers: { cookie: `__Host-kismet_session=${token2}` } })
    ok(noRecordDelete.status === 200 && noRecordDelete.body?.revoked === true && noRecordDelete.body?.queued === true, 'DELETE with no agent → ok, nothing to revoke')

    // ── 5. record-by-GET delegates to the on-chain-verified record handler ──
    console.log('\nrecord — GET form delegates to /api/collect and PATCH /api/listings')
    const noHash = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}`)
    ok(noHash.status === 400 && /txHash/.test(String(noHash.body?.error)), 'missing txHash → 400')
    const badVerb = await json(`/api/agent/record?verb=nope&txHash=${RECORD_TX}`)
    ok(badVerb.status === 400, 'unknown verb → 400')
    upstash.zadds.length = 0
    const noCurrency = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&pricePerToken=${PRICE}&txHash=${RECORD_TX}`)
    ok(noCurrency.status === 400 && /currency/.test(String(noCurrency.body?.error)), 'a price without its currency is refused (the handler would store it unverified)', noCurrency.body)
    const rec = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=1&currency=eth&pricePerToken=${PRICE}&txHash=${RECORD_TX}`)
    ok(rec.status === 200 && rec.body?.ok === true, 'a collect whose receipt shows the TransferSingle is recorded (200 ok)', rec.text.slice(0, 200))
    ok(rec.headers.get('cache-control') === 'private, no-store', 'record response is private, no-store')
    // after() work (receipt re-verification + the artist's notice) lands
    // asynchronously; poll for it rather than sleeping a fixed time.
    const artistNotices = () => upstash.zadds.filter((z) => z.key === `kismetart:notif:${ARTIST.toLowerCase()}` && z.member.includes('"collect"'))
    const until = async (cond: () => boolean, ms = 5_000) => {
      const deadline = Date.now() + ms
      while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      return cond()
    }
    await until(() => artistNotices().length >= 1)
    const artistNotice = artistNotices()[0]
    ok(!!artistNotice && artistNotice.member.includes(USER.toLowerCase()), "the artist gets the 'collect' notification naming the collector", artistNotice?.member.slice(0, 160))
    const again = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=1&currency=eth&pricePerToken=${PRICE}&txHash=${RECORD_TX}`)
    ok(again.status === 200 && again.body?.ok === true, 'recording the same tx again is idempotent (200)', again.text.slice(0, 120))
    // A case variant of the same hash is the same tx: it must not re-run the
    // side effects (a second artist notice, another trending bump).
    const upper = `0x${RECORD_TX.slice(2).toUpperCase()}`
    const variant = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=1&currency=eth&pricePerToken=${PRICE}&txHash=${upper}`)
    await until(() => artistNotices().length >= 2, 1_000) // must NOT happen; give it a moment to be sure
    ok(variant.status === 200 && artistNotices().length === 1, 'an upper-case variant of the same tx is recorded once, not twice (canonical txHash)', { status: variant.status, notices: artistNotices().length })
    rpcState.pendingReceipts = 2
    const lagged = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=1&currency=eth&pricePerToken=${PRICE}&txHash=${RECORD_TX2}`)
    ok(lagged.status === 200 && rpcState.pendingReceipts === 0, 'a receipt the RPC has not indexed yet is retried in-route until it lands (200)', { status: lagged.status, pending: rpcState.pendingReceipts })
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

    // ── 5b. record: every validation branch; receipts that must not record; the buy fill ──
    console.log('\nrecord — validation matrix, refusals, buy fill')
    for (const [q, re] of [
      [`verb=collect&txHash=${RECORD_TX}`, /collection/i],
      [`verb=collect&collection=${COLLECTION}&txHash=${RECORD_TX}`, /tokenId/i],
      [`verb=collect&collection=${COLLECTION}&tokenId=42&txHash=${RECORD_TX}`, /account/i],
      [`verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=0&txHash=${RECORD_TX}`, /amount/],
      [`verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=51&txHash=${RECORD_TX}`, /amount/],
      [`verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&amount=1.5&txHash=${RECORD_TX}`, /amount/],
      [`verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&currency=btc&txHash=${RECORD_TX}`, /currency/],
      [`verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&currency=eth&pricePerToken=1.5&txHash=${RECORD_TX}`, /pricePerToken/],
      [`verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&txHash=0x1234`, /txHash/],
      [`verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&txHash=${RECORD_TX.slice(0, -1)}g`, /txHash/],
      [`verb=buy&txHash=${RECORD_TX}`, /listingId/],
    ] as const) {
      const r = await json(`/api/agent/record?${q}`)
      ok(r.status === 400 && re.test(String(r.body?.error)), `record ${short(q).replace(RECORD_TX, 'TX')} → 400`, r.body)
    }
    const reverted = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&txHash=${REVERTED_TX}`)
    ok(reverted.status === 403, 'a reverted transaction is refused (403)', reverted.body)
    const othersMint = await json(`/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&txHash=${OTHERS_TX}`)
    ok(othersMint.status === 403, "someone else's mint cannot be recorded for USER (403)", othersMint.body)
    const postRecord = await fetch(`${base}/api/agent/record?verb=collect&txHash=${RECORD_TX}`, { method: 'POST' })
    ok(postRecord.status === 405, 'POST to the record GET is refused (405)')
    receipts.set(FILL_TX, fillReceipt(FILL_TX, listing, BUYER))
    const fill = await json(`/api/agent/record?verb=buy&listingId=lst1&txHash=${FILL_TX}`)
    ok(fill.status === 200, 'a Seaport fill of THIS order records the sale (200)', fill.text.slice(0, 200))
    const lst1 = JSON.parse(upstash.store.get('kismetart:listing:lst1')!.v) as { status: string }
    ok(lst1.status === 'filled', 'the listing is now filled in the store', lst1.status)
    const fillAgain = await json(`/api/agent/record?verb=buy&listingId=lst1&txHash=${FILL_TX}`)
    ok(fillAgain.status === 409 && /inactive/.test(String(fillAgain.body?.error)), 'recording the fill again → 409 already inactive (the documented "treat as done")', fillAgain.body)
    const buyAfterFill = await json(`/api/agent/prepare-buy?listingId=lst1&account=${BUYER}&format=json`)
    ok(buyAfterFill.status === 409, 'a buy prepare for the filled listing → 409')
    // Last, because it exhausts this IP's record budget: the one GET that
    // writes is rate-limited (30/min), so a link cannot be hammered.
    let limited = 0
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await fetch(`${base}/api/agent/record?verb=nope&txHash=${RECORD_TX}`)
      if (r.status === 429) limited = i + 1
    }
    ok(limited > 0 && limited <= 40, `the record GET rate-limits this client (429 after ${limited} more requests)`)

    // ── 6. A real browser: navigations as Chromium actually sends them ──
    const chrome = [
      process.env.CHROME_PATH,
      ...(existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`) : []),
    ].find((p) => p && existsSync(p))
    if (chrome) {
      console.log('\nbrowser — headless Chromium navigations')
      // --no-proxy-server: a proxied environment (HTTPS_PROXY) must not route
      // the loopback server through the proxy. Asynchronous on purpose: the
      // mock Redis and RPC servers live in THIS process, so a synchronous
      // spawn would starve every route the page needs. A browser failure
      // fails its cases, never the harness.
      const dom = (url: string): Promise<string> =>
        new Promise((resolve) => {
          execFile(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-proxy-server', '--dump-dom', url], { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err) console.error(`  browser failed for ${url}: ${err.message}`)
            resolve(err ? '' : stdout.toString())
          })
        })
      // A DOM dump re-serializes text nodes, so the server's `&quot;` escapes
      // come back as literal quotes inside the <pre> (the raw fetch above
      // checks the escaping itself).
      const pageDom = await dom(`${base}${collectPath}`)
      ok(pageDom.includes('Approve in the Base app') && /<pre>[^<]*"action": "collect"/.test(pageDom) && !/<script/i.test(pageDom), 'a real navigation renders the approve page (button, envelope in the details block, no script)')
      const jsonDom = await dom(`${base}${collectPath}&format=json`)
      ok(/"action":\s*"collect"/.test(jsonDom) && !/Approve in the Base app/.test(jsonDom), 'format=json renders the JSON envelope in the browser')
      const recordDom = await dom(`${base}/api/agent/record?verb=collect&collection=${COLLECTION}&tokenId=42&account=${USER}&txHash=0x${'98'.repeat(32)}`)
      ok(/not verified|Too many/.test(recordDom) && !/Approve in the Base app/.test(recordDom), 'a tapped record URL answers JSON (never a page), refusing an unproven tx')
      const agentDom = await dom(`${base}/agent`)
      ok(/agent-skill\/SKILL\.md/.test(agentDom) && /Base Account/.test(agentDom), 'the /agent page renders with the skill URL and the Base Account requirement')
      const skill = await json('/agent-skill/SKILL.md')
      ok(skill.status === 200 && /kismet-base-mcp/.test(skill.text), 'SKILL.md is served')
    } else {
      console.log('\nbrowser — skipped (no headless Chromium found; set CHROME_PATH)')
    }

    // ── 7. Rate limits, last: they exhaust this client's budgets ──
    console.log('\nrate limits')
    let collectLimited = 0
    for (let i = 0; i < 70 && !collectLimited; i++) {
      const r = await fetch(`${base}/api/agent/prepare-collect?collection=${COLLECTION}&tokenId=42&account=${USER}&format=json`)
      if (r.status === 429) collectLimited = i + 1
    }
    ok(collectLimited > 0, `prepare-collect rate-limits this client (429 after ${collectLimited} more)`)
    let runLimited = 0
    for (let i = 0; i < 12 && !runLimited; i++) {
      const r = await fetch(`${base}/api/agent/scout/run`, { method: 'POST', headers: { cookie } })
      if (r.status === 429) runLimited = i + 1
    }
    ok(runLimited > 0 && runLimited <= 12, `the run route rate-limits the owner (429 after ${runLimited} more)`)
    let deleteLimited = 0
    for (let i = 0; i < 12 && !deleteLimited; i++) {
      const r = await fetch(`${base}/api/agent/scout`, { method: 'DELETE', headers: { cookie } })
      if (r.status === 429) deleteLimited = i + 1
    }
    ok(deleteLimited > 0 && deleteLimited <= 12, `turn-off rate-limits the owner (429 after ${deleteLimited} more)`)

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
