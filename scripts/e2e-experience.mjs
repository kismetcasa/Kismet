// End-to-end drive of the Experience over REAL HTTP against the BUILT app.
//
// Everything hermetic in the repo stops at the library boundary — the oracles
// drive lib/experience against a mock Upstash, but nothing exercises the route
// handlers, request parsing, cookies, rate limits, the RPC proofs, or the SSR
// pages as a running server. This does: it boots `next start` on a spare port
// with the Upstash REST client and the Base RPC client pointed at two mock
// servers in this process, then walks the product the way its users will —
// creator publishes, player pays and plays, delivery stalls, player recovers,
// verifier recomputes, curator promotes, cron commits seeds — asserting at each
// step. CDP credentials are deliberately absent, so every delivery lands in the
// `pending` state the recovery paths exist for.
//
// Not in `npm run check`: it needs a production build and ~30s. Run it before
// merging anything that touches app/api/experience or lib/experience:
//
//   npm run build && npm run e2e:experience

import { createServer, request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
} from 'viem'

// ── fixtures ──────────────────────────────────────────────────────────────────
const ADMIN = '0x3d140b892437dd7857701098415deb2daae03a40'
const CREATOR2 = '0x9e12d044c7b3a5f8e21d6c09b4a7f3e8d5c2b1aa'
const PLAYER = '0x51be09ac3e7d21f48b6a0c5d9e2f7b3a1c8d77aa'
const ARTIST_B = '0xb2e4f0a91c6d3e8b7a5f2c4d1e9b8a7f6c3d9d05'
const OPERATOR = '0xaaaa000000000000000000000000000000000001'
const ZERO = '0x0000000000000000000000000000000000000000'
const CAPSULE = '0xcccc000000000000000000000000000000000001'
const CAPSULE_2 = '0xcccc000000000000000000000000000000000002'
const CAPSULE_3 = '0xcccc000000000000000000000000000000000003'
const POOL = '0xdddd000000000000000000000000000000000002'
const TX_A = '0x' + 'a1'.repeat(32) // player mints 2 capsules of machine 1
const TX_B = '0x' + 'b2'.repeat(32) // player mints 1 capsule "on zora.co" — never seen by our UI
const TX_N = '0x' + 'c3'.repeat(32) // player mints 1 capsule of the no-grant machine
const USER_TOKEN = 'e2e-user-session-token'
const ADMIN_USER_TOKEN = 'e2e-admin-user-session-token'
const ADMIN_TOKEN = 'e2e-admin-session-token'
const CRON_SECRET = 'e2e-cron-secret'
const PORT = 3999

// ── mock Upstash REST ─────────────────────────────────────────────────────────
const strings = new Map()
const hashes = new Map()
const sets = new Map()
const zsets = new Map()
const unsupported = new Set()

function sortedZ(m) {
  return [...m.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
}
function rankRange(n, start, stop) {
  const a = start < 0 ? Math.max(0, n + start) : start
  const b = stop < 0 ? n + stop : Math.min(n - 1, stop)
  return [a, b]
}

function exec(cmd) {
  const name = String(cmd[0]).toLowerCase()
  const args = cmd.slice(1).map(String)
  const k = args[0]
  switch (name) {
    case 'get': return strings.get(k) ?? null
    case 'mget': return args.map((key) => strings.get(key) ?? null)
    case 'set': {
      const nx = args.some((a) => a.toLowerCase() === 'nx')
      if (nx && strings.has(k)) return null
      strings.set(k, args[1]); return 'OK'
    }
    case 'setex': strings.set(k, args[2]); return 'OK'
    case 'del': { let n = 0; for (const key of args) { if (strings.delete(key)) n++; if (hashes.delete(key)) n++; if (sets.delete(key)) n++; if (zsets.delete(key)) n++ } return n }
    case 'exists': return strings.has(k) || hashes.has(k) || sets.has(k) || zsets.has(k) ? 1 : 0
    case 'expire': case 'pexpire': return 1
    case 'ttl': return 3600
    case 'incr': case 'incrby': {
      const by = name === 'incr' ? 1 : Number(args[1])
      const cur = parseInt(strings.get(k) ?? '0', 10)
      const next = (Number.isFinite(cur) ? cur : 0) + by
      strings.set(k, String(next)); return next
    }
    case 'hset': { const m = hashes.get(k) ?? new Map(); for (let i = 1; i < args.length; i += 2) m.set(args[i], args[i + 1]); hashes.set(k, m); return 1 }
    case 'hget': return hashes.get(k)?.get(args[1]) ?? null
    case 'hgetall': { const m = hashes.get(k); if (!m) return []; const out = []; for (const [f, v] of m) out.push(f, v); return out }
    case 'hdel': { const m = hashes.get(k); let n = 0; for (const f of args.slice(1)) if (m?.delete(f)) n++; return n }
    case 'hincrby': { const m = hashes.get(k) ?? new Map(); hashes.set(k, m); const cur = parseInt(m.get(args[1]) ?? '0', 10); const next = (Number.isFinite(cur) ? cur : 0) + Number(args[2]); m.set(args[1], String(next)); return next }
    case 'lpush': { const l = strings.get('__list:' + k) ? JSON.parse(strings.get('__list:' + k)) : []; l.unshift(...args.slice(1)); strings.set('__list:' + k, JSON.stringify(l)); return l.length }
    case 'ltrim': { const l = strings.get('__list:' + k) ? JSON.parse(strings.get('__list:' + k)) : []; const [a, b] = rankRange(l.length, Number(args[1]), Number(args[2])); strings.set('__list:' + k, JSON.stringify(b < a ? [] : l.slice(a, b + 1))); return 'OK' }
    case 'lrange': { const l = strings.get('__list:' + k) ? JSON.parse(strings.get('__list:' + k)) : []; const [a, b] = rankRange(l.length, Number(args[1]), Number(args[2])); return b < a ? [] : l.slice(a, b + 1) }
    case 'sadd': { const s = sets.get(k) ?? new Set(); for (const m of args.slice(1)) s.add(m); sets.set(k, s); return 1 }
    case 'srem': { const s = sets.get(k); let n = 0; for (const m of args.slice(1)) { if (s?.delete(m)) n++ } return n }
    case 'smembers': return [...(sets.get(k) ?? [])]
    case 'sismember': return sets.get(k)?.has(args[1]) ? 1 : 0
    case 'scard': return sets.get(k)?.size ?? 0
    case 'zadd': { const m = zsets.get(k) ?? new Map(); const rest = args.slice(1).filter((a) => !['nx', 'xx', 'gt', 'lt', 'ch'].includes(a.toLowerCase())); for (let i = 0; i < rest.length; i += 2) m.set(rest[i + 1], Number(rest[i])); zsets.set(k, m); return 1 }
    case 'zrem': { const m = zsets.get(k); let n = 0; for (const mem of args.slice(1)) { if (m?.delete(mem)) n++ } return n }
    case 'zscore': { const s = zsets.get(k)?.get(args[1]); return s === undefined ? null : s }
    case 'zcard': return zsets.get(k)?.size ?? 0
    case 'zrange': {
      const m = zsets.get(k); if (!m) return []
      let entries = sortedZ(m)
      const flags = args.map((a) => a.toLowerCase())
      const bound = (raw, d) => raw === '+inf' ? Infinity : raw === '-inf' ? -Infinity : Number.isFinite(Number(raw)) ? Number(raw) : d
      if (flags.includes('byscore')) {
        const lo = bound(args[1], -Infinity), hi = bound(args[2], Infinity)
        entries = entries.filter(([, sc]) => sc >= lo && sc <= hi)
      } else {
        const [a, b] = rankRange(entries.length, Number(args[1]), Number(args[2]))
        entries = b < a ? [] : entries.slice(a, b + 1)
      }
      return (flags.includes('rev') ? entries.reverse() : entries).map(([mem]) => mem)
    }
    case 'zremrangebyrank': { const m = zsets.get(k); if (!m) return 0; const s = sortedZ(m); const [a, b] = rankRange(s.length, Number(args[1]), Number(args[2])); if (b < a) return 0; for (const [mem] of s.slice(a, b + 1)) m.delete(mem); return b - a + 1 }
    case 'zremrangebyscore': { const m = zsets.get(k); if (!m) return 0; const lo = args[1] === '-inf' ? -Infinity : Number(args[1]); const hi = args[2] === '+inf' ? Infinity : Number(args[2]); let n = 0; for (const [mem, sc] of [...m.entries()]) { if (sc >= lo && sc <= hi) { m.delete(mem); n++ } } return n }
    case 'eval': {
      // Upstash sends ["eval", script, numkeys, ...keys, ...argv].
      const script = args[0]; const nk = Number(args[1]); const keys = args.slice(2, 2 + nk); const argv = args.slice(2 + nk)
      const lua = script.toUpperCase()
      if (lua.includes('INCR')) return exec(['incr', keys[0]])
      if (lua.includes('DEL')) { if (strings.get(keys[0]) === argv[0]) { strings.delete(keys[0]); return 1 } return 0 }
      unsupported.add('eval:' + script.slice(0, 40)); return null
    }
    default:
      unsupported.add(name); return null
  }
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
function enc(v) { if (typeof v === 'string') return v === 'OK' ? 'OK' : b64(v); if (Array.isArray(v)) return v.map(enc); return v }

const DEBUG = process.env.E2E_DEBUG === '1'
const redisServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      const useB64 = req.headers['upstash-encoding'] === 'base64'
      const e = (v) => (useB64 ? enc(v) : v)
      const parsed = JSON.parse(body)
      const run = (c) => {
        try {
          const r = exec(c)
          if (DEBUG && ['set', 'eval', 'get'].includes(String(c[0]).toLowerCase())) console.error(`[redis] ${c[0]} ${String(c[1]).slice(0, 70)} -> ${JSON.stringify(r)?.slice(0, 40)}`)
          return { result: e(r) }
        } catch (err) { return { error: String(err) } }
      }
      const out = Array.isArray(parsed[0]) ? parsed.map(run) : run(parsed)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out))
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })) }
  })
})

// ── mock Base JSON-RPC ────────────────────────────────────────────────────────
const TOKEN_INFO = parseAbi(['function getTokenInfo(uint256 tokenId) view returns ((string uri, uint256 maxSupply, uint256 totalMinted))'])
const PERMS = parseAbi(['function permissions(uint256 tokenId, address user) view returns (uint256)'])
const BALANCE = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)'])
const TRANSFER = parseAbi(['event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'])
const SEL = { tokenInfo: toFunctionSelector('getTokenInfo(uint256)'), perms: toFunctionSelector('permissions(uint256,address)'), balance: toFunctionSelector('balanceOf(address,uint256)') }
const OPEN = 18446744073709551615n

const chain = {
  head: 5_000_000n,
  tokens: new Map(),   // `${collection}:${id}` -> { maxSupply, totalMinted }
  perms: new Map(),    // `${collection}:${id}:${user}` -> bits
  balances: new Map(), // `${collection}:${account}:${id}` -> n
  receipts: new Map(), // txHash -> receipt
  logs: [],
}
const key = (...p) => p.map((x) => String(x).toLowerCase()).join(':')
function addMint({ tx, collection, to, id, value, block }) {
  const topics = encodeEventTopics({ abi: TRANSFER, eventName: 'TransferSingle', args: { operator: to, from: ZERO, to } })
  const data = encodeAbiParameters(parseAbiParameters('uint256, uint256'), [id, value])
  const log = { address: collection, topics, data, blockNumber: '0x' + block.toString(16), transactionHash: tx, transactionIndex: '0x0', blockHash: '0x' + 'bb'.repeat(32), logIndex: '0x0', removed: false }
  chain.logs.push(log)
  chain.receipts.set(tx.toLowerCase(), {
    transactionHash: tx, transactionIndex: '0x0', blockHash: log.blockHash, blockNumber: log.blockNumber,
    from: to, to: collection, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1',
    contractAddress: null, logs: [log], logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2',
  })
}

function rpc(method, params) {
  switch (method) {
    case 'eth_chainId': return '0x2105'
    case 'eth_blockNumber': return '0x' + chain.head.toString(16)
    case 'eth_getTransactionReceipt': return chain.receipts.get(String(params[0]).toLowerCase()) ?? null
    case 'eth_call': {
      const { to, data } = params[0]
      const sel = data.slice(0, 10)
      if (sel === SEL.tokenInfo) {
        const { args } = decodeFunctionData({ abi: TOKEN_INFO, data })
        const t = chain.tokens.get(key(to, args[0])) ?? { maxSupply: 0n, totalMinted: 0n }
        return encodeFunctionResult({ abi: TOKEN_INFO, functionName: 'getTokenInfo', result: { uri: '', maxSupply: t.maxSupply, totalMinted: t.totalMinted } })
      }
      if (sel === SEL.perms) {
        const { args } = decodeFunctionData({ abi: PERMS, data })
        return encodeFunctionResult({ abi: PERMS, functionName: 'permissions', result: chain.perms.get(key(to, args[0], args[1])) ?? 0n })
      }
      if (sel === SEL.balance) {
        const { args } = decodeFunctionData({ abi: BALANCE, data })
        return encodeFunctionResult({ abi: BALANCE, functionName: 'balanceOf', result: chain.balances.get(key(to, args[0], args[1])) ?? 0n })
      }
      return '0x'
    }
    case 'eth_getLogs': {
      const f = params[0]
      const addrs = (Array.isArray(f.address) ? f.address : [f.address]).filter(Boolean).map((a) => a.toLowerCase())
      const from = f.fromBlock && f.fromBlock !== 'latest' && f.fromBlock !== 'earliest' ? BigInt(f.fromBlock) : 0n
      const to = f.toBlock && f.toBlock !== 'latest' ? BigInt(f.toBlock) : chain.head
      return chain.logs.filter((l) => {
        if (addrs.length && !addrs.includes(l.address.toLowerCase())) return false
        const bn = BigInt(l.blockNumber)
        if (bn < from || bn > to) return false
        return (f.topics ?? []).every((t, i) => {
          if (t == null) return true
          const want = (Array.isArray(t) ? t : [t]).map((x) => x.toLowerCase())
          return want.includes((l.topics[i] ?? '').toLowerCase())
        })
      })
    }
    default: return null
  }
}
const rpcServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body)
      const one = (r) => {
        const result = rpc(r.method, r.params ?? [])
        if (DEBUG) console.error(`[rpc] ${r.method} ${JSON.stringify(r.params ?? [], (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 220)} -> ${Array.isArray(result) ? `${result.length} logs` : String(result).slice(0, 60)}`)
        return { jsonrpc: '2.0', id: r.id, result }
      }
      const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v)))
    } catch (err) { res.writeHead(500); res.end(String(err)) }
  })
})

// ── harness ──────────────────────────────────────────────────────────────────
let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ipCounter = 0
const USER_COOKIE = '__Host-kismet_session'
const ADMIN_COOKIE = '__Host-kismetart-admin'
async function call(path, { method = 'GET', body, user, admin } = {}) {
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` }
  const cookies = []
  if (user) cookies.push(`${USER_COOKIE}=${user}`)
  if (admin) cookies.push(`${ADMIN_COOKIE}=${admin}`)
  if (cookies.length) headers.cookie = cookies.join('; ')
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* html */ }
  return { status: res.status, json, text }
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
/** Raw node:http status probe, bypassing fetch entirely. A closed local port
 *  must refuse in milliseconds; routed through an environment proxy, fetch can
 *  instead hang on it — which stalled the harness before it ever spawned. */
const probe = (path) => new Promise((resolve) => {
  const req = httpRequest({ host: '127.0.0.1', port: PORT, path, method: 'GET', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
  req.on('timeout', () => { req.destroy(); resolve(null) })
  req.on('error', () => resolve(null))
  req.end()
})
const dayShift = (epoch, d) => { const [y, m, dd] = epoch.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10) }

// ── boot ─────────────────────────────────────────────────────────────────────
await new Promise((r) => redisServer.listen(0, '127.0.0.1', r))
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r))
const redisPort = redisServer.address().port
const rpcPort = rpcServer.address().port

// Sessions: the create route reads the USER cookie (and decides admin by
// address); the review API reads the ADMIN cookie.
strings.set(`kismetart:session:${ADMIN_USER_TOKEN}`, ADMIN)
strings.set(`kismetart:session:${USER_TOKEN}`, CREATOR2)
strings.set(`kismetart:auth-session:${ADMIN_TOKEN}`, ADMIN)

// Chain: capsules are capped editions; the pool has a creator floor (open)
// and a capped piece by another artist; the operator holds MINTER (4) on both.
chain.tokens.set(key(CAPSULE, 1), { maxSupply: 100n, totalMinted: 12n })
chain.tokens.set(key(CAPSULE_2, 1), { maxSupply: 50n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_3, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(POOL, 7), { maxSupply: OPEN, totalMinted: 3n })
chain.tokens.set(key(POOL, 14), { maxSupply: 20n, totalMinted: 2n })
chain.tokens.set(key(POOL, 99), { maxSupply: OPEN, totalMinted: 0n })
chain.tokens.set(key(POOL, 8), { maxSupply: OPEN, totalMinted: 1n })
chain.perms.set(key(POOL, 7, OPERATOR), 4n)
chain.perms.set(key(POOL, 14, OPERATOR), 4n)
chain.perms.set(key(POOL, 8, OPERATOR), 4n)
// token 99 deliberately has NO grant — the no-grant machine's only piece.
addMint({ tx: TX_A, collection: CAPSULE, to: PLAYER, id: 1n, value: 2n, block: 5_000_010n })
addMint({ tx: TX_B, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_020n })
addMint({ tx: TX_N, collection: CAPSULE_3, to: PLAYER, id: 1n, value: 1n, block: 5_000_030n })

if ((await probe('/api/experience/machines')) !== null) {
  console.error(`port ${PORT} is already serving — a stale server would answer with the wrong build; stop it first`)
  process.exit(1)
}
// Next renames its server process ("next-server (v…)") and it outlives a
// process-group kill, so the child is tagged through its environment and
// shutdown kills whatever still carries the tag. Linux-only (/proc), like the
// CI this runs in.
const MARKER_KEY = 'E2E_MARKER'
const MARKER_VAL = `${process.pid}-${Date.now()}`
function killMarked() {
  let dirs = []
  try { dirs = readdirSync('/proc') } catch { return }
  for (const d of dirs) {
    if (!/^[0-9]+$/.test(d) || Number(d) === process.pid) continue
    try { if (readFileSync(`/proc/${d}/environ`, 'latin1').includes(`${MARKER_KEY}=${MARKER_VAL}`)) process.kill(Number(d), 'SIGKILL') } catch { /* gone or not ours */ }
  }
}
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], {
  cwd: process.cwd(),
  detached: true,
  env: {
    ...process.env,
    [MARKER_KEY]: MARKER_VAL,
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${redisPort}`,
    UPSTASH_REDIS_REST_TOKEN: 'e2e',
    BASE_RPC_URL: `http://127.0.0.1:${rpcPort}`,
    ADMIN_ADDRESS: ADMIN,
    EXPERIENCE_OPERATOR_ADDRESSES: OPERATOR,
    CRON_SECRET,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    CDP_API_KEY_ID: '', CDP_API_KEY_SECRET: '', CDP_WALLET_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
child.stdout.on('data', (d) => { serverLog += d; if (DEBUG) process.stderr.write(`[next] ${d}`) })
child.stderr.on('data', (d) => { serverLog += d; if (DEBUG) process.stderr.write(`[next] ${d}`) })
child.on('error', (err) => { console.error(`spawn failed: ${err.message}`); process.exit(1) })
child.on('exit', (code, sig) => { if (!up) { console.error(`server exited before ready (code=${code} sig=${sig})\n${serverLog.slice(-1500)}`); process.exit(1) } })
let up = false
const shutdown = () => { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } killMarked(); redisServer.close(); rpcServer.close() }
process.on('exit', shutdown)
// A SIGTERM/SIGINT (a `timeout`, a Ctrl-C) does not run 'exit' handlers on its
// own, and an orphaned server would hold the port for the next run.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { shutdown(); process.exit(1) })

for (let i = 0; i < 120 && !up; i++) {
  await sleep(500)
  up = (await probe('/api/experience/machines')) === 200
}
if (!up) { console.error('server did not come up\n' + serverLog.slice(-2000)); process.exit(1) }
console.log(`\nserver up on :${PORT} (redis :${redisPort}, rpc :${rpcPort})`)

try {
  // ═══ 1. creator publishes ══════════════════════════════════════════════════
  console.log('\n1. creator publishes a machine')
  const empty = await call('/api/experience/machines')
  check('the list starts empty', empty.status === 200 && empty.json.machines.length === 0)

  const draft = {
    id: 'spring-season', name: 'Spring Season',
    capsule: { collection: CAPSULE, tokenId: '1' },
    entries: [
      { collection: POOL, tokenId: '7', artist: ADMIN, weight: 30, supply: 0 },
      { collection: POOL, tokenId: '14', artist: ARTIST_B, weight: 70, supply: 3 },
    ],
    splitRecipients: [ADMIN, ARTIST_B],
  }
  const unauth = await call('/api/experience/machines', { method: 'POST', body: draft })
  check('publishing needs a session', unauth.status === 401)

  const dry = await call('/api/experience/machines', { method: 'POST', body: { ...draft, dryRun: true }, user: ADMIN_USER_TOKEN })
  check('a dry run passes the live gate', dry.status === 200 && dry.json.dryRun === true && dry.json.problems.length === 0, JSON.stringify(dry.json))
  check('and reports the on-chain capsule supply', dry.json?.capsule?.maxSupply === 100 && dry.json?.capsule?.minted === 12)
  check('and writes nothing', (await call('/api/experience/machines')).json.machines.length === 0)

  const insolvent = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: { ...draft, id: 'broke', entries: [draft.entries[1]], dryRun: true } })
  check('an undercollateralised lineup is refused with the reason', insolvent.status === 400 && insolvent.json.problems.some((p) => p.code === 'undercollateralised'))

  const pub = await call('/api/experience/machines', { method: 'POST', body: draft, user: ADMIN_USER_TOKEN })
  check('an admin publish goes live', pub.status === 200 && pub.json.machine.state === 'live', JSON.stringify(pub.json))
  check('the publish block is recorded', pub.json?.machine?.createdBlock === 5_000_000)
  check('the split is persisted', Array.isArray(pub.json?.machine?.splitRecipients) && pub.json.machine.splitRecipients.length === 2)

  // Time passes: the capsules were minted after the machine was published.
  chain.head = 5_000_050n

  const dupe = await call('/api/experience/machines', { method: 'POST', body: { ...draft, id: 'spring-again' }, user: ADMIN_USER_TOKEN })
  check('a second machine cannot claim the same capsule token', dupe.status === 400 && dupe.json.problems?.[0]?.code === 'capsule-in-use')

  // ═══ 2. the public payload ═════════════════════════════════════════════════
  console.log('\n2. the machine as a player sees it')
  const detail = await call('/api/experience/machines/spring-season')
  check('the payload serves', detail.status === 200)
  const odds = detail.json?.odds ?? []
  check('odds are derived for every entry', odds.length === 2)
  check('and sum to one', Math.abs(odds.reduce((a, o) => a + o.probability, 0) - 1) < 1e-9)
  check('the floor piece is unlimited', odds.find((o) => o.tokenId === '7')?.remaining === null)
  check('coverage reads as always available', detail.json?.coverage?.prizesRemaining === null && detail.json.coverage.covered === true)
  const today = detail.json?.fairness?.epoch
  check("today's commitment is published", typeof detail.json?.fairness?.commitment === 'string' && detail.json.fairness.commitment.length === 64)
  check("and tomorrow's is already fixed", detail.json?.fairness?.next?.epoch === dayShift(today, 1) && detail.json.fairness.next.commitment.length === 64)
  check('the seed itself is never in the payload', !JSON.stringify(detail.json).includes(strings.get(`kismetart:xp:spring-season:seed:${today}`)))

  const listPage = await call('/experience')
  check('the list page renders the live machine', listPage.status === 200 && listPage.text.includes('Spring Season'))
  check('the machine page renders', (await call('/experience/spring-season')).status === 200)
  check('the verify page renders', (await call('/experience/spring-season/verify')).status === 200)
  check('the studio renders', (await call('/experience/new')).status === 200)

  // ═══ 3. a play, with delivery stalled ══════════════════════════════════════
  console.log('\n3. a two-capsule play whose delivery cannot be sponsored')
  const bogus = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: '0x' + 'ff'.repeat(32), account: PLAYER, unitIndex: 0 } })
  check('an unknown transaction is refused', bogus.status === 403)
  const wrongOwner = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: ARTIST_B, unitIndex: 0 } })
  check("someone else's capsule cannot be played", wrongOwner.status === 403)

  const p0 = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: PLAYER, unitIndex: 0 } })
  check('the play is accepted', p0.status === 200 && p0.json.ok === true, JSON.stringify(p0.json))
  check('the on-chain unit count comes back', p0.json?.units === 2)
  check('a prize was drawn', !!p0.json?.claim?.prize?.tokenId)
  check('and the claim pends because nothing can sign the mint', p0.json?.claim?.state === 'pending' && /sponsor|unavailable/.test(p0.json.claim.pendingReason ?? ''), p0.json?.claim?.pendingReason)
  check('the claim carries its commitment', p0.json?.claim?.commitment === detail.json.fairness.commitment)

  const replay = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: PLAYER, unitIndex: 0 } })
  check('replaying returns the recorded claim, never a second draw', replay.json?.replay === true && replay.json.claim.prize.tokenId === p0.json.claim.prize.tokenId)
  const overflow = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: PLAYER, unitIndex: 2 } })
  check('a unit the transaction does not cover is refused', overflow.status === 400)

  await sleep(400)
  const claims = await call(`/api/experience/claims?machineId=spring-season&account=${PLAYER}`)
  check('the claims route lists the stalled play', claims.json?.claims?.length === 1 && claims.json.claims[0].unresolved === true)
  check('spark was credited', claims.json?.spark === 1)

  const disc = await call(`/api/experience/discover?machineId=spring-season&account=${PLAYER}`)
  check('discovery finds both capsule transactions on-chain', disc.status === 200 && disc.json.capsules.length === 2, JSON.stringify(disc.json))
  const dA = disc.json?.capsules?.find((c) => c.txHash === TX_A)
  const dB = disc.json?.capsules?.find((c) => c.txHash === TX_B)
  check('the played transaction shows both units still owed', dA?.units === 2 && dA?.owedUnits?.length === 2)
  check('the never-seen "zora.co" mint is surfaced with its unit', dB?.units === 1 && dB?.owedUnits?.[0] === 0)

  // ═══ 4. recovery ═══════════════════════════════════════════════════════════
  console.log('\n4. recovery')
  const prize = p0.json.claim.prize
  const r1 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, unitIndex: 0 } })
  check('resume without a landed mint stays pending', r1.json?.claim?.state === 'pending' && r1.json.resumed === false)
  check('and does not draw a second prize', r1.json?.claim?.prize?.tokenId === prize.tokenId)

  chain.balances.set(key(prize.collection, PLAYER, prize.tokenId), 1n)
  const r2 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, unitIndex: 0 } })
  check('once the chain shows the artwork, resume reconciles to delivered', r2.json?.claim?.state === 'delivered' && r2.json.resumed === true, JSON.stringify(r2.json))
  const r3 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, unitIndex: 0 } })
  check('a delivered claim is inert to further resumes', r3.json?.claim?.state === 'delivered' && r3.json.resumed === false)

  await sleep(400)
  const claims2 = await call(`/api/experience/claims?machineId=spring-season&account=${PLAYER}`)
  check('the claims route now shows it settled', claims2.json?.claims?.find((c) => c.unitIndex === 0)?.unresolved === false)
  const notif = zsets.get(`kismetart:notif:${PLAYER}`)
  check('the win notification was written', !!notif && [...notif.keys()].some((raw) => raw.includes('experience_win')))

  const pB = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_B, account: PLAYER, unitIndex: 0 } })
  check('the zora.co capsule plays through the same route', pB.status === 200 && pB.json.ok === true && !!pB.json.claim?.prize)
  const disc2 = await call(`/api/experience/discover?machineId=spring-season&account=${PLAYER}`)
  check('discovery is cached briefly (unchanged within the TTL)', disc2.json?.capsules?.length === 2)

  // ═══ 5. the verifier ═══════════════════════════════════════════════════════
  console.log('\n5. the verifier')
  const vLive = await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_A}&unitIndex=0`)
  check('a live epoch is not yet verifiable', vLive.json?.verifiable === false && vLive.json.revealsAfter === today)
  check('but its commitment is', vLive.json?.commitment === detail.json.fairness.commitment)

  // Close the epoch by hand: move the claim to yesterday and file today's seed
  // under that day, exactly what the passage of one day would leave behind.
  const claimKey = `kismetart:xp:spring-season:claim:${TX_A}:0`
  const stored = JSON.parse(strings.get(claimKey))
  const seed = strings.get(`kismetart:xp:spring-season:seed:${today}`)
  const yesterday = dayShift(today, -1)
  strings.set(`kismetart:xp:spring-season:seed:${yesterday}`, seed)
  strings.set(claimKey, JSON.stringify({ ...stored, epoch: yesterday, commitment: sha256(seed) }))
  const vDone = await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_A}&unitIndex=0`)
  check('a closed epoch reveals and verifies', vDone.json?.verifiable === true && vDone.json.ok === true, JSON.stringify(vDone.json).slice(0, 300))
  check('the recomputed draw is the delivered artwork', vDone.json?.recomputed?.tokenId === prize.tokenId && vDone.json.delivered?.tokenId === prize.tokenId)
  check('the revealed seed matches the published commitment', vDone.json?.serverSeed === seed && vDone.json.commitment === sha256(seed))
  strings.set(claimKey, JSON.stringify({ ...stored, epoch: yesterday, commitment: sha256('not-the-seed') }))
  const vBad = await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_A}&unitIndex=0`)
  check('a claim served under a different commitment FAILS to verify', vBad.json?.verifiable === true && vBad.json.ok === false)

  // ═══ 6. a pool that cannot deliver ═════════════════════════════════════════
  console.log('\n6. a pool whose only artist has not granted mint rights')
  const noGrant = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'no-grant', name: 'No Grant', capsule: { collection: CAPSULE_3, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '99', artist: ADMIN, weight: 1, supply: 0 }], splitRecipients: [ADMIN],
  } })
  check('it publishes (grants are checked live at play, not at publish)', noGrant.status === 200 && noGrant.json.machine.state === 'live')
  const pN = await call('/api/experience/play', { method: 'POST', body: { machineId: 'no-grant', txHash: TX_N, account: PLAYER, unitIndex: 0 } })
  check('the play pends with NO prize rather than minting without authority', pN.json?.pending === true && pN.json.claim.prize === null, JSON.stringify(pN.json))
  await sleep(400)
  const claimsN = await call(`/api/experience/claims?machineId=no-grant&account=${PLAYER}`)
  check('the stalled claim is indexed even though delivery never ran', claimsN.json?.claims?.length === 1 && claimsN.json.claims[0].unresolved === true)
  chain.perms.set(key(POOL, 99, OPERATOR), 4n)
  const rN = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'no-grant', txHash: TX_N, unitIndex: 0 } })
  check('after the artist grants, resume draws the owed artwork', !!rN.json?.claim?.prize && rN.json.claim.prize.tokenId === '99', JSON.stringify(rN.json))

  // ═══ 7. review and promotion ═══════════════════════════════════════════════
  console.log('\n7. a creator machine goes through review')
  const rev = await call('/api/experience/machines', { method: 'POST', user: USER_TOKEN, body: {
    id: 'field-recordings', name: 'Field Recordings', capsule: { collection: CAPSULE_2, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '8', artist: CREATOR2, weight: 1, supply: 0 }], splitRecipients: [CREATOR2],
  } })
  check('a non-admin publish lands in review', rev.status === 200 && rev.json.machine.state === 'review', JSON.stringify(rev.json))
  check('a reviewed machine is not public', (await call('/api/experience/machines/field-recordings')).status === 404)
  check('nor is its page', (await call('/experience/field-recordings')).status === 404)
  check('the review API needs the admin cookie', (await call('/api/admin/experience?state=review')).status === 401)
  const queue = await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })
  check('the queue shows it with a live solvency verdict', queue.status === 200 && queue.json.machines.length === 1 && queue.json.machines[0].problems.length === 0, JSON.stringify(queue.json).slice(0, 300))
  const promote = await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'live' } })
  check('the curator promotes it', promote.status === 200 && promote.json.machine.state === 'live')
  check('and it is public now', (await call('/api/experience/machines/field-recordings')).status === 200)
  const list = await call('/api/experience/machines')
  check('the public list carries every live machine', list.json.machines.map((m) => m.id).sort().join(',') === 'field-recordings,no-grant,spring-season')

  // ═══ 8. the daily commitment cron ══════════════════════════════════════════
  console.log('\n8. the daily commitment cron')
  check('the cron refuses without its secret', (await call('/api/cron/experience-seeds')).status === 401)
  const cron = await call(`/api/cron/experience-seeds?secret=${CRON_SECRET}`)
  check('it commits for every live machine', cron.status === 200 && cron.json.committed === 3 && cron.json.failed.length === 0, JSON.stringify(cron.json))
  const tomorrow = dayShift(today, 1)
  check("every live machine now holds tomorrow's seed", ['spring-season', 'no-grant', 'field-recordings'].every((id) => strings.has(`kismetart:xp:${id}:seed:${tomorrow}`)))
  const before = strings.get(`kismetart:xp:spring-season:seed:${today}`)
  await call(`/api/cron/experience-seeds?secret=${CRON_SECRET}`)
  check('running it again rotates nothing', strings.get(`kismetart:xp:spring-season:seed:${today}`) === before)
} catch (err) {
  console.log(`  FAIL  harness threw — ${err?.stack ?? err}`)
  failures++
} finally {
  shutdown()
}

if (unsupported.size) console.log(`\n(mock redis saw unsupported commands: ${[...unsupported].join(', ')})`)
if (failures > 0 && /error|Error/.test(serverLog)) console.log('\n--- server log (tail) ---\n' + serverLog.slice(-3000))
console.log(failures > 0 ? `\n${failures} FAILURE(S)\n` : '\nAll end-to-end checks pass.\n')
process.exit(failures > 0 ? 1 : 0)
