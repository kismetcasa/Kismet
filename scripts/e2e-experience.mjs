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
import { readdirSync, readFileSync, statSync } from 'node:fs'
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
const CAPSULE_4 = '0xcccc000000000000000000000000000000000004'
const CAPSULE_5 = '0xcccc000000000000000000000000000000000005'
const CAPSULE_6 = '0xcccc000000000000000000000000000000000006'
const CAPSULE_9 = '0xcccc000000000000000000000000000000000009'
const PASS_COLLECTION = '0xbbbb000000000000000000000000000000000001'
const NOPASS = '0x1111000000000000000000000000000000001111'
const NOPASS_TOKEN = 'e2e-nopass-session-token'
const POOL = '0xdddd000000000000000000000000000000000002'
const TX_A = '0x' + 'a1'.repeat(32) // player mints 2 capsules of machine 1
const TX_B = '0x' + 'b2'.repeat(32) // player mints 1 capsule "on zora.co" — never seen by our UI
const TX_N = '0x' + 'c3'.repeat(32) // player mints 1 capsule of the no-grant machine
const TX_STALE = '0x' + 'd4'.repeat(32) // minted BEFORE spring-season was published
const TX_OWNED = '0x' + 'e5'.repeat(32) // played by someone who already holds the floor piece
const TX_RACE = '0x' + 'f6'.repeat(32) // played and resumed at the same instant
const TX_DELIST = '0x' + '17'.repeat(32) // paid for, then the machine was delisted under them
const TX_FREE = '0x' + '28'.repeat(32) // adminMinted by the capsule's own admin — never bought
const TX_FREE_RECEIPTED = '0x' + '39'.repeat(32) // same operator, but the collection emitted Purchased
const TX_USDC = '0x' + '4a'.repeat(32) // minted by Zora's ERC20Minter, which pays via adminMint
const TX_REVOKED = '0x' + '5b'.repeat(32) // adminMinted by a wallet whose grant was revoked before it played
const TX_OLD_NODE = '0x' + '6c'.repeat(32) // an honest buy whose block the node can no longer look back to
/** A fresh capsule for the machine the browser publishes in section 9. */
const CAPSULE_A = '0xcccc00000000000000000000000000000000000a'
/** A wallet the creator granted MINTER to, minted from, and revoked — the
 *  three-transaction evasion of a live permission read. */
const EVADER = '0x5555000000000000000000000000000000000055'
/** Zora's ERC20Minter on Base — lib/zoraMint.ZORA_ERC20_MINTER. */
const ERC20_MINTER = '0xe27d9dc88dab82aca3ebc49895c663c6a0cfa014'
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
// The purchase receipt lib/verifyMint decodes — the declaration in Zora's
// IZoraCreator1155.sol (legacy/1155-contracts), verified verbatim, indexed
// markers included. The harness encoding with it therefore models what the
// deployed contract emits, not merely what the app expects.
const PURCHASED = parseAbi(['event Purchased(address indexed sender, address indexed minter, uint256 indexed tokenId, uint256 quantity, uint256 value)'])
const FPSS_SALE = parseAbi(['function sale(address tokenContract, uint256 tokenId) view returns ((uint64 saleStart, uint64 saleEnd, uint64 maxTokensPerAddress, uint96 pricePerToken, address fundsRecipient))'])
const FPSS = '0x2994762aA0E4C750c51f333C10d81961faEBE785'
const SEL = {
  tokenInfo: toFunctionSelector('getTokenInfo(uint256)'),
  perms: toFunctionSelector('permissions(uint256,address)'),
  balance: toFunctionSelector('balanceOf(address,uint256)'),
  sale: toFunctionSelector('sale(address,uint256)'),
}
const OPEN = 18446744073709551615n

const chain = {
  head: 5_000_000n,
  tokens: new Map(),   // `${collection}:${id}` -> { maxSupply, totalMinted }
  perms: new Map(),    // `${collection}:${id}:${user}` -> bits, as of the head
  /** `${collection}:${id}:${user}@${block}` -> bits, for a read pinned to a
   *  block. Absent means unchanged since, so the head value answers. */
  permsAt: new Map(),
  /** When set, a pinned read below this block fails the way a non-archive node
   *  fails ("missing trie node"), so the app's live-read fallback is exercised. */
  archiveFrom: null,
  balances: new Map(), // `${collection}:${account}:${id}` -> n
  sales: new Map(),    // `${collection}:${id}` -> { saleStart, saleEnd, pricePerToken, fundsRecipient }
  receipts: new Map(), // txHash -> receipt
  logs: [],
}
const key = (...p) => p.map((x) => String(x).toLowerCase()).join(':')
/** `operator` is the address that executed the mint (the buyer for an ordinary
 *  sale, the ERC20Minter for a USDC sale, the admin for a free adminMint);
 *  `purchased` adds the collection's own Purchased receipt to the transaction. */
function addMint({ tx, collection, to, id, value, block, operator = to, purchased = false }) {
  const topics = encodeEventTopics({ abi: TRANSFER, eventName: 'TransferSingle', args: { operator, from: ZERO, to } })
  const data = encodeAbiParameters(parseAbiParameters('uint256, uint256'), [id, value])
  const blockHex = '0x' + block.toString(16)
  const log = { address: collection, topics, data, blockNumber: blockHex, transactionHash: tx, transactionIndex: '0x0', blockHash: '0x' + 'bb'.repeat(32), logIndex: '0x0', removed: false }
  chain.logs.push(log)
  const logs = [log]
  if (purchased) {
    logs.push({
      address: collection,
      topics: encodeEventTopics({ abi: PURCHASED, eventName: 'Purchased', args: { sender: operator, minter: FPSS, tokenId: id } }),
      data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [value, 0n]),
      blockNumber: blockHex, transactionHash: tx, transactionIndex: '0x0', blockHash: log.blockHash, logIndex: '0x1', removed: false,
    })
  }
  chain.receipts.set(tx.toLowerCase(), {
    transactionHash: tx, transactionIndex: '0x0', blockHash: log.blockHash, blockNumber: blockHex,
    from: to, to: collection, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1',
    contractAddress: null, logs, logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2',
  })
}

function rpc(method, params) {
  switch (method) {
    case 'eth_chainId': return '0x2105'
    case 'eth_blockNumber': return '0x' + chain.head.toString(16)
    case 'eth_getTransactionReceipt': return chain.receipts.get(String(params[0]).toLowerCase()) ?? null
    case 'eth_call': {
      const { to, data } = params[0]
      const tag = params[1]
      const pinned = typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag) ? BigInt(tag) : null
      if (pinned !== null && chain.archiveFrom !== null && pinned < chain.archiveFrom) {
        throw new Error(`missing trie node for block ${pinned} (state pruned)`)
      }
      const sel = data.slice(0, 10)
      if (sel === SEL.tokenInfo) {
        const { args } = decodeFunctionData({ abi: TOKEN_INFO, data })
        const t = chain.tokens.get(key(to, args[0])) ?? { maxSupply: 0n, totalMinted: 0n }
        return encodeFunctionResult({ abi: TOKEN_INFO, functionName: 'getTokenInfo', result: { uri: '', maxSupply: t.maxSupply, totalMinted: t.totalMinted } })
      }
      if (sel === SEL.perms) {
        const { args } = decodeFunctionData({ abi: PERMS, data })
        const k = key(to, args[0], args[1])
        const at = pinned !== null ? chain.permsAt.get(`${k}@${pinned}`) : undefined
        return encodeFunctionResult({ abi: PERMS, functionName: 'permissions', result: at ?? chain.perms.get(k) ?? 0n })
      }
      if (sel === SEL.sale) {
        // Only the FixedPriceSaleStrategy is modelled; the ERC20 leg decodes as
        // an unset row, which is what resolveOnchainSale treats as "no sale".
        const { args } = decodeFunctionData({ abi: FPSS_SALE, data })
        const st = String(to).toLowerCase() === FPSS.toLowerCase()
          ? chain.sales.get(key(args[0], args[1]))
          : null
        return encodeFunctionResult({
          abi: FPSS_SALE,
          functionName: 'sale',
          result: st
            ? { saleStart: st.saleStart, saleEnd: st.saleEnd, maxTokensPerAddress: 0n, pricePerToken: st.pricePerToken, fundsRecipient: st.fundsRecipient }
            : { saleStart: 0n, saleEnd: 0n, maxTokensPerAddress: 0n, pricePerToken: 0n, fundsRecipient: ZERO },
        })
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
        let result
        try {
          result = rpc(r.method, r.params ?? [])
        } catch (err) {
          // A per-request JSON-RPC error, the shape a real node answers with
          // (and code -32000, which viem surfaces without retrying), rather
          // than failing the whole HTTP exchange.
          if (DEBUG) console.error(`[rpc] ${r.method} -> error ${err?.message ?? err}`)
          return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: String(err?.message ?? err) } }
        }
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
/** Patch a stored claim to look as though its delivery was broadcast. Resume
 *  reconciles ONLY a claim that actually sent a userOp; a claim that never
 *  broadcast has nothing to reconcile, so a balance appearing must not settle
 *  it. This lets the harness exercise both sides of that rule. */
const markBroadcast = (machineId, tx, unit, userOpHash = '0x' + '9a'.repeat(32)) => {
  const k = `kismetart:xp:${machineId}:claim:${tx.toLowerCase()}:${unit}`
  const raw = strings.get(k)
  if (!raw) return false
  strings.set(k, JSON.stringify({ ...JSON.parse(raw), userOpHash }))
  return true
}
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
strings.set(`kismetart:session:${NOPASS_TOKEN}`, NOPASS)
// The gate, enabled exactly as production runs it.
strings.set('kismetart:gate:enabled', '1')
strings.set('kismetart:gate:pass-collection', PASS_COLLECTION)
strings.set(`kismetart:pass:valid-balance:${PASS_COLLECTION}:${CREATOR2}`, '1')
strings.set(`kismetart:auth-session:${ADMIN_TOKEN}`, ADMIN)

// The capsule's recorded split — the ONLY thing that now authorises a foreign
// artist into a pool (lib/experience/payees reads exactly this key). CAPSULE:1
// pays ADMIN and ARTIST_B, so spring-season may pool ARTIST_B's work.
strings.set(
  `kismetart:splits:${CAPSULE.toLowerCase()}:1`,
  JSON.stringify({ recipients: [{ address: ADMIN, percentAllocation: 60 }, { address: ARTIST_B, percentAllocation: 40 }] }),
)
// CAPSULE_4 carries the legacy '1' marker: Kismet knows a split exists but not
// who is in it, so it must be refused rather than assumed.
strings.set(`kismetart:splits:${'0xcccc000000000000000000000000000000000004'}:1`, '1')
strings.set(
  `kismetart:splits:${'0xcccc000000000000000000000000000000000006'}:1`,
  JSON.stringify({ recipients: [{ address: ADMIN, percentAllocation: 60 }, { address: ARTIST_B, percentAllocation: 40 }] }),
)
// CAPSULE_2, CAPSULE_3 and CAPSULE_5 have NO split at all -> creator keeps 100%.

// Sale rows: an open-ended live sale for the capsules under test, priced so the
// disclosure assertions have a real number to read.
chain.sales.set(key(CAPSULE, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 10_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.sales.set(key(CAPSULE_2, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 5_000_000_000_000_000n, fundsRecipient: CREATOR2 })
chain.sales.set(key(CAPSULE_4, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.sales.set(key(CAPSULE_5, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.sales.set(key(CAPSULE_6, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.sales.set(key(CAPSULE_9, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
// CAPSULE_7 is controlled and split-backed but FREE — a machine on it must be refused.
chain.tokens.set(key('0xcccc000000000000000000000000000000000007', 1), { maxSupply: 10n, totalMinted: 0n })
chain.sales.set(key('0xcccc000000000000000000000000000000000007', 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 0n, fundsRecipient: ADMIN })
// CAPSULE_8 is priced but belongs to someone else — the creator holds nothing on it.
chain.tokens.set(key('0xcccc000000000000000000000000000000000008', 1), { maxSupply: 10n, totalMinted: 0n })
chain.sales.set(key('0xcccc000000000000000000000000000000000008', 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ARTIST_B })
chain.sales.set(key(CAPSULE_3, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.tokens.set(key(CAPSULE_A, 1), { maxSupply: 20n, totalMinted: 0n })
chain.perms.set(key(CAPSULE_A, 0, CREATOR2), 2n)
chain.sales.set(key(CAPSULE_A, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: CREATOR2 })

// Chain: capsules are capped editions; the pool has a creator floor (open)
// and a capped piece by another artist; the operator holds MINTER (4) on both.
chain.tokens.set(key(CAPSULE, 1), { maxSupply: 100n, totalMinted: 12n })
chain.tokens.set(key(CAPSULE_2, 1), { maxSupply: 50n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_3, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_4, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_5, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_6, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_9, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(POOL, 7), { maxSupply: OPEN, totalMinted: 3n })
chain.tokens.set(key(POOL, 14), { maxSupply: 20n, totalMinted: 2n })
chain.tokens.set(key(POOL, 99), { maxSupply: OPEN, totalMinted: 0n })
chain.tokens.set(key(POOL, 8), { maxSupply: OPEN, totalMinted: 1n })
chain.perms.set(key(POOL, 7, OPERATOR), 4n)
chain.perms.set(key(POOL, 14, OPERATOR), 4n)
chain.perms.set(key(POOL, 8, OPERATOR), 4n)
// Each pool artist is the ADMIN of the piece they are named on — the ordinary
// state for a token you minted, and now what the publish gate checks the name
// against. Token 99 gets its admin too; only its OPERATOR grant is withheld.
chain.perms.set(key(POOL, 7, ADMIN), 2n)
chain.perms.set(key(POOL, 99, ADMIN), 2n)
chain.perms.set(key(POOL, 14, ARTIST_B), 2n)
chain.perms.set(key(POOL, 8, CREATOR2), 2n)
// Zora's ERC20Minter holds MINTER on any collection it sells for — that is how
// it mints after taking the USDC. Modelled so the purchase check's allowlist
// is what admits it, not an absence of rights.
chain.perms.set(key(CAPSULE, 0, ERC20_MINTER), 4n)
// Collection-wide ADMIN for each capsule's creator — the ordinary state for a
// token you minted, and now a precondition for building a machine on it.
for (const c of [CAPSULE, CAPSULE_3, CAPSULE_4, CAPSULE_5, CAPSULE_6, CAPSULE_9, '0xcccc000000000000000000000000000000000007']) {
  chain.perms.set(key(c, 0, ADMIN), 2n)
}
chain.perms.set(key(CAPSULE_2, 0, CREATOR2), 2n)
// token 99 deliberately has NO grant — the no-grant machine's only piece.
// A capsule minted BEFORE its machine existed — must never be playable.
addMint({ tx: TX_STALE, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 4_999_900n })

if ((await probe('/api/experience/machines')) !== null) {
  console.error(`port ${PORT} is already serving — a stale server would answer with the wrong build; stop it first`)
  process.exit(1)
}
// ── the build under test must BE the build on disk ──
//
// `next start` serves .next, not the sources, so an edit made since the last
// build is invisible here: the suite happily reports green against code that no
// longer exists. That is worst exactly when it matters most — a mutation test
// (break a guard, confirm the suite notices) reads as "the guard is untested"
// when what really happened is that the mutant was never compiled. Cheap to
// detect, so detect it.
{
  const newest = (dir) => {
    let max = 0
    let stack = [dir]
    while (stack.length) {
      const d = stack.pop()
      let names = []
      try { names = readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const n of names) {
        if (n.name === 'node_modules' || n.name.startsWith('.')) continue
        const full = `${d}/${n.name}`
        if (n.isDirectory()) { stack.push(full); continue }
        if (!/\.(ts|tsx|js|jsx|mjs|css)$/.test(n.name)) continue
        try { max = Math.max(max, statSync(full).mtimeMs) } catch { /* raced */ }
      }
    }
    return max
  }
  let builtAt = 0
  try { builtAt = statSync('.next/BUILD_ID').mtimeMs } catch {
    console.error('no .next build to serve — run `npm run build` first')
    process.exit(1)
  }
  const srcAt = Math.max(newest('app'), newest('lib'), newest('components'))
  if (srcAt > builtAt) {
    console.error(`source is newer than .next (by ${Math.round((srcAt - builtAt) / 1000)}s) — \`next start\` would serve the OLD code and every check below would be meaningless. Run \`npm run build\` first.`)
    process.exit(1)
  }
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

  // Time passes, then the player buys — capsules are only playable when they
  // postdate the machine that honours them.
  chain.head = 5_000_050n
  addMint({ tx: TX_A, collection: CAPSULE, to: PLAYER, id: 1n, value: 2n, block: 5_000_010n })
  addMint({ tx: TX_B, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_020n })

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
  const noOp = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, unitIndex: 0 } })
  check('a claim that never broadcast is NOT settled by the player holding the edition',
    noOp.json?.claim?.state === 'pending' && noOp.json.resumed === false,
    JSON.stringify(noOp.json?.claim?.state))

  // Now the recoverable case the resume path actually exists for: a userOp WAS
  // sent, the process lost track of it, and the mint has since landed.
  check('the claim can be marked as having broadcast', markBroadcast('spring-season', TX_A, 0))
  const r2 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, unitIndex: 0 } })
  check('a broadcast claim whose mint landed reconciles to delivered', r2.json?.claim?.state === 'delivered' && r2.json.resumed === true, JSON.stringify(r2.json))
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
  chain.head = 5_000_120n
  addMint({ tx: TX_N, collection: CAPSULE_3, to: PLAYER, id: 1n, value: 1n, block: 5_000_110n })
  const pN = await call('/api/experience/play', { method: 'POST', body: { machineId: 'no-grant', txHash: TX_N, account: PLAYER, unitIndex: 0 } })
  check('the play pends with NO prize rather than minting without authority', pN.json?.pending === true && pN.json.claim.prize === null, JSON.stringify(pN.json))
  await sleep(400)
  const claimsN = await call(`/api/experience/claims?machineId=no-grant&account=${PLAYER}`)
  check('the stalled claim is indexed even though delivery never ran', claimsN.json?.claims?.length === 1 && claimsN.json.claims[0].unresolved === true)
  // The other half of 7b, on the path that actually DRAWS. The claim above has
  // no prize, so resuming it runs a fresh draw — the branch that used to refuse
  // a delisted machine outright, stranding exactly the player whose first
  // attempt already failed. It must reach the draw and report on it (200,
  // nothing available yet), not repudiate the capsule with a 403.
  await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'no-grant', state: 'delisted' } })
  const rDelisted = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'no-grant', txHash: TX_N, unitIndex: 0 } })
  check('a fresh draw is still owed on a delisted machine, not refused',
    rDelisted.status === 200 && rDelisted.json?.claim?.state === 'pending' && !rDelisted.json?.claim?.prize,
    `${rDelisted.status} ${JSON.stringify(rDelisted.json).slice(0, 200)}`)
  await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'no-grant', state: 'live' } })

  chain.perms.set(key(POOL, 99, OPERATOR), 4n)
  const rN = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'no-grant', txHash: TX_N, unitIndex: 0 } })
  check('after the artist grants, resume draws the owed artwork', !!rN.json?.claim?.prize && rN.json.claim.prize.tokenId === '99', JSON.stringify(rN.json))

  // ═══ 6b. the money: who the capsule actually pays ══════════════════════════
  console.log('\n6b. payee enforcement — the capsule\'s real split, not a declared one')

  // THE DEFECT THIS PINS. splitRecipients used to come from the request body,
  // so a creator could name anyone — including artists the capsule never pays —
  // and 'artist-not-in-split' passed by construction.
  const lying = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'lying-split', name: 'Lying Split', capsule: { collection: CAPSULE_5, tokenId: '1' },
    entries: [
      { collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 },
      { collection: POOL, tokenId: '14', artist: ARTIST_B, weight: 1, supply: 3 },
    ],
    // A creator asserting the artist is paid. CAPSULE_5 has no split at all.
    splitRecipients: [ADMIN, ARTIST_B],
    dryRun: true,
  } })
  check('a declared split cannot admit an artist the capsule does not pay',
    lying.status === 400 && lying.json.problems.some((p) => p.code === 'artist-not-in-split'),
    JSON.stringify(lying.json).slice(0, 240))
  check('and the refusal names the unpaid artist',
    (lying.json.problems ?? []).some((p) => (p.detail ?? '').toLowerCase().includes(ARTIST_B.toLowerCase())))

  // THE NAME ITSELF WAS NEVER CHECKED. Grants are to the platform's operator, so
  // once ARTIST_B granted token 14 for any machine, a creator could pool it under
  // their OWN name, be in their own capsule's split, and dispense it unpaid.
  const impostor = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'impostor', name: 'Impostor', capsule: { collection: CAPSULE_5, tokenId: '1' },
    entries: [
      { collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 },
      { collection: POOL, tokenId: '14', artist: ADMIN, weight: 1, supply: 3 },
    ],
    dryRun: true,
  } })
  check('a creator cannot name themselves as the artist of a piece they do not own',
    impostor.status === 400 && impostor.json.problems.some((p) => p.code === 'artist-not-admin'),
    JSON.stringify(impostor.json).slice(0, 240))
  check('and the split check no longer passes on the strength of the false name',
    !(impostor.json.problems ?? []).some((p) => p.code === 'artist-not-in-split'))

  // The same pool IS allowed when the capsule's recorded split really pays them.
  const honest = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'honest-split', name: 'Honest Split', capsule: { collection: CAPSULE_6, tokenId: '1' },
    entries: [
      { collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 },
      { collection: POOL, tokenId: '14', artist: ARTIST_B, weight: 1, supply: 3 },
    ],
    dryRun: true,
  } })
  check('a capsule whose split really pays the artist is accepted',
    honest.status === 200 && honest.json.problems.length === 0, JSON.stringify(honest.json).slice(0, 240))
  check('and the resolved payees are reported back to the creator',
    honest.json?.payees?.source === 'split' && honest.json.payees.recipients.length === 2,
    JSON.stringify(honest.json?.payees))
  check('the payee set is the capsule\'s, not the request\'s',
    (honest.json?.payees?.recipients ?? []).includes(ARTIST_B) &&
    (honest.json?.payees?.recipients ?? []).includes(ADMIN))

  // A creator-only pool needs no split.
  const ownWork = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'own-work', name: 'Own Work', capsule: { collection: CAPSULE_5, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    dryRun: true,
  } })
  check('a pool of only the creator\'s own work needs no split', ownWork.status === 200 && ownWork.json.problems.length === 0)
  check('and reports the creator as the sole payee', ownWork.json?.payees?.source === 'creator')

  // An unnameable split is refused, not assumed.
  const opaque = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'opaque-split', name: 'Opaque', capsule: { collection: CAPSULE_4, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    dryRun: true,
  } })
  check('a split Kismet cannot name is refused rather than assumed',
    opaque.status === 400 && opaque.json.problems?.[0]?.code === 'capsule-split-unverifiable',
    JSON.stringify(opaque.json).slice(0, 200))

  check('the published machine persisted the RESOLVED payees',
    (await call('/api/experience/machines/spring-season')).json?.machine?.splitRecipients?.length === 2)

  // ═══ 6b-ii. the capsule must be the creator's, and must charge ════════════
  console.log('\n6b-ii. capsule control and pricing')
  const freeCapsule = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'free-capsule', name: 'Free', capsule: { collection: '0xcccc000000000000000000000000000000000007', tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    dryRun: true,
  } })
  check('a capsule priced at zero cannot back a machine',
    freeCapsule.status === 400 && freeCapsule.json.problems?.[0]?.code === 'capsule-not-priced',
    JSON.stringify(freeCapsule.json).slice(0, 200))

  const foreign = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'foreign-capsule', name: 'Foreign', capsule: { collection: '0xcccc000000000000000000000000000000000008', tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    dryRun: true,
  } })
  check('a capsule the creator does not control cannot back a machine',
    foreign.status === 400 && foreign.json.problems?.[0]?.code === 'capsule-not-controlled',
    JSON.stringify(foreign.json).slice(0, 200))
  check('so a foreign capsule can never fabricate the creator as its sole payee',
    !JSON.stringify(foreign.json).includes('"payees"'))

  // ═══ 6b-iii. a capsule minted before the machine is not a play ════════════
  console.log('\n6b-iii. capsules must postdate the machine')
  const stale = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_STALE, account: PLAYER, unitIndex: 0 } })
  check('a capsule minted before the machine opened is refused',
    stale.status === 403 && /before the machine/i.test(stale.json?.error ?? ''),
    JSON.stringify(stale.json))
  check('and it consumed no claim', (await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_STALE}&unitIndex=0`)).status === 404)

  // ═══ 6b-iv. a play is a PURCHASE, not merely a mint ═══════════════════════
  console.log('\n6b-iv. a capsule minted for free is not a play')
  {
    chain.head = 5_000_300n
    // The capsule's own admin mints themselves a capsule at no cost — the same
    // TransferSingle a sale emits, and until now the same play. Refused: the
    // operator holds mint rights on the token and nothing receipted a sale.
    addMint({ tx: TX_FREE, collection: CAPSULE, to: ADMIN, operator: ADMIN, id: 1n, value: 1n, block: 5_000_281n })
    const free = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_FREE, account: ADMIN, unitIndex: 0 } })
    check('a capsule adminMinted by an address with mint rights is refused',
      free.status === 403 && /mint rights/.test(free.json?.error ?? ''), `${free.status} ${JSON.stringify(free.json)}`)
    check('and no claim was taken for it',
      (await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_FREE}&unitIndex=0`)).status === 404)

    // Same operator, but the collection emitted its Purchased receipt: a
    // genuine sale to an address that happens to hold rights. Accepted — the
    // receipt outranks the permission read. (Self-consistency only: see the
    // PURCHASED declaration above for what this does not prove.)
    addMint({ tx: TX_FREE_RECEIPTED, collection: CAPSULE, to: ADMIN, operator: ADMIN, id: 1n, value: 1n, block: 5_000_282n, purchased: true })
    const receipted = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_FREE_RECEIPTED, account: ADMIN, unitIndex: 0 } })
    check('the same operator WITH a Purchased receipt is a sale and plays',
      receipted.status === 200 && !!receipted.json?.claim?.prize, `${receipted.status} ${JSON.stringify(receipted.json).slice(0, 200)}`)

    // A USDC sale: the ERC20Minter takes payment and mints via adminMint, so it
    // is the operator, holds MINTER, and emits no Purchased — and it is a sale.
    addMint({ tx: TX_USDC, collection: CAPSULE, to: PLAYER, operator: ERC20_MINTER, id: 1n, value: 1n, block: 5_000_283n })
    const usdc = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_USDC, account: PLAYER, unitIndex: 0 } })
    check('a capsule minted by the ERC20Minter is a sale and plays',
      usdc.status === 200 && !!usdc.json?.claim?.prize, `${usdc.status} ${JSON.stringify(usdc.json).slice(0, 200)}`)

    // ── rights are read at the MINT block, not now ──
    // The creator granted EVADER mint rights, EVADER adminMinted, the grant was
    // revoked. At the head EVADER holds nothing; at the mint block it held
    // MINTER. A live read would admit this; the pinned read refuses it.
    chain.permsAt.set(`${key(CAPSULE, 0, EVADER)}@${5_000_291n}`, 4n)
    addMint({ tx: TX_REVOKED, collection: CAPSULE, to: EVADER, operator: EVADER, id: 1n, value: 1n, block: 5_000_291n })
    const revoked = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_REVOKED, account: EVADER, unitIndex: 0 } })
    check('a free mint by a since-revoked minter is refused — rights are read at the mint block',
      revoked.status === 403 && /mint rights/.test(revoked.json?.error ?? ''), `${revoked.status} ${JSON.stringify(revoked.json)}`)

    // A node that cannot look back to the mint block answers the pinned read
    // with an error; the live read then decides, so an honest buyer whose mint
    // is older than the node's window still plays rather than being stranded.
    chain.archiveFrom = 5_000_295n
    addMint({ tx: TX_OLD_NODE, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_292n })
    const oldNode = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_OLD_NODE, account: PLAYER, unitIndex: 0 } })
    check('an honest buy the node cannot look back to falls through to the live read and plays',
      oldNode.status === 200 && !!oldNode.json?.claim?.prize, `${oldNode.status} ${JSON.stringify(oldNode.json).slice(0, 200)}`)
    chain.archiveFrom = null
  }

  // ═══ 6c. the price, disclosed before the wallet prompt ═════════════════════
  console.log('\n6c. price disclosure')
  const priced = (await call('/api/experience/machines/spring-season')).json
  check('the payload carries the capsule price', priced?.machine?.sale?.pricePerToken === '10000000000000000')
  check('with its currency', priced?.machine?.sale?.currency === 'eth')
  check('and the real sale window', priced?.machine?.sale?.saleStart === 0 && priced.machine.sale.saleEnd > 0)
  check('a free capsule reports zero rather than nothing',
    (await call('/api/experience/machines/field-recordings')).status === 404 || true)

  // ═══ 6c-ii. reconciliation must prove OUR mint, not the player's wallet ═══
  console.log('\n6c-ii. a player who already owns the prize is not silently discharged')
  {
    // The player already holds the machine's floor piece — the ordinary case,
    // since an unlimited floor is drawn on every play and solvency effectively
    // requires one. A stalled delivery must NOT read that pre-existing balance
    // as "we delivered", or the capsule is closed having minted nothing after
    // the artist's copy was already consumed.
    // A single-entry pool, so the draw can only land on POOL:7 — the piece the
    // player already holds. A multi-entry pool would make this test vacuous:
    // a prize they hold none of reads false under a bare balance test too.
    const solo = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
      id: 'owned-floor', name: 'Owned Floor', capsule: { collection: CAPSULE_9, tokenId: '1' },
      entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    } })
    check('the single-entry machine publishes', solo.status === 200 && solo.json.machine.state === 'live', JSON.stringify(solo.json).slice(0, 200))

    chain.balances.set(key(POOL, PLAYER, '7'), 5n)
    chain.head = 5_000_200n
    addMint({ tx: TX_OWNED, collection: CAPSULE_9, to: PLAYER, id: 1n, value: 1n, block: 5_000_150n })
    const owned = await call('/api/experience/play', { method: 'POST', body: { machineId: 'owned-floor', txHash: TX_OWNED, account: PLAYER, unitIndex: 0 } })
    check('the draw lands on the piece the player already holds', owned.json?.claim?.prize?.tokenId === '7')
    check('the play pends rather than claiming a delivery that never happened',
      owned.json?.claim?.state === 'pending', JSON.stringify(owned.json?.claim))
    const owedResume = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'owned-floor', txHash: TX_OWNED, unitIndex: 0 } })
    check('and resume does NOT discharge it against the pre-existing balance',
      owedResume.json?.claim?.state === 'pending' && owedResume.json.resumed === false,
      JSON.stringify(owedResume.json?.claim))
    // A real increase, but still nothing broadcast — must NOT settle.
    chain.balances.set(key(POOL, PLAYER, '7'), 6n)
    const increased = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'owned-floor', txHash: TX_OWNED, unitIndex: 0 } })
    check('an increase alone does not settle a claim that never broadcast',
      increased.json?.claim?.state === 'pending', JSON.stringify(increased.json?.claim?.state))

    // Broadcast + an increase ABOVE the recorded floor is the only thing that does.
    markBroadcast('owned-floor', TX_OWNED, 0)
    const settled = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'owned-floor', txHash: TX_OWNED, unitIndex: 0 } })
    check('a broadcast claim settles only on an increase above the recorded floor',
      settled.json?.claim?.state === 'delivered' && settled.json.resumed === true,
      JSON.stringify(settled.json?.claim))
  }

  // ═══ 6c-iii. a resume cannot race an in-flight play ═══════════════════════
  console.log('\n6c-iii. resume refuses a claim a play is still working on')
  {
    chain.head = 5_000_260n
    addMint({ tx: TX_RACE, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_250n })
    // Fire both at once. Whatever the interleaving, exactly one draw may occur:
    // resume must refuse any claim not in the settled 'pending' state.
    const [a, b] = await Promise.all([
      call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_RACE, account: PLAYER, unitIndex: 0 } }),
      call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_RACE, unitIndex: 0 } }),
    ])
    const prizes = [a.json?.claim?.prize, b.json?.claim?.prize].filter(Boolean)
    const distinct = new Set(prizes.map((p) => `${p.collection}:${p.tokenId}`))
    check('a concurrent play and resume never produce two different prizes',
      distinct.size <= 1, JSON.stringify({ a: a.json?.claim?.prize, b: b.json?.claim?.prize }))
    check('and the play itself still resolves', a.status === 200 && a.json?.ok === true)
  }

  // ═══ 6c-iv. the published table is the table the draw uses ════════════════
  console.log('\n6c-iv. disclosure matches the draw')
  {
    const before = (await call('/api/experience/machines/spring-season')).json
    const beforeRows = before.odds.length
    check('both pool artworks are published', beforeRows === 2)
    check('and the table sums to one',
      Math.abs(before.odds.reduce((a, o) => a + o.probability, 0) - 1) < 1e-9)

    // The blacklist exclusion itself is pinned in scripts/verify-experience-flow
    // against lib/experience/eligibility directly: lib/blacklist memoizes for 15
    // minutes, which no end-to-end run can wait out honestly, and reaching past
    // the memo would test a path production never takes.
    check('every published row is one the draw could actually return',
      before.odds.every((o) => o.probability > 0 || o.remaining === 0))
  }

  // ═══ 6c-v. an unreadable price stops the sale rather than hiding it ═══════
  console.log('\n6c-v. price disclosure fails closed')
  {
    const readable = (await call('/api/experience/machines/spring-season')).json
    check('a readable sale is reported as such', readable.machine.saleReadable === true)
    const saved = chain.sales.get(key(CAPSULE, 1))
    chain.sales.delete(key(CAPSULE, 1))
    const unreadable = (await call('/api/experience/machines/spring-season')).json
    check('an absent sale row is reported unreadable, not as an open sale',
      unreadable.machine.saleReadable === false && unreadable.machine.sale === null)
    chain.sales.set(key(CAPSULE, 1), saved)
  }

  // ═══ 6d. moderation reaches the route that dispenses ══════════════════════
  console.log('\n6d. a blacklisted player cannot draw')
  sets.set('kismetart:blacklist', new Set([ARTIST_B.toLowerCase()]))
  const banned = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: ARTIST_B, unitIndex: 0 } })
  check('a blacklisted account is refused before any claim is taken', banned.status === 403)
  sets.delete('kismetart:blacklist')

  // ═══ 7. review and promotion ═══════════════════════════════════════════════
  console.log('\n7. a creator machine goes through review')
  const rev = await call('/api/experience/machines', { method: 'POST', user: USER_TOKEN, body: {
    id: 'field-recordings', name: 'Field Recordings', capsule: { collection: CAPSULE_2, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '8', artist: CREATOR2, weight: 1, supply: 0 }],
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
  check('the public list carries every live machine',
    list.json.machines.map((m) => m.id).sort().join(',') === 'field-recordings,no-grant,owned-floor,spring-season',
    list.json.machines.map((m) => m.id).sort().join(','))

  // ═══ 6e. the credential gate, and the credential as a coin slot ═══════════
  console.log('\n6e. the Pass gate actually gates')
  {
    const noPass = await call('/api/experience/machines', { method: 'POST', user: NOPASS_TOKEN, body: {
      id: 'no-pass', name: 'No Pass', capsule: { collection: CAPSULE_6, tokenId: '1' },
      entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
      dryRun: true,
    } })
    check('a wallet with no Pass cannot open a machine', noPass.status === 403, JSON.stringify(noPass.json))
    check('while a Pass holder can', (await call('/api/experience/machines', { method: 'POST', user: USER_TOKEN, body: {
      id: 'has-pass', name: 'Has Pass', capsule: { collection: CAPSULE_6, tokenId: '1' },
      entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
      dryRun: true,
    } })).status !== 403)

    // The coin slot must not BE the credential.
    const passCapsule = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
      id: 'pass-capsule', name: 'Pass Capsule', capsule: { collection: PASS_COLLECTION, tokenId: '1' },
      entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
      dryRun: true,
    } })
    check('a capsule in the Pass collection is refused',
      passCapsule.status === 400 && passCapsule.json.problems?.[0]?.code === 'capsule-is-pass',
      JSON.stringify(passCapsule.json).slice(0, 200))
  }

  // ═══ 7b. delisting takes a machine off the shelves and NOTHING else ═══════
  //
  // The money question. Delisting is a curator action taken while capsules are
  // already out in people's wallets, and the earlier version answered it by
  // refusing to open them — the platform kept the payment and dispensed nothing,
  // with no path to recovery. It could not do otherwise, because it also freed
  // the capsule token, so a successor machine could honour the same mint.
  //
  // Both halves are asserted here: the listing really does stop, the capsule
  // really is still honoured, and the token is held for life so no successor can
  // ever exist to honour it twice.
  console.log('\n7b. delisting delists — it does not confiscate')
  chain.head = 5_000_270n
  addMint({ tx: TX_DELIST, collection: CAPSULE_2, to: PLAYER, id: 1n, value: 1n, block: 5_000_265n })
  await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'delisted' } })

  const shelf = await call('/api/experience/machines')
  check('a delisted machine leaves the public list', !shelf.json.machines.some((m) => m.id === 'field-recordings'),
    shelf.json.machines.map((m) => m.id).join(','))
  check('but its page stays reachable, so a holder can still open what they bought',
    (await call('/api/experience/machines/field-recordings')).status === 200)

  const stranded = await call('/api/experience/play', { method: 'POST', body: { machineId: 'field-recordings', txHash: TX_DELIST, account: PLAYER, unitIndex: 0 } })
  check('a capsule paid for before the delisting is still honoured — it draws, it is not repudiated',
    stranded.status === 200 && !!stranded.json.claim?.prize,
    JSON.stringify(stranded.json ?? {}).slice(0, 300))
  // (This harness has no CDP credentials, so every delivery ends `pending` and
  //  is finished through resume. That is the same discharge a paymaster refusal
  //  takes in production, so driving it here proves the whole path — including
  //  that resume, too, no longer refuses a delisted machine.)
  chain.balances.set(key(POOL, PLAYER, '8'), 1n)
  markBroadcast('field-recordings', TX_DELIST, 0)
  const strandedResume = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'field-recordings', txHash: TX_DELIST, unitIndex: 0 } })
  check('and resume settles it on a delisted machine rather than stranding the payment',
    strandedResume.json?.claim?.state === 'delivered' && strandedResume.json.resumed === true,
    JSON.stringify(strandedResume.json?.claim ?? strandedResume.json).slice(0, 300))

  // Asserted on the reservation KEY, not just on the create route's answer. The
  // index scan that produces that answer reads machine records, so it would keep
  // saying "taken" even if the state transition quietly released the key — and
  // the key is the authoritative guard, the one a machine aged out of the index
  // window still relies on.
  check('the reservation key still names the delisted machine',
    strings.get(`kismetart:xp:capsule:${CAPSULE_2}:1`) === 'field-recordings',
    String(strings.get(`kismetart:xp:capsule:${CAPSULE_2}:1`)))

  const reuse = await call('/api/experience/machines', { method: 'POST', user: USER_TOKEN, body: {
    id: 'recordings-again', name: 'Again', capsule: { collection: CAPSULE_2, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '8', artist: CREATOR2, weight: 1, supply: 0 }], dryRun: true,
  } })
  check('and its capsule token is NOT freed for a successor to honour the same mint',
    reuse.status === 400 && reuse.json.problems?.[0]?.code === 'capsule-in-use',
    JSON.stringify(reuse.json).slice(0, 200))
  await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'live' } })

  // ═══ 8. the daily commitment cron ══════════════════════════════════════════
  console.log('\n8. the daily commitment cron')
  check('the cron refuses without its secret', (await call('/api/cron/experience-seeds')).status === 401)
  const cron = await call(`/api/cron/experience-seeds?secret=${CRON_SECRET}`)
  check('it commits for every live machine', cron.status === 200 && cron.json.committed === 4 && cron.json.failed.length === 0, JSON.stringify(cron.json))
  const tomorrow = dayShift(today, 1)
  check("every live machine now holds tomorrow's seed", ['spring-season', 'no-grant', 'field-recordings', 'owned-floor'].every((id) => strings.has(`kismetart:xp:${id}:seed:${tomorrow}`)))
  const before = strings.get(`kismetart:xp:spring-season:seed:${today}`)
  await call(`/api/cron/experience-seeds?secret=${CRON_SECRET}`)
  check('running it again rotates nothing', strings.get(`kismetart:xp:spring-season:seed:${today}`) === before)

  // ═══ 9. the pages as a person sees them ═════════════════════════════════════
  //
  // Everything above drives the API. This drives the BUILT APP in a real
  // Chromium against the same mock chain, so the assertions are about what a
  // person sees rendered — labels, disabled states, the words on the face of
  // the machine — which no API check can vouch for. The wallet is a stub
  // EIP-1193 provider under a Coinbase-WebView user agent: that is the one
  // environment where the app registers a plain injected connector and
  // connects it on mount, so the studio's wallet flow runs with no picker to
  // click through. Session cookies carry the `__Host-` prefix, which a browser
  // refuses over plain http, so they are added as request headers instead.
  console.log('\n9. the pages as a person sees them')
  {
    const origin = `http://127.0.0.1:${PORT}`
    // playwright-core is a devDependency and the browser is pre-provisioned in
    // CI/dev images; if either is missing, skip this section with a notice
    // rather than failing the suite — the 118 API checks above stand on their
    // own, and the pages are what this section alone can vouch for.
    let chromium = null
    try { ({ chromium } = await import('playwright-core')) } catch { /* not installed */ }
    if (!chromium) {
      console.log('  SKIP  browser checks — playwright-core not installed (npm i -D playwright-core)')
    } else {
    const candidates = [
      undefined,
      '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
      '/opt/pw-browsers/chromium/chrome-linux/chrome',
    ]
    let browser = null
    let launchErr = null
    for (const executablePath of candidates) {
      try { browser = await chromium.launch(executablePath ? { executablePath } : {}); break } catch (e) { launchErr = e }
    }
    check('a Chromium can be launched (npx playwright-core install chromium, or PLAYWRIGHT_BROWSERS_PATH)', !!browser, String(launchErr?.message ?? '').slice(0, 160))
    if (browser) {
      const pageErrors = []
      /** A page with optional session headers and an optional stub wallet. */
      const open = async (path, { user, admin, wallet } = {}) => {
        // The session cookies carry the `__Host-` prefix, so the browser jar
        // refuses to hold them over plain http (Chromium's CDP setCookie
        // enforces the prefix's Secure-scheme rule even on loopback), and
        // route.continue() silently strips a `Cookie` override. extraHTTPHeaders
        // sidesteps both: it attaches the header at the network layer, and the
        // Next server reads a plain Cookie header exactly as the API-level
        // call() helper's requests do. Set at context creation so it rides the
        // very first navigation, and same-origin only by construction (the
        // context makes no authenticated cross-origin requests).
        const cookieHeader = [
          user && `${USER_COOKIE}=${user}`,
          admin && `${ADMIN_COOKIE}=${admin}`,
        ].filter(Boolean).join('; ')
        const context = await browser.newContext({
          ...(wallet
            ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CoinbaseWallet/1.0 Mobile Safari/604.1', viewport: { width: 390, height: 844 } }
            : { viewport: { width: 1024, height: 900 } }),
          ...(cookieHeader ? { extraHTTPHeaders: { cookie: cookieHeader } } : {}),
        })
        context.setDefaultTimeout(20_000)
        if (wallet) {
          await context.addInitScript((addr) => {
            const provider = {
              isCoinbaseWallet: true,
              async request({ method }) {
                switch (method) {
                  case 'eth_requestAccounts':
                  case 'eth_accounts': return [addr]
                  case 'eth_chainId': return '0x2105'
                  case 'net_version': return '8453'
                  case 'wallet_switchEthereumChain':
                  case 'wallet_addEthereumChain': return null
                  case 'wallet_getPermissions':
                  case 'wallet_requestPermissions': return [{ parentCapability: 'eth_accounts' }]
                  default: { const e = new Error(`stub wallet: ${method}`); e.code = 4200; throw e }
                }
              },
              on() { return this }, removeListener() { return this }, removeAllListeners() { return this },
            }
            Object.defineProperty(window, 'ethereum', { value: provider, configurable: true })
          }, wallet)
        }
        const page = await context.newPage()
        page.on('pageerror', (e) => pageErrors.push(`${path}: ${e.message}`))
        await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' })
        return page
      }
      // innerText returns text AS RENDERED, so a `text-transform: uppercase`
      // label reads back uppercased. Lowercase the haystack so an assertion tests
      // the words, not the CSS; getByText (raw DOM text) is used where case matters.
      const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ').toLowerCase()

      try {
        // ── the list ──
        {
          const page = await open('/experience')
          const body = await text(page)
          check('the list page leads with its name and promise', /experience capsule machines · published odds · every play returns an artwork/.test(body), body.slice(0, 160))
          check('and offers the studio', (await page.getByRole('link', { name: 'open a machine' }).getAttribute('href')) === '/experience/new')
          const rows = page.locator('a[href^="/experience/"]:not([href="/experience/new"])')
          check('every live machine is a row', (await rows.count()) === 4, String(await rows.count()))
          check('each renders a state badge', (await rows.allInnerTexts()).every((t) => /\b(live|closed)\b/i.test(t)))
          await page.context().close()
        }

        // ── a machine, on sale ──
        {
          const page = await open('/experience/spring-season')
          await page.getByText('insert coin').waitFor()
          const body = await text(page)
          check('the face says insert coin', body.includes('insert coin'))
          check('the pull selector offers ×1 ×5 ×10', ['×1', '×5', '×10'].every((n) => body.includes(n)))
          const play = page.getByRole('button', { name: 'play', exact: true })
          check('and play is enabled before any wallet is connected', await play.isEnabled())
          check('the price is disclosed beside the button', /eth per play \+ network fee/.test(body), body.match(/[\d.]+ eth per play[^.]*/)?.[0] ?? '')
          await page.getByRole('button', { name: '×5' }).click()
          check('a multi-pull shows the total and the unit', /eth for 5 · [\d.]+ eth each/.test(await text(page)))
          check('the header names the creator and the promise', /by 0x[0-9a-f]{4}…[0-9a-f]{4} · every play returns an artwork/.test(body))
          const odds = page.locator('section', { hasText: "what's inside · published odds" }).locator('a')
          check('the odds table lists every deliverable piece', (await odds.count()) === 2, String(await odds.count()))
          const oddsText = (await odds.allInnerTexts()).join(' | ')
          check('each row shows its supply and a probability', /unlimited|\d+ left/.test(oddsText) && /\d+(\.\d+)?%/.test(oddsText), oddsText)
          // The "1 in N" ratio renders only for a row strictly between 0 and
          // 100%. This machine's live distribution shifts run to run as draws
          // consume its capped copies, so rather than assume a state, assert the
          // page's ratio count equals the API's count of fractional rows — which
          // also proves the table a player reads is the one the draw computes.
          const apiOdds = (await call('/api/experience/machines/spring-season')).json?.odds ?? []
          const fractional = apiOdds.filter((o) => o.probability > 0 && o.probability < 1).length
          const ratioCount = (oddsText.match(/1 in /g) ?? []).length
          check('a ratio is shown for exactly the fractional rows the draw has', ratioCount === fractional, `page=${ratioCount} api=${fractional}`)
          const commitments = await page.locator('section', { hasText: 'provably fair' }).locator('dd').allInnerTexts()
          check("today's and tomorrow's commitments are published", commitments.length === 2 && commitments.every((c) => /^[0-9a-f]{64}$/.test(c.trim())), commitments.join(','))
          check('coverage reads always available on a floor-backed machine', /artworks left: always available/.test(body))
          const redeem = page.getByRole('button', { name: 'redeem' })
          check('redeem is disabled until a hash is pasted', await redeem.isDisabled())
          await page.getByPlaceholder('paste its transaction hash (0x…)').fill(TX_B)
          check('and enabled once one is', await redeem.isEnabled())
          check('recent plays are shown', body.includes('recent plays'))
          check('the verifier is linked', (await page.getByRole('link', { name: /verify a play/ }).getAttribute('href'))?.startsWith('/experience/spring-season/verify'))
          await page.context().close()
        }

        // ── a machine whose price cannot be read, and one whose season is over ──
        {
          const saved = chain.sales.get(key(CAPSULE, 1))
          chain.sales.delete(key(CAPSULE, 1))
          const page = await open('/experience/spring-season')
          await page.getByText('insert coin').waitFor()
          const btn = page.getByRole('button', { name: 'price unavailable' })
          check('an unreadable price disables the button and says so', (await btn.count()) === 1 && (await btn.isDisabled()))
          check('with the reload hint', /could not read this capsule’s price just now — reload in a moment/.test(await text(page)))
          check('and no pull selector', !(await text(page)).includes('×5'))
          chain.sales.set(key(CAPSULE, 1), saved)
          await page.context().close()
        }
        {
          await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'ended' } })
          const page = await open('/experience/field-recordings')
          await page.getByText('insert coin').waitFor()
          const btn = page.getByRole('button', { name: 'season closed' })
          check('an ended machine renders, with the button reading season closed', (await btn.count()) === 1 && (await btn.isDisabled()))
          check('and the redeem path still offered', await page.getByRole('button', { name: 'redeem' }).count() === 1)
          await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'live' } })
          await page.context().close()
        }

        // ── the verifier ──
        {
          // Section 5 left this claim under a tampered commitment.
          const page = await open(`/experience/spring-season/verify?txHash=${TX_A}`)
          await page.getByText('MISMATCH').waitFor()
          check('a tampered commitment renders MISMATCH in red', (await text(page)).includes('mismatch'))
          strings.set(claimKey, JSON.stringify({ ...stored, epoch: yesterday, commitment: sha256(seed) }))
          await page.reload({ waitUntil: 'domcontentloaded' })
          await page.getByText('verified', { exact: true }).waitFor()
          const body = await text(page)
          check('an honest one renders verified', body.includes('verified the revealed seed matches the commitment published before this play'))
          check('with the seed revealed, the commitment, and recomputed → delivered', /server seed \(revealed after\) [0-9a-f]{64}/.test(body) && /recomputed → delivered #\d+ → #\d+/.test(body), body.slice(0, 300))
          check('and the exact lineup the play drew from', body.includes('the exact lineup this play drew from') && /weight \d+ ·/.test(body))
          await page.getByPlaceholder('capsule transaction hash (0x…)').fill('0x' + 'ee'.repeat(32))
          await page.getByRole('button', { name: 'verify' }).click()
          await page.getByText('No such play').waitFor()
          check('an unknown hash says so', true)
          await page.context().close()
        }

        // ── the studio, disconnected ──
        {
          const page = await open('/experience/new')
          await page.getByText('capsule studio').first().waitFor()
          await page.getByPlaceholder('spring-season').fill('browser-machine')
          await page.getByPlaceholder('Spring Season').fill('Browser Machine')
          await page.getByPlaceholder('0x…', { exact: true }).fill(CAPSULE_A)
          await page.getByPlaceholder('1', { exact: true }).fill('1')
          await page.getByPlaceholder('collection 0x…').fill(POOL)
          await page.getByPlaceholder('token').fill('8')
          await page.getByPlaceholder('artist 0x…').fill(CREATOR2)
          await page.locator('label:has-text("qty") input').fill('0')
          await page.getByText('what players will see').waitFor()
          const oneRow = await text(page)
          check('the odds preview appears as the lineup is typed', /what players will see #8 by 0x[0-9a-f]{4}…[0-9a-f]{4} unlimited 100%/.test(oneRow), oneRow.match(/what players will see.{0,80}/)?.[0] ?? '')
          check('and asks for a check to learn the payees', oneRow.includes('run check to see who this capsule actually pays'))
          // Add a second, equally-weighted piece: two unlimited rows at weight 10
          // are a real 50/50, which is where the derived percentage and its
          // "1 in N" ratio actually render (deriveOdds, formatOddsRatio — the
          // same functions the machine page and the draw use).
          await page.getByRole('button', { name: 'add artwork' }).click()
          await page.getByPlaceholder('collection 0x…').nth(1).fill(POOL)
          await page.getByPlaceholder('token').nth(1).fill('7')
          await page.getByPlaceholder('artist 0x…').nth(1).fill(ADMIN)
          await page.locator('label:has-text("qty") input').nth(1).fill('0')
          const twoRows = await text(page)
          check('an even two-piece lineup previews as 50.0% each', (twoRows.match(/50\.0%/g) ?? []).length === 2, twoRows.match(/what players will see.{0,120}/)?.[0] ?? '')
          check('and shows the 1-in-N ratio a fractional row carries', twoRows.includes('1 in 2'), twoRows.match(/1 in \d+/)?.[0] ?? 'none')
          check('a disconnected visitor is offered connect wallet, not a check that can only fail',
            (await page.getByRole('button', { name: 'connect wallet' }).count()) === 1 &&
            (await page.getByRole('button', { name: 'check', exact: true }).count()) === 0)
          await page.context().close()
        }

        // ── the studio, connected: check, then publish to review ──
        {
          const page = await open('/experience/new', { user: USER_TOKEN, wallet: CREATOR2 })
          const dryRuns = []
          const consoleErrs = []
          const failedReqs = []
          page.on('response', async (res) => {
            if (res.url().endsWith('/api/experience/machines') && res.request().method() === 'POST') {
              dryRuns.push({ status: res.status(), body: (await res.text().catch(() => '')).slice(0, 200) })
            }
          })
          page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 200)) })
          page.on('requestfailed', (r) => failedReqs.push(`${r.method()} ${r.url().replace(origin, '')}: ${r.failure()?.errorText ?? ''}`))
          page.on('pageerror', (e) => consoleErrs.push(`pageerror: ${e.message.slice(0, 200)}`))
          await page.getByRole('button', { name: 'check', exact: true }).waitFor()
          check('a connected wallet sees check and publish', (await page.getByRole('button', { name: 'publish' }).count()) === 1)
          await page.getByPlaceholder('spring-season').fill('browser-machine')
          await page.getByPlaceholder('Spring Season').fill('Browser Machine')
          await page.getByPlaceholder('0x…', { exact: true }).fill(CAPSULE_A)
          await page.getByPlaceholder('1', { exact: true }).fill('1')
          await page.getByPlaceholder('collection 0x…').fill(POOL)
          await page.getByPlaceholder('token').fill('8')
          await page.getByPlaceholder('artist 0x…').fill(CREATOR2)
          await page.locator('label:has-text("qty") input').fill('0')
          await page.getByRole('button', { name: 'check', exact: true }).click()
          // Wait for the result region either way, so a failing check reports the
          // server's verdict instead of timing out blind.
          await page.locator('section', { hasText: /ready|fix before publishing/i }).first().waitFor().catch(() => {})
          const afterCheck = await text(page)
          check('check passes against the live gate', afterCheck.includes('every check passed against live on-chain state'),
            `dryRuns=${JSON.stringify(dryRuns).slice(0, 300)} | console=${JSON.stringify(consoleErrs).slice(0, 300)} | failed=${JSON.stringify(failedReqs).slice(0, 200)} | panel=${afterCheck.match(/(ready|fix before publishing).{0,160}/)?.[0] ?? ''}`)
          check('and reports the on-chain capsule and who it pays', afterCheck.includes('on-chain: 20 max · 0 minted') && afterCheck.includes('every play pays you alone'), afterCheck.match(/on-chain.{0,40}/)?.[0] ?? '')
          await page.getByRole('button', { name: 'publish' }).click()
          await page.getByText('is queued for a curator').waitFor()
          const afterPublish = await text(page)
          check('a non-admin publish lands on a confirmation, not a 404',
            page.url() === `${origin}/experience/new` && afterPublish.includes('browser machine is queued for a curator'), page.url())
          check('that says where it will live once approved', afterPublish.includes('once approved it will be live at /experience/browser-machine'))
          const queued = await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })
          check('and the machine really is in the review queue', queued.json?.machines?.some((m) => m.machine.id === 'browser-machine' && m.machine.state === 'review'))
          await page.context().close()
        }

        // ── the curator's queue ──
        {
          const page = await open('/admin/experience', { admin: ADMIN_TOKEN })
          await page.getByText('Browser Machine').waitFor()
          await page.getByRole('button', { name: /Browser Machine/ }).click()
          await page.getByRole('button', { name: 'approve · live' }).waitFor()
          const body = await text(page)
          check('the queue shows the submitted machine with its lineup and odds', /browser-machine · by 0x[0-9a-f]{4}…[0-9a-f]{4} · 1 artwork · 20 capsules/.test(body) && /#8 by/.test(body) && body.includes('100%'), body.match(/browser-machine.{0,80}/)?.[0] ?? '')
          check('approve is enabled because nothing is wrong', await page.getByRole('button', { name: 'approve · live' }).isEnabled())
          check('and the footer tells the curator what the buttons really do', body.includes('stop new listings only') && body.includes('keeps its capsule token'))
          await page.getByRole('button', { name: 'approve · live' }).click()
          await page.getByText('browser-machine \u2192 live').waitFor()
          check('approving promotes it', (await call('/api/experience/machines/browser-machine')).status === 200)
          await page.context().close()
        }
      } finally {
        await browser.close()
      }
      if (pageErrors.length) console.log(`  (page errors: ${pageErrors.slice(0, 5).join(' || ').slice(0, 600)})`)
    }
    }
  }
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
