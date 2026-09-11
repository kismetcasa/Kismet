/**
 * HTTP end-to-end check for profile identity (ENS) resolution through the
 * REAL built app. Boots a stateful mock Upstash REST server and a mock
 * Ethereum-mainnet JSON-RPC server, spawns `next start` pointed at them, and
 * probes /api/profiles and /api/profile/[address] over HTTP.
 *
 * Why this exists next to `verify:profile-identity`: that suite pins the
 * lib/ensCache state machine and the client cache contract on the real
 * modules, but — by the verify suite's own rule — never loads a route
 * handler. The bug it guards against lived in the route wiring: cold cache
 * misses only ever warmed AFTER the response, so no first view could show a
 * .eth name. This file proves the wiring under the production runtime —
 * bounded inline resolution, the after() continuation on budget overrun and
 * on a transient RPC failure, and the per-request burst caps.
 *
 * Deliberately NOT wired into `npm run check`: it needs a built app and
 * spawns a server. See scripts/e2e/README.md.
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from 'viem'

const REDIS_PORT = Number(process.env.E2E_REDIS_PORT || 6398)
const RPC_PORT = Number(process.env.E2E_RPC_PORT || 8598)
const APP_PORT = Number(process.env.E2E_PORT || 3108)
const BASE = `http://127.0.0.1:${APP_PORT}`

let fails = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) fails++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Fixtures: each address reverse-resolves to its name and the name forward-
// resolves back to it, exactly as a verified primary name does on-chain.
const A = '0x78b2de47fe499e0a6f7a67dbf965b8ec765d2d9d'
const B = '0x1111111111111111111111111111111111111111'
const C = '0x2222222222222222222222222222222222222222'
const D = '0x3333333333333333333333333333333333333333'
const NAMES = new Map([[A, 'yonfrula.eth'], [B, 'second.eth'], [C, 'third.eth'], [D, 'fourth.eth']])

// ── mock Upstash (strings only — the ENS cache is a plain string key) ───────
const strings = new Map()
const ttls = new Map()
const exec = (cmd) => {
  const name = String(cmd[0]).toLowerCase()
  const args = cmd.slice(1).map(String)
  const k = args[0]
  switch (name) {
    case 'get': return strings.get(k) ?? null
    case 'mget': return args.map((key) => strings.get(key) ?? null)
    case 'set': {
      strings.set(k, args[1])
      const exIdx = args.findIndex((a) => a.toLowerCase() === 'ex')
      if (exIdx >= 0) ttls.set(k, Number(args[exIdx + 1]))
      return 'OK'
    }
    case 'del': { let n = 0; for (const key of args) { if (strings.delete(key)) n++; ttls.delete(key) } return n }
    case 'smembers': return []
    case 'expire': return 1
    default: throw new Error(`unsupported cmd ${name}`)
  }
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const encB64 = (v) => typeof v === 'string' ? (v === 'OK' ? 'OK' : b64(v)) : Array.isArray(v) ? v.map(encB64) : v
const redisServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      const useB64 = req.headers['upstash-encoding'] === 'base64'
      const enc = (v) => (useB64 ? encB64(v) : v)
      const parsed = JSON.parse(body)
      const out = Array.isArray(parsed[0])
        ? parsed.map((c) => { try { return { result: enc(exec(c)) } } catch (e) { return { error: String(e) } } })
        : (() => { try { return { result: enc(exec(parsed)) } } catch (e) { return { error: String(e) } } })()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }))
    }
  })
})

// ── mock mainnet JSON-RPC (ENS universal resolver) ──────────────────────────
// Signatures must match viem's universalResolver ABIs exactly (selectors
// 0xb7d6ca64 / 0xa1472844) or the dispatch silently misses.
const REVERSE = parseAbi(['function reverseWithGateways(bytes reverseName, uint256 coinType, string[] gateways) view returns (string, address, address)'])
const RESOLVE = parseAbi(['function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes, address)'])
const FILLER = '0x0000000000000000000000000000000000000001'
const rpc = { mode: 'ok', slowMs: 1_000, ethCalls: 0 }
const asciiHex = (s) => Buffer.from(s, 'utf8').toString('hex')

function answer(entry) {
  if (entry.method !== 'eth_call') throw new Error(`unhandled method ${entry.method}`)
  rpc.ethCalls++
  const d = entry.params[0].data.toLowerCase()
  if (d.startsWith('0xb7d6ca64')) {
    // The raw address bytes are the `bytes reverseName` argument.
    let name = ''
    for (const [addr, n] of NAMES) if (d.includes(addr.slice(2))) { name = n; break }
    return { jsonrpc: '2.0', id: entry.id, result: encodeFunctionResult({ abi: REVERSE, functionName: 'reverseWithGateways', result: [name, FILLER, FILLER] }) }
  }
  if (d.startsWith('0xa1472844')) {
    // The DNS-encoded name carries each label verbatim; match the first label.
    let target = FILLER
    for (const [addr, n] of NAMES) if (d.includes(asciiHex(n.split('.')[0]))) { target = addr; break }
    const inner = encodeAbiParameters([{ type: 'address' }], [target])
    return { jsonrpc: '2.0', id: entry.id, result: encodeFunctionResult({ abi: RESOLVE, functionName: 'resolveWithGateways', result: [inner, FILLER] }) }
  }
  throw new Error(`unhandled selector ${d.slice(0, 10)}`)
}
const rpcServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const respond = () => {
      try {
        if (rpc.mode === 'fail') { res.writeHead(429, { 'content-type': 'text/plain' }); res.end('rate limited'); return }
        const parsed = JSON.parse(body)
        const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: String(e) }))
      }
    }
    if (rpc.mode === 'slow') setTimeout(respond, rpc.slowMs)
    else respond()
  })
})

await new Promise((r) => redisServer.listen(REDIS_PORT, '127.0.0.1', r))
await new Promise((r) => rpcServer.listen(RPC_PORT, '127.0.0.1', r))

// ── the app ─────────────────────────────────────────────────────────────────
const app = spawn('node_modules/.bin/next', ['start', '-p', String(APP_PORT)], {
  env: {
    ...process.env,
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${REDIS_PORT}`,
    UPSTASH_REDIS_REST_TOKEN: 'e2e-token',
    MAINNET_RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
    NEXT_TELEMETRY_DISABLED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
app.stdout.on('data', (d) => { appLog += d })
app.stderr.on('data', (d) => { appLog += d })
const shutdown = () => { app.kill('SIGTERM'); redisServer.close(); rpcServer.close() }
process.on('exit', shutdown)

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
  shutdown()
  process.exit(1)
}

const profiles = async (addrs) => (await (await fetch(`${BASE}/api/profiles?addresses=${addrs.join(',')}`)).json()).profiles
const profile = async (addr) => (await (await fetch(`${BASE}/api/profile/${addr}`)).json()).profile
const ensKey = (addr) => `kismetart:ens:${addr}`

// ════════════════════════════════════════════════════════════════════════════
console.log('\nP1  cold /api/profiles: the FIRST request shows the name')
{
  const p = await profiles([A])
  check('cold batch response carries the resolved name', p[A]?.name === 'yonfrula.eth', JSON.stringify(p))
  check('resolved name cached during the request', (strings.get(ensKey(A)) ?? '').includes('yonfrula.eth'))
  check('at the 24h TTL', ttls.get(ensKey(A)) === 86_400, `ttl ${ttls.get(ensKey(A))}`)
  const calls = rpc.ethCalls
  const p2 = await profiles([A])
  check('warm re-read still carries the name', p2[A]?.name === 'yonfrula.eth')
  check('warm re-read cost zero RPC calls', rpc.ethCalls === calls)
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nP2  cold /api/profile/[address]: the profile header gets the name on first view')
{
  const p = await profile(B)
  check('displayName is the .eth name', p?.displayName === 'second.eth', JSON.stringify(p?.displayName))
  check('ensName is set', p?.ensName === 'second.eth')
  check('cached at 24h', ttls.get(ensKey(B)) === 86_400)
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nP3  transient RPC failure: nameless now, 30s sentinel via after(), recovers')
{
  rpc.mode = 'fail'
  const p = await profiles([C])
  check('the failed cold request degrades to no name', p[C]?.name === '')
  // viem retries a 429 (~1s of backoff), so the inline budget overruns and
  // the continuation runs past the response — under the REAL after().
  await sleep(2_500)
  check('the continuation stored the transient sentinel', (strings.get(ensKey(C)) ?? '').includes('!transient'),
    `stored ${JSON.stringify(strings.get(ensKey(C)))}`)
  check('…for 30s, not 5 minutes', ttls.get(ensKey(C)) === 30, `ttl ${ttls.get(ensKey(C))}`)
  const calls = rpc.ethCalls
  const p2 = await profiles([C])
  check('inside the window: still nameless, and no RPC call is spent', p2[C]?.name === '' && rpc.ethCalls === calls)
  rpc.mode = 'ok'
  strings.delete(ensKey(C)); ttls.delete(ensKey(C)) // what Redis does 30s later
  const p3 = await profiles([C])
  check('after the window the same address resolves inline and displays', p3[C]?.name === 'third.eth')
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nP4  budget overrun: response degrades, the continuation lands the cache, next view is warm')
{
  rpc.mode = 'slow' // 1s > the 500ms batch budget
  const p = await profiles([D])
  check('over-budget cold request degrades to no name', p[D]?.name === '')
  await sleep(2_000)
  check('the after() continuation cached the name anyway', (strings.get(ensKey(D)) ?? '').includes('fourth.eth'))
  rpc.mode = 'ok'
  const p2 = await profiles([D])
  check('next request reads warm', p2[D]?.name === 'fourth.eth')
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nP5  burst caps: 20 cold senders -> at most 8 inline + 8 background resolutions')
{
  const senders = Array.from({ length: 20 }, (_, i) => `0x${(i + 0x40).toString(16).padStart(2, '0')}${'cd'.repeat(19)}`)
  const before = rpc.ethCalls
  const p = await profiles(senders)
  check('every sender is answered', Object.keys(p).length === 20)
  await sleep(1_500) // let the background warms land
  const cached = senders.filter((s) => strings.has(ensKey(s))).length
  check('exactly 16 of 20 resolved (8 inline + 8 warm); 4 stay cold for later', cached === 16, `cached ${cached}`)
  // No-record addresses cost one eth_call each (reverse only, no forward).
  check('16 RPC calls total — not the 20+ an unbounded fan-out would fire', rpc.ethCalls - before === 16,
    `calls ${rpc.ethCalls - before}`)
}

// ════════════════════════════════════════════════════════════════════════════
console.log(fails === 0 ? '\ne2e profile-identity: all checks passed' : `\ne2e profile-identity: ${fails} FAILED`)
shutdown()
process.exit(fails === 0 ? 0 : 1)
