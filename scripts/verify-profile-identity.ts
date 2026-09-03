// End-to-end verification of the profile-identity resolution fixes on this
// branch. Boots a mock Upstash REST server (pipeline-aware, base64 response
// encoding, TTL-recording) and a mock Ethereum mainnet JSON-RPC server
// (universal-resolver reverse + forward answers, batch-aware), points the
// REAL lib/redis + lib/ensCache clients at them, then drives the REAL
// modules. Hermetic: no live Redis, no chain; a fetch shim answers
// /api/profiles for the client-cache section and blocks everything else, so
// a missed stub fails loudly instead of reaching the network.
//
// What broke, in production terms: an ENS-only collector rendered as
// `0x78b2…2d9d` in every cold view — the ENS cache was read-through-only
// (resolution only ever happened AFTER the response, so a first view could
// never show a name), a resolved name expired hourly, a single RPC failure
// was cached as "confirmed no ENS" for 5 minutes with no retry, and the
// client pinned the shortAddress fallback for 30s with no way past the pin.
//
// Sections:
//   E1  bounded inline resolution — a cold miss can now return the name to
//       the SAME request, cached at the new 24h TTL
//   E2  budget overrun — the response falls back, the resolution finishes in
//       the background, the next read is warm
//   E3  transient RPC failure — distinct short-TTL sentinel: displays
//       nothing, throttles retries, and CANNOT impersonate "no ENS"
//   E4  confirmed no-ENS / failed forward-verification — still cached ('')
//       at 1h, still displays nothing (non-regression + ENS-spec safety)
//   E5  same-tick misses share one batched RPC request
//   P1  profileCache: unresolved entries pin for 30s, and
//       invalidateUnresolvedProfiles is the ONLY way past the pin — and it
//       never touches resolved entries
//   U1  normalizeMomentComments: upstream `username` is kept only when it is
//       a short, non-address-shaped string (display fallback hygiene)
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-profile-identity.ts

import { createServer } from 'node:http'
import { encodeAbiParameters, encodeFunctionResult, parseAbi, type Hex } from 'viem'

// ── mock Upstash (strings only — the ENS cache is a plain string key) ───────
const strings = new Map<string, string>()
const ttls = new Map<string, number>()

function exec(cmd: unknown[]): unknown {
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

// Protocol fidelity: the SDK sends `Upstash-Encoding: base64` and DECODES every
// string result except the literal "OK", so the mock must ENCODE them.
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
function encodeUpstash(v: unknown): unknown {
  if (typeof v === 'string') return v === 'OK' ? 'OK' : b64(v)
  if (Array.isArray(v)) return v.map(encodeUpstash)
  return v
}

const redisServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      const useB64 = req.headers['upstash-encoding'] === 'base64'
      const enc = (v: unknown) => (useB64 ? encodeUpstash(v) : v)
      const parsed = JSON.parse(body) as unknown[]
      const isPipeline = Array.isArray(parsed[0])
      const out = isPipeline
        ? (parsed as unknown[][]).map((c) => {
            try { return { result: enc(exec(c)) } } catch (e) { return { error: String(e) } }
          })
        : (() => { try { return { result: enc(exec(parsed)) } } catch (e) { return { error: String(e) } } })()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }))
    }
  })
})

// ── mock mainnet JSON-RPC (ENS universal resolver, batch-aware) ─────────────
// Signatures must match viem's universalResolver ABIs exactly or the
// selectors drift and the dispatch below silently misses.
const REVERSE = parseAbi([
  'function reverseWithGateways(bytes reverseName, uint256 coinType, string[] gateways) view returns (string, address, address)',
])
const RESOLVE = parseAbi([
  'function resolveWithGateways(bytes name, bytes data, string[] gateways) view returns (bytes, address)',
])
const REVERSE_SELECTOR = '0xb7d6ca64'
const RESOLVE_SELECTOR = '0xa1472844'
const FILLER = '0x0000000000000000000000000000000000000001'

const rpc = {
  mode: 'ok' as 'ok' | 'fail' | 'slow',
  slowMs: 400,
  // reverse answer per address (the raw address bytes appear verbatim in the
  // reverseWithGateways calldata); '' = no reverse record.
  names: new Map<string, string>(),
  // forward answer for every resolve call; null = resolve to FILLER (unverified).
  forwardTo: null as string | null,
  ethCalls: 0,
  httpRequests: 0,
  batchedRequests: 0,
}

function answerEthCall(data: Hex): Hex {
  rpc.ethCalls++
  const d = data.toLowerCase()
  if (d.startsWith(REVERSE_SELECTOR)) {
    let name = ''
    for (const [addr, n] of rpc.names) {
      if (d.includes(addr.slice(2).toLowerCase())) { name = n; break }
    }
    return encodeFunctionResult({ abi: REVERSE, functionName: 'reverseWithGateways', result: [name, FILLER, FILLER] })
  }
  if (d.startsWith(RESOLVE_SELECTOR)) {
    const inner = encodeAbiParameters([{ type: 'address' }], [(rpc.forwardTo ?? FILLER) as Hex])
    return encodeFunctionResult({ abi: RESOLVE, functionName: 'resolveWithGateways', result: [inner, FILLER] })
  }
  throw new Error(`unhandled eth_call selector ${d.slice(0, 10)}`)
}

const rpcServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const respond = () => {
      try {
        if (rpc.mode === 'fail') {
          res.writeHead(429, { 'content-type': 'text/plain' })
          res.end('rate limited')
          return
        }
        const parsed = JSON.parse(body) as { id: number; method: string; params: [{ data: Hex }, string] } | Array<{ id: number; method: string; params: [{ data: Hex }, string] }>
        rpc.httpRequests++
        const one = (r: { id: number; method: string; params: [{ data: Hex }, string] }) => {
          if (r.method !== 'eth_call') throw new Error(`unhandled rpc method ${r.method}`)
          return { jsonrpc: '2.0', id: r.id, result: answerEthCall(r.params[0].data) }
        }
        // viem's batch transport sends a JSON array for same-tick calls.
        const out = Array.isArray(parsed) ? (rpc.batchedRequests += parsed.length > 1 ? 1 : 0, parsed.map(one)) : one(parsed)
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

await new Promise<void>((r) => redisServer.listen(0, '127.0.0.1', r))
await new Promise<void>((r) => rpcServer.listen(0, '127.0.0.1', r))
const redisPort = (redisServer.address() as { port: number }).port
const rpcPort = (rpcServer.address() as { port: number }).port
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${redisPort}`
process.env.UPSTASH_REDIS_REST_TOKEN = 'sim-token'
process.env.MAINNET_RPC_URL = `http://127.0.0.1:${rpcPort}`

// Everything off-box is stubbed; anything unstubbed 503s rather than escaping
// to the network, so a forgotten dependency shows up as a failed check.
// `/api/profiles` (relative — the browser-side profileCache under test) is
// answered from a mutable in-script state so the pin scenarios can flip the
// server's answer between calls.
const realFetch = globalThis.fetch
const profilesApi = { name: '', requests: 0 }
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
  if (url.startsWith('/api/profiles?addresses=')) {
    profilesApi.requests++
    const addrs = decodeURIComponent(url.slice('/api/profiles?addresses='.length)).split(',')
    const profiles = Object.fromEntries(addrs.map((a) => [a, { name: profilesApi.name, avatarUrl: undefined }]))
    return new Response(JSON.stringify({ profiles }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response('blocked', { status: 503 })
}) as typeof fetch

// Dynamic imports AFTER the env vars point at the mocks — lib/redis and
// lib/ensCache's viem client read them at module-evaluation time.
const ensCache = await import(new URL('../lib/ensCache.ts', import.meta.url).href)
const profileCache = await import(new URL('../lib/profileCache.ts', import.meta.url).href)
const inprocess = await import(new URL('../lib/inprocess.ts', import.meta.url).href)

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

const A = '0x78b2de47fe499e0a6f7a67dbf965b8ec765d2d9d'
const NAME = 'yonfrula.eth'
const key = (addr: string) => `kismetart:ens:${addr}`

// ════════════════════════════════════════════════════════════════════════════
console.log('\nE1  a cold miss resolves INLINE within budget and caches for 24h')
{
  rpc.mode = 'ok'; rpc.names.set(A, NAME); rpc.forwardTo = A; rpc.ethCalls = 0
  check('cold cache reads as unknown', (await ensCache.getCachedEns(A)) === undefined)
  const { ens, pending } = await ensCache.resolveEnsWithBudget(A, 2_000)
  check('the SAME request gets the verified name', ens === NAME)
  check('no pending continuation when the budget held', pending === undefined)
  check('reverse + forward-verify = 2 eth_calls', rpc.ethCalls === 2, `saw ${rpc.ethCalls}`)
  check('resolved name cached at 24h', ttls.get(key(A)) === 24 * 60 * 60, `ttl ${ttls.get(key(A))}`)
  check('warm read returns the name', (await ensCache.getCachedEns(A)) === NAME)
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nE2  budget overrun falls back to background completion')
{
  const B = '0x1111111111111111111111111111111111111111'
  rpc.mode = 'slow'; rpc.slowMs = 300; rpc.names.set(B, 'slow.eth'); rpc.forwardTo = B
  const { ens, pending } = await ensCache.resolveEnsWithBudget(B, 50)
  check('over-budget response degrades to no name', ens === null)
  check('a pending continuation is handed back for after()', pending !== undefined)
  await pending
  check('the continuation still lands the cache write', (await ensCache.getCachedEns(B)) === 'slow.eth')
  rpc.mode = 'ok'
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nE3  a transient RPC failure throttles WITHOUT impersonating "no ENS"')
{
  const C = '0x2222222222222222222222222222222222222222'
  rpc.mode = 'fail'
  const r = await ensCache.resolveEnsAndCache(C)
  check('failed resolution returns null', r === null)
  check('failure stored under the distinct sentinel', strings.get(key(C))?.includes('!transient') === true,
    `stored ${JSON.stringify(strings.get(key(C)))}`)
  check('failure TTL is 30s, not the 5min it used to poison for', ttls.get(key(C)) === 30, `ttl ${ttls.get(key(C))}`)
  check('inside the window: display nothing, do not re-resolve', (await ensCache.getCachedEns(C)) === null)
  strings.delete(key(C)) // what Redis does 30s later
  check('after the window the address is retryable again', (await ensCache.getCachedEns(C)) === undefined)
  rpc.mode = 'ok'
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nE4  confirmed no-ENS and failed forward-verification still cache as none')
{
  const D = '0x3333333333333333333333333333333333333333'
  // no reverse record at all
  const r1 = await ensCache.resolveEnsAndCache(D)
  check('no reverse record → null', r1 === null)
  check('cached as confirmed-none for 1h', ttls.get(key(D)) === 60 * 60, `ttl ${ttls.get(key(D))}`)
  check('read back as known-nothing (no re-resolve)', (await ensCache.getCachedEns(D)) === null)
  // reverse record exists but forward-verification points elsewhere (spoof)
  const E = '0x4444444444444444444444444444444444444444'
  rpc.names.set(E, 'spoofed.eth'); rpc.forwardTo = A
  const r2 = await ensCache.resolveEnsAndCache(E)
  check('unverified reverse record → null (ENS-spec forward check)', r2 === null)
  check('unverified cached as none for 1h', ttls.get(key(E)) === 60 * 60)
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nE5  same-tick misses share one batched RPC request')
{
  const F1 = '0x5555555555555555555555555555555555555555'
  const F2 = '0x6666666666666666666666666666666666666666'
  rpc.names.set(F1, ''); rpc.names.set(F2, '')
  rpc.httpRequests = 0; rpc.ethCalls = 0; rpc.batchedRequests = 0
  await Promise.all([ensCache.resolveEnsAndCache(F1), ensCache.resolveEnsAndCache(F2)])
  check('two concurrent resolutions made 2 eth_calls', rpc.ethCalls === 2, `saw ${rpc.ethCalls}`)
  check('…carried in at least one JSON-RPC batch', rpc.batchedRequests >= 1,
    `http=${rpc.httpRequests} batched=${rpc.batchedRequests}`)
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nP1  profileCache: 30s pin, and invalidateUnresolvedProfiles is the way past it')
{
  const addr = '0x7777777777777777777777777777777777777777'
  profilesApi.name = ''; profilesApi.requests = 0
  const r1 = await profileCache.fetchCreatorProfilesBatch([addr])
  check('cold answer falls back to shortAddress, unresolved', r1[addr].name === '0x7777…7777' && r1[addr].resolved === false)
  check('one network request made', profilesApi.requests === 1)

  profilesApi.name = NAME // the server-side warm has landed by now
  const r2 = await profileCache.fetchCreatorProfilesBatch([addr])
  check('immediate re-lookup is served the pin (no network)', profilesApi.requests === 1 && r2[addr].resolved === false)

  profileCache.invalidateUnresolvedProfiles([addr])
  const r3 = await profileCache.fetchCreatorProfilesBatch([addr])
  check('invalidate + refetch upgrades to the resolved name', r3[addr].name === NAME && r3[addr].resolved === true)
  check('exactly one extra request paid for it', profilesApi.requests === 2, `saw ${profilesApi.requests}`)

  profileCache.invalidateUnresolvedProfiles([addr])
  const r4 = await profileCache.fetchCreatorProfilesBatch([addr])
  check('resolved entries survive invalidation (no refetch, name kept)',
    profilesApi.requests === 2 && r4[addr].name === NAME)
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nU1  upstream username hygiene in normalizeMomentComments')
{
  const base = { sender: A, comment: 'gm', timestamp: 1_756_800_000_000 }
  const norm = (row: Record<string, unknown>) => inprocess.normalizeMomentComments([row])[0]
  check('a plain handle is kept', norm({ ...base, username: 'yonfrula' }).username === 'yonfrula')
  check('surrounding whitespace is trimmed', norm({ ...base, username: '  yonfrula  ' }).username === 'yonfrula')
  check('an empty/whitespace handle is dropped', norm({ ...base, username: '   ' }).username === undefined)
  check('an address-shaped handle is dropped', norm({ ...base, username: '0x78B2dE47fe499e0a' }).username === undefined)
  check('an over-long handle is dropped', norm({ ...base, username: 'x'.repeat(41) }).username === undefined)
  check('a non-string username is dropped', norm({ ...base, username: 42 }).username === undefined)
  check('absent username stays absent', norm({ ...base }).username === undefined)
  // Non-regression: the repairs/drops this normalizer already guaranteed.
  check('missing comment still repairs to empty string', norm({ sender: A, timestamp: 1 }).comment === '')
  check('a timestampless row is still dropped', inprocess.normalizeMomentComments([{ sender: A, comment: 'x' }]).length === 0)
}

// ════════════════════════════════════════════════════════════════════════════
console.log(failures === 0 ? '\nverify-profile-identity: all checks passed' : `\nverify-profile-identity: ${failures} FAILED`)
redisServer.close(); rpcServer.close()
process.exit(failures === 0 ? 0 : 1)
