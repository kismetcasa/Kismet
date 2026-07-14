/**
 * Agent Collect LIVE-BEHAVIOR harness — executes the REAL autonomous-spend
 * modules (serverExecutor, runScoutServer, dropCoordinator, killSwitch) against
 * local mock servers standing in for every external dependency:
 *
 *   - a mock Upstash REST server   (locks, scout records, kill switch)
 *   - a mock Base JSON-RPC server  (SpendPermissionManager, sale configs,
 *                                   balances, mint fee, multicall3, blocks)
 *   - a mock app-API server        (/api/timeline, /api/moments, /api/collect)
 *
 * Where the static verify suites prove the CALLDATA is right, this proves the
 * BEHAVIOR is right — the guards actually fire, the locks actually hold, a
 * mid-run kill switch actually halts spending, and a mid-run user pause
 * actually survives the final save. No real network, no real funds.
 *
 * Run:
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
 *     --import ./scripts/register-ts-alias.mjs scripts/verify-agent-scout-live.ts
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  decodeFunctionData,
  encodeFunctionResult,
  type Address,
  type Hex,
} from 'viem'

// ───────────────────────── tiny test runner ─────────────────────────

let passed = 0
let failed = 0
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
async function throws(fn: () => Promise<unknown>, re: RegExp, name: string) {
  try {
    await fn()
    ok(false, name, 'expected throw, resolved instead')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    ok(re.test(msg), name, `threw "${msg}" (wanted ${re})`)
  }
}
/** JSON with bigints, for structural comparison of composed calls. */
const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))
/** Reference plan.calls are EIP-5792 AgentCalls (hex value); the spender receives
 *  SpenderCalls (bigint value). Map the reference through the SAME conversion the
 *  production composer applies so the comparison is shape-faithful. */
const asSpenderCalls = (calls: readonly { to: string; data: string; value: string | bigint }[]) =>
  calls.map((c) => ({ to: c.to, data: c.data, value: BigInt(c.value) }))

// ───────────────────────── mock Upstash REST ─────────────────────────

interface StoredVal {
  v: string
  ex?: number
}
const redisStore = new Map<string, StoredVal>()
let redisFailing = false

function execRedisCommand(cmd: unknown[]): unknown {
  const op = String(cmd[0]).toUpperCase()
  if (op === 'SET') {
    const key = String(cmd[1])
    const val = String(cmd[2])
    let nx = false
    let ex: number | undefined
    for (let i = 3; i < cmd.length; i++) {
      const t = String(cmd[i]).toUpperCase()
      if (t === 'NX') nx = true
      if (t === 'EX') ex = Number(cmd[++i])
    }
    if (nx && redisStore.has(key)) return null
    redisStore.set(key, { v: val, ex })
    return 'OK'
  }
  if (op === 'GET') return redisStore.get(String(cmd[1]))?.v ?? null
  if (op === 'DEL') {
    let n = 0
    for (let i = 1; i < cmd.length; i++) if (redisStore.delete(String(cmd[i]))) n++
    return n
  }
  if (op === 'MGET') {
    const out: (string | null)[] = []
    for (let i = 1; i < cmd.length; i++) out.push(redisStore.get(String(cmd[i]))?.v ?? null)
    return out
  }
  if (op === 'SMEMBERS') return []
  return null // LPUSH/ZADD/EXPIRE/… — accepted, irrelevant to assertions
}

function startRedisServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      const reply = (x: unknown) => res.end(JSON.stringify(x))
      if (redisFailing) {
        const isPipeline = req.url?.includes('pipeline') || req.url?.includes('multi-exec')
        if (isPipeline) {
          const cmds = JSON.parse(body) as unknown[][]
          return reply(cmds.map(() => ({ error: 'mock redis down' })))
        }
        return reply({ error: 'mock redis down' })
      }
      try {
        if (req.url?.includes('pipeline') || req.url?.includes('multi-exec')) {
          const cmds = JSON.parse(body) as unknown[][]
          return reply(cmds.map((c) => ({ result: execRedisCommand(c) })))
        }
        const cmd = JSON.parse(body) as unknown[]
        return reply({ result: execRedisCommand(cmd) })
      } catch (e) {
        return reply({ error: String(e) })
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}

// ───────────────────────── mock Base JSON-RPC ─────────────────────────

// Reconstructed manager fragments — the same 9-field SpendPermission struct the
// SDK's toSpendPermissionArgs encodes, so decodeFunctionData matches the real
// selectors the SDK emits.
const SPEND_PERMISSION_COMPONENTS = [
  { name: 'account', type: 'address' },
  { name: 'spender', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'allowance', type: 'uint160' },
  { name: 'period', type: 'uint48' },
  { name: 'start', type: 'uint48' },
  { name: 'end', type: 'uint48' },
  { name: 'salt', type: 'uint256' },
  { name: 'extraData', type: 'bytes' },
] as const
const MANAGER_ABI = [
  {
    name: 'getCurrentPeriod',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'spendPermission', type: 'tuple', components: SPEND_PERMISSION_COMPONENTS }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'start', type: 'uint48' },
          { name: 'end', type: 'uint48' },
          { name: 'spend', type: 'uint160' },
        ],
      },
    ],
  },
  {
    name: 'isRevoked',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'spendPermission', type: 'tuple', components: SPEND_PERMISSION_COMPONENTS }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'isValid',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'spendPermission', type: 'tuple', components: SPEND_PERMISSION_COMPONENTS }],
    outputs: [{ type: 'bool' }],
  },
] as const
const MANAGER_ADDRESS = '0xf85210b21cc50302f477ba56686d2019dc9b67ad'

const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11'
const MULTICALL3_ABI = [
  {
    name: 'aggregate3',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const

// Mirrors of the exact view ABIs production reads (lib/saleConfig, lib/zoraMint).
const FPSS_SALE_ABI = [
  {
    name: 'sale',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenContract', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'saleStart', type: 'uint64' },
          { name: 'saleEnd', type: 'uint64' },
          { name: 'maxTokensPerAddress', type: 'uint64' },
          { name: 'pricePerToken', type: 'uint96' },
          { name: 'fundsRecipient', type: 'address' },
        ],
      },
    ],
  },
] as const
const TOKEN_INFO_ABI = [
  {
    name: 'getTokenInfo',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'uri', type: 'string' },
          { name: 'maxSupply', type: 'uint256' },
          { name: 'totalMinted', type: 'uint256' },
        ],
      },
    ],
  },
] as const
const BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const
const MINT_FEE_ABI = [
  { name: 'mintFee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const CHAIN_NOW = 1_800_000_000 // mock block timestamp
const PERIOD_START = 1_700_000_000
const rpcState = {
  failing: false,
  ownedBalance: 0n,
  periodSpend: 0n,
}

function handleEthCall(to: string, data: Hex): Hex {
  const target = to.toLowerCase()
  if (target === MULTICALL3_ADDRESS) {
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data })
    const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]
    const results = calls.map((c) => ({ success: true, returnData: handleEthCall(c.target, c.callData) }))
    return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', result: results })
  }
  if (target === MANAGER_ADDRESS) {
    const { functionName } = decodeFunctionData({ abi: MANAGER_ABI, data })
    if (functionName === 'getCurrentPeriod') {
      return encodeFunctionResult({
        abi: MANAGER_ABI,
        functionName,
        result: { start: PERIOD_START, end: PERIOD_START + 2_592_000 - 1, spend: rpcState.periodSpend },
      })
    }
    if (functionName === 'isRevoked') return encodeFunctionResult({ abi: MANAGER_ABI, functionName, result: false })
    return encodeFunctionResult({ abi: MANAGER_ABI, functionName: 'isValid', result: true })
  }
  // Strategy / collection reads — dispatch by decode success.
  try {
    decodeFunctionData({ abi: FPSS_SALE_ABI, data })
    return encodeFunctionResult({
      abi: FPSS_SALE_ABI,
      functionName: 'sale',
      result: {
        saleStart: 0n,
        saleEnd: BigInt(CHAIN_NOW) + 10_000_000n,
        maxTokensPerAddress: 0n,
        pricePerToken: 0n, // FREE drop — the paid-spend calldata already has byte-exact oracles
        fundsRecipient: '0x0000000000000000000000000000000000000000',
      },
    })
  } catch {}
  try {
    decodeFunctionData({ abi: TOKEN_INFO_ABI, data })
    return encodeFunctionResult({
      abi: TOKEN_INFO_ABI,
      functionName: 'getTokenInfo',
      result: { uri: '', maxSupply: 0n, totalMinted: 0n }, // open edition
    })
  } catch {}
  try {
    decodeFunctionData({ abi: BALANCE_ABI, data })
    return encodeFunctionResult({ abi: BALANCE_ABI, functionName: 'balanceOf', result: rpcState.ownedBalance })
  } catch {}
  decodeFunctionData({ abi: MINT_FEE_ABI, data }) // throws if unknown → surfaces in the test
  return encodeFunctionResult({ abi: MINT_FEE_ABI, functionName: 'mintFee', result: 0n })
}

const MOCK_BLOCK = {
  number: '0x1',
  hash: `0x${'11'.repeat(32)}`,
  parentHash: `0x${'22'.repeat(32)}`,
  timestamp: `0x${CHAIN_NOW.toString(16)}`,
  nonce: '0x0000000000000000',
  difficulty: '0x0',
  gasLimit: '0x1c9c380',
  gasUsed: '0x0',
  miner: `0x${'33'.repeat(20)}`,
  extraData: '0x',
  logsBloom: `0x${'00'.repeat(256)}`,
  sha3Uncles: `0x${'44'.repeat(32)}`,
  size: '0x0',
  stateRoot: `0x${'55'.repeat(32)}`,
  transactionsRoot: `0x${'66'.repeat(32)}`,
  receiptsRoot: `0x${'77'.repeat(32)}`,
  baseFeePerGas: '0x0',
  mixHash: `0x${'88'.repeat(32)}`,
  totalDifficulty: '0x0',
  uncles: [],
  transactions: [],
}

function startRpcServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (rpcState.failing) {
        res.statusCode = 500
        return res.end('mock rpc down')
      }
      res.setHeader('content-type', 'application/json')
      const rpc = JSON.parse(body) as { id: number; method: string; params?: unknown[] }
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      try {
        if (rpc.method === 'eth_chainId') return reply('0x2105')
        if (rpc.method === 'eth_getBlockByNumber') return reply(MOCK_BLOCK)
        if (rpc.method === 'eth_call') {
          const call = (rpc.params as [{ to: string; data: Hex }])[0]
          return reply(handleEthCall(call.to, call.data))
        }
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `unhandled ${rpc.method}` } }))
      } catch (e) {
        return res.end(
          JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: `mock: ${String(e)}` } }),
        )
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}

// ───────────────────────── mock app API (timeline/moments/collect) ─────────────────────────

const COLLECTION = `0x${'ab'.repeat(20)}` as Address
const collectPosts: unknown[] = []

function startAppServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/api/timeline') {
      if (url.searchParams.get('collector')) return res.end(JSON.stringify({ moments: [] }))
      return res.end(
        JSON.stringify({
          moments: [
            { address: COLLECTION, token_id: '1' },
            { address: COLLECTION, token_id: '2' },
          ],
        }),
      )
    }
    if (url.pathname === '/api/moments') {
      const sales: Record<string, unknown> = {}
      sales[`${COLLECTION.toLowerCase()}:1`] = { type: 'fixedPrice', pricePerToken: '0' }
      sales[`${COLLECTION.toLowerCase()}:2`] = { type: 'fixedPrice', pricePerToken: '0' }
      return res.end(JSON.stringify({ sales }))
    }
    if (url.pathname === '/api/collect') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        collectPosts.push(JSON.parse(body))
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}

// ───────────────────────── main ─────────────────────────

const USER = `0x${'aa'.repeat(20)}` as Address
const OTHER = `0x${'bb'.repeat(20)}` as Address
const SPENDER_ADDR = `0x${'cc'.repeat(20)}` as Address
const ARTIST = `0x${'dd'.repeat(20)}` as Address
const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

async function main() {
  const [redisUrl, rpcUrl, appUrl] = await Promise.all([startRedisServer(), startRpcServer(), startAppServer()])
  process.env.UPSTASH_REDIS_REST_URL = redisUrl
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token'
  process.env.BASE_RPC_URL = rpcUrl
  delete process.env.SCOUT_SPENDER_PRIVATE_KEY

  // Import the REAL production modules only after the env points at the mocks.
  const { collectViaSpendPermission } = await import('@/lib/agent/scout/serverExecutor')
  const { buildCollectBatchPlan } = await import('@/lib/agent/collectBatch')
  const { runDropCoordination } = await import('@/lib/agent/scout/dropCoordinator')
  const { runScoutServer } = await import('@/lib/agent/scout/runScoutServer')
  const { isKillSwitchEngaged } = await import('@/lib/agent/scout/killSwitch')
  type Sp = import('@/lib/agent/scout/serverExecutor').StoredSpendPermission
  type Spender = import('@/lib/agent/scout/spender').ScoutSpender
  type Item = import('@/lib/agent/collectBatch').BatchCollectItem

  const perm = (over: Partial<Sp['permission']> = {}): Sp =>
    ({
      signature: '0x01',
      chainId: 8453,
      permission: {
        account: USER,
        spender: SPENDER_ADDR,
        token: NATIVE_ETH,
        allowance: '1000000000000000000',
        period: 2_592_000,
        start: PERIOD_START,
        end: 281474976710655,
        salt: '0',
        extraData: '0x',
        ...over,
      },
    }) as Sp

  const freeItem = (tokenId: bigint, quantity = 1n): Item => ({
    collection: COLLECTION,
    tokenId,
    quantity,
    currency: 'eth',
    pricePerToken: 0n,
    mintFee: 0n,
    comment: '',
  })

  const captured: { calls: readonly { to: Address; data: Hex; value: bigint }[] }[] = []
  const mockSpender = (onCall?: () => void): Spender => ({
    address: SPENDER_ADDR,
    atomic: true,
    async sendCalls(calls) {
      onCall?.()
      captured.push({ calls })
      return { txHash: '0xabc' as Hex }
    },
  })

  // ── 1. Spend choke-point guards (real collectViaSpendPermission) ──
  console.log('\ncollectViaSpendPermission — identity + currency guards')
  await throws(
    () => collectViaSpendPermission({ permission: perm({ account: OTHER }), spender: mockSpender(), recipient: USER, item: freeItem(1n) }),
    /does not match the mint recipient/,
    'permission.account ≠ recipient → refused before any spend',
  )
  ok(redisStore.size === 0, 'refused BEFORE taking the drop lock (no Redis writes)')
  await throws(
    () => collectViaSpendPermission({ permission: perm({ token: USDC }), spender: mockSpender(), recipient: USER, item: freeItem(1n) }),
    /does not match the drop currency/,
    'permission.token ≠ item currency → refused',
  )

  // ── 2. Happy free-drop collect + lock semantics ──
  console.log('\ncollectViaSpendPermission — composition + hold-for-TTL lock')
  captured.length = 0
  const r1 = await collectViaSpendPermission({ permission: perm(), spender: mockSpender(), recipient: USER, item: freeItem(1n) })
  ok(r1.txHash === '0xabc', 'happy path returns the mint tx hash')
  const reference = buildCollectBatchPlan({ account: SPENDER_ADDR, recipient: USER, items: [freeItem(1n)], usdcAllowance: 0n })
  ok(j(captured[0]?.calls) === j(asSpenderCalls(reference.calls)), 'composed calls === REAL buildCollectBatchPlan output (free: mint-only)')
  const lockKey1 = `kismetart:scout-collect:${USER.toLowerCase()}:${COLLECTION.toLowerCase()}:1`
  ok(redisStore.has(lockKey1), 'drop lock STILL HELD after success (no early release)')
  ok(redisStore.get(lockKey1)?.ex === 300, 'lock TTL is 300s (outlives worst-case submit+confirm)')
  await throws(
    () => collectViaSpendPermission({ permission: perm(), spender: mockSpender(), recipient: USER, item: freeItem(1n) }),
    /already in progress/,
    'second collect of the same (recipient, drop) → lock contention refusal',
  )
  await throws(
    () =>
      collectViaSpendPermission({
        permission: perm(),
        spender: { ...mockSpender(), sendCalls: async () => { throw new Error('boom') } },
        recipient: USER,
        item: freeItem(2n),
      }),
    /boom/,
    'spender failure propagates',
  )
  ok(redisStore.has(`kismetart:scout-collect:${USER.toLowerCase()}:${COLLECTION.toLowerCase()}:2`), 'lock ALSO held after failure (op may still land)')

  // ── 3. In-lock TOCTOU edition clamp (real balanceOf via mock chain) ──
  console.log('\ncollectViaSpendPermission — in-lock edition re-clamp')
  captured.length = 0
  rpcState.ownedBalance = 1n
  await collectViaSpendPermission({ permission: perm(), spender: mockSpender(), recipient: USER, item: freeItem(3n, 2n), editionTarget: 2n })
  const clamped = buildCollectBatchPlan({ account: SPENDER_ADDR, recipient: USER, items: [freeItem(3n, 1n)], usdcAllowance: 0n })
  ok(j(captured[0]?.calls) === j(asSpenderCalls(clamped.calls)), 'owned=1, target=2, quantity=2 → re-clamped to mint exactly 1')
  rpcState.ownedBalance = 2n
  await throws(
    () => collectViaSpendPermission({ permission: perm(), spender: mockSpender(), recipient: USER, item: freeItem(4n, 1n), editionTarget: 2n }),
    /already at the edition target/,
    'owned ≥ target → refused inside the lock',
  )
  captured.length = 0
  rpcState.failing = true // balance read fails → proceed on caller quantity (documented fail-open, chain caps bound it)
  await collectViaSpendPermission({ permission: perm(), spender: mockSpender(), recipient: USER, item: freeItem(5n, 2n), editionTarget: 2n })
  rpcState.failing = false
  rpcState.ownedBalance = 0n
  const unclamped = buildCollectBatchPlan({ account: SPENDER_ADDR, recipient: USER, items: [freeItem(5n, 2n)], usdcAllowance: 0n })
  ok(j(captured[0]?.calls) === j(asSpenderCalls(unclamped.calls)), 'balance read failure → proceeds on caller quantity (bounded on-chain)')

  // ── 4. Kill switch fail-closed semantics (real module, real store states) ──
  console.log('\nkillSwitch — fail-closed ladder')
  redisFailing = true
  ok(await isKillSwitchEngaged(), 'store down + no last-known-good (cold start) → ENGAGED (halt)')
  redisFailing = false
  ok(!(await isKillSwitchEngaged()), 'store healthy, key absent → not engaged')
  redisFailing = true
  ok(!(await isKillSwitchEngaged()), 'store down but last-known-good=false → stays last-known-good')
  redisFailing = false
  redisStore.set('kismetart:scout-killswitch', { v: '1' })
  ok(await isKillSwitchEngaged(), 'key set → engaged')
  redisStore.delete('kismetart:scout-killswitch')

  // ── 5. Drop-coordinator entry guard ──
  console.log('\ndropCoordinator — entry guards')
  const bad = await runDropCoordination({ collection: COLLECTION, tokenId: '0x1a', creator: ARTIST }, appUrl)
  ok(bad.reason === 'invalid tokenId' && bad.collected === 0, 'non-numeric tokenId → clean refusal, no throw, no spend')

  // ── 6. FULL runScoutServer drive: discovery → engine → executor → spend seam ──
  console.log('\nrunScoutServer — full autonomous run (mid-run kill switch + pause survives save)')
  // The unit tests above deliberately leave their drop locks HELD (that is the
  // hold-for-TTL design). Clear the mock store so this full run starts fresh.
  redisStore.clear()
  const scoutKey = `kismetart:scout:${USER.toLowerCase()}`
  const record = {
    scout: {
      id: USER.toLowerCase(),
      owner: USER.toLowerCase(),
      name: 'Agent Collect',
      mode: 'auto',
      status: 'active',
      budget: { currency: 'eth', allowance: '1000000000000000000', periodSeconds: 2_592_000, start: PERIOD_START, end: 4_102_444_800 },
      policy: {
        collections: [],
        creators: [ARTIST.toLowerCase()],
        blockedCollections: [],
        blockedCreators: [],
        maxItemPrice: '1000000000000000000',
        maxItemsPerPeriod: 5,
        maxEditionsPerDrop: 1,
        mediaTypes: [],
      },
      createdAt: 1,
    },
    usage: { periodStart: PERIOD_START, spentThisPeriod: '0', itemsThisPeriod: 0 },
    away: true,
    permission: perm(),
  }
  redisStore.set(scoutKey, { v: JSON.stringify(record) })

  // First collect succeeds; its side effects simulate a LIVE incident + a LIVE
  // user action while the run is still executing: the operator engages the kill
  // switch AND the user pauses the agent.
  const midRunSpender = mockSpender(() => {
    redisStore.set('kismetart:scout-killswitch', { v: '1' })
    const cur = JSON.parse(redisStore.get(scoutKey)!.v) as typeof record
    cur.scout.status = 'paused'
    redisStore.set(scoutKey, { v: JSON.stringify(cur) })
  })
  collectPosts.length = 0
  captured.length = 0
  const summary = await runScoutServer({ owner: USER.toLowerCase(), baseUrl: appUrl, spender: midRunSpender })
  ok(summary.collected === 1, `collected exactly 1 before the brake (got ${summary.collected})`)
  ok(/kill switch engaged mid-run/.test(summary.reason ?? ''), 'mid-run kill switch halts remaining collects with a specific reason')
  ok(summary.skipped === 1, `the un-attempted candidate is counted skipped (got ${summary.skipped})`)
  ok(collectPosts.length === 1, 'exactly one /api/collect record posted')
  const post = (collectPosts[0] ?? {}) as { account?: string; txHash?: string; amount?: number }
  ok(post.account === USER.toLowerCase() && post.txHash === '0xabc' && post.amount === 1, 'record carries the user, tx hash, and quantity')
  const saved = JSON.parse(redisStore.get(scoutKey)!.v) as typeof record
  ok(saved.scout.status === 'paused', "mid-run PAUSE SURVIVES the final save (fresh re-read merge — the user's stop sticks)")
  ok(saved.usage.itemsThisPeriod === 1, 'item usage persisted from the run onto the fresh record')
  ok(saved.away === true && !!saved.permission, 'away flag + permission preserved through the merge')
  redisStore.delete('kismetart:scout-killswitch')

  // ── 7. Entry kill switch on the same real run path ──
  redisStore.set('kismetart:scout-killswitch', { v: '1' })
  const halted = await runScoutServer({ owner: USER.toLowerCase(), baseUrl: appUrl, spender: mockSpender() })
  ok(halted.reason === 'kill switch engaged' && halted.collected === 0, 'engaged kill switch halts a run at entry')
  redisStore.delete('kismetart:scout-killswitch')

  console.log(`\n${failed === 0 ? 'OK' : 'FAILED'} — scout live-behavior: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('harness error:', e)
  process.exit(1)
})
