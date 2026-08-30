// End-to-end verification of the five notification-delivery gaps closed in
// this branch. Boots a mock Upstash REST server (pipeline-aware, base64
// response encoding) and a mock Base JSON-RPC server, points the REAL
// lib/redis + lib/rpc clients at them, then drives the REAL modules —
// lib/notifications, lib/listings, lib/farcasterAuth, lib/inprocess — through
// each gap and its non-regression neighbours. Hermetic: no live Redis, no
// chain, no Farcaster API (a fetch shim answers those and blocks everything
// else, so a missed stub fails loudly instead of reaching the network).
//
// Gaps under test, each in its own section below:
//   G1  a Kismet listing filled OFF-platform announced "expired" — a false
//       statement, not just a missing one (lib/listings resolveTerminalStatuses)
//   G2  a transient Farcaster failure re-resolved a user's identity, and
//       permanently deleted their stored choice (lib/farcasterAuth)
//   G3  writeNotification lost entries with no trace at all (lib/notifications)
//   G4  an upstream activity row missing `comment`/`sender` — or a `comments`
//       value that was not an array at all — threw and took the whole panel
//       down (lib/inprocess normalizeMomentComments, applied at every boundary)
//   G5  notifications addressed to an inprocess per-creator smart wallet — an
//       inbox nobody can sign in to — while stats folded the same alias onto
//       its owner (lib/notifications resolveRecipient)
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-notification-gaps.ts

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  parseAbi,
  parseAbiParameters,
  type Hex,
} from 'viem'

// ── mock Upstash ────────────────────────────────────────────────────────────
const strings = new Map<string, string>()
const sets = new Map<string, Set<string>>()
const zsets = new Map<string, Map<string, number>>()
const fail = { cmds: new Set<string>(), httpError: null as string | null }

function exec(cmd: unknown[]): unknown {
  const name = String(cmd[0]).toLowerCase()
  if (fail.cmds.has(name)) throw new Error('injected failure')
  const args = cmd.slice(1).map(String)
  const k = args[0]
  switch (name) {
    case 'get': return strings.get(k) ?? null
    case 'mget': return args.map((key) => strings.get(key) ?? null)
    case 'set': {
      // Upstash sends SET key value [nx] [ex N]; NX must return null on a
      // live key or the burst/claim locks under test would never engage.
      const nx = args.some((a) => a.toLowerCase() === 'nx')
      if (nx && strings.has(k)) return null
      strings.set(k, args[1])
      return 'OK'
    }
    case 'del': { let n = 0; for (const key of args) { if (strings.delete(key)) n++; if (sets.delete(key)) n++; if (zsets.delete(key)) n++ } return n }
    case 'expire': return 1
    case 'sadd': { const s = sets.get(k) ?? new Set<string>(); for (const m of args.slice(1)) s.add(m); sets.set(k, s); return 1 }
    case 'srem': { const s = sets.get(k); let n = 0; for (const m of args.slice(1)) { if (s?.delete(m)) n++ } return n }
    case 'smembers': return [...(sets.get(k) ?? [])]
    case 'sismember': return sets.get(k)?.has(args[1]) ? 1 : 0
    case 'zadd': {
      const m = zsets.get(k) ?? new Map<string, number>()
      // ZADD key [NX] score member — skip any flag tokens before the pair.
      const rest = args.slice(1).filter((a) => !['nx', 'xx', 'gt', 'lt', 'ch'].includes(a.toLowerCase()))
      m.set(rest[1], Number(rest[0]))
      zsets.set(k, m)
      return 1
    }
    case 'zrem': { const m = zsets.get(k); let n = 0; for (const mem of args.slice(1)) { if (m?.delete(mem)) n++ } return n }
    case 'zscore': { const s = zsets.get(k)?.get(args[1]); return s === undefined ? null : s }
    case 'zrange': {
      const m = zsets.get(k); if (!m) return []
      let entries = [...m.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      const flags = args.map((a) => a.toLowerCase())
      const rev = flags.includes('rev')
      // Honour the RANGE, not just the key. Redis reads min/max as scores under
      // BYSCORE and as ranks otherwise; '+inf'/'-inf' are legal score bounds.
      const bound = (raw: string, dflt: number) =>
        raw === '+inf' ? Infinity : raw === '-inf' ? -Infinity : Number.isFinite(Number(raw)) ? Number(raw) : dflt
      if (flags.includes('byscore')) {
        const lo = bound(args[1], -Infinity)
        const hi = bound(args[2], Infinity)
        entries = entries.filter(([, sc]) => sc >= lo && sc <= hi)
      } else {
        const start = Number(args[1]); const stop = Number(args[2])
        if (Number.isFinite(start) && Number.isFinite(stop)) {
          const n = entries.length
          const a = start < 0 ? Math.max(0, n + start) : start
          const b = stop < 0 ? n + stop : Math.min(n - 1, stop)
          entries = b < a ? [] : entries.slice(a, b + 1)
        }
      }
      return (rev ? entries.reverse() : entries).map(([mem]) => mem)
    }
    case 'zremrangebyrank': {
      // Really trims. lib/notifications caps every inbox with
      // zremrangebyrank(key, 0, -MAX_PER_USER - 1); a mock returning 0 let a
      // bound that deletes EVERY entry on EVERY write pass the whole suite.
      const m = zsets.get(k); if (!m) return 0
      const sorted = [...m.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      const n = sorted.length
      const start = Number(args[1]); const stop = Number(args[2])
      const a = start < 0 ? Math.max(0, n + start) : start
      const b = stop < 0 ? n + stop : Math.min(n - 1, stop)
      if (b < a) return 0
      for (const [mem] of sorted.slice(a, b + 1)) m.delete(mem)
      return b - a + 1
    }
    case 'zremrangebyscore': {
      const m = zsets.get(k); if (!m) return 0
      const lo = args[1] === '-inf' ? -Infinity : Number(args[1])
      const hi = args[2] === '+inf' ? Infinity : Number(args[2])
      let n = 0
      for (const [mem, sc] of [...m.entries()]) { if (sc >= lo && sc <= hi) { m.delete(mem); n++ } }
      return n
    }
    default: throw new Error(`unsupported cmd ${name}`)
  }
}

// Protocol fidelity: the SDK sends `Upstash-Encoding: base64` and DECODES every
// string result except the literal "OK", so the mock must ENCODE them.
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
function encodeResult(v: unknown): unknown {
  if (typeof v === 'string') return v === 'OK' ? 'OK' : b64(v)
  if (Array.isArray(v)) return v.map(encodeResult)
  return v
}

const redisServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      // A non-2xx with an {error} body is the ONLY shape that makes the SDK
      // echo the command it sent — the exact path that leaked notification
      // payloads into the logs. A 200-with-per-command-error cannot reproduce it.
      if (fail.httpError) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `${fail.httpError}, command was: ${body}` }))
        return
      }
      const useB64 = req.headers['upstash-encoding'] === 'base64'
      const enc = (v: unknown) => (useB64 ? encodeResult(v) : v)
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

// ── mock Base RPC (Multicall3 → Seaport.getOrderStatus) ─────────────────────
const AGGREGATE3 = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) returns ((bool success, bytes returnData)[] returnData)',
])
const GET_ORDER_STATUS = parseAbi([
  'function getOrderStatus(bytes32 orderHash) view returns (bool isValidated, bool isCancelled, uint256 totalFilled, uint256 totalSize)',
])
/** orderHash → what Seaport should say happened to it. */
const orderStatus = new Map<string, { cancelled: boolean; filled: bigint }>()
let rpcMode: 'ok' | 'dead' = 'ok'
/** Answer aggregate3 with success:false per call — what an ABI mismatch or a
 *  reverting getOrderStatus looks like to viem's multicall. */
let rpcFailCalls = false

const rpcServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (rpcMode === 'dead') { res.writeHead(500); res.end('rpc down'); return }
    const reply = (id: unknown, result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
    }
    try {
      const rpc = JSON.parse(body) as { id: unknown; method: string; params: unknown[] }
      if (rpc.method !== 'eth_call') return reply(rpc.id, '0x')
      const call = (rpc.params[0] as { data: Hex }).data
      const { args } = decodeFunctionData({ abi: AGGREGATE3, data: call })
      const calls = args[0] as readonly { target: Hex; allowFailure: boolean; callData: Hex }[]
      const results = calls.map((c) => {
        const inner = decodeFunctionData({ abi: GET_ORDER_STATUS, data: c.callData })
        const hash = String(inner.args[0]).toLowerCase()
        const st = orderStatus.get(hash) ?? { cancelled: false, filled: 0n }
        if (rpcFailCalls) return { success: false, returnData: '0x' as Hex }
        return {
          success: true,
          returnData: encodeAbiParameters(
            parseAbiParameters('bool, bool, uint256, uint256'),
            [true, st.cancelled, st.filled, 1n],
          ),
        }
      })
      reply(rpc.id, encodeFunctionResult({ abi: AGGREGATE3, functionName: 'aggregate3', result: results }))
    } catch (e) {
      res.writeHead(500); res.end(String(e))
    }
  })
})

// ── harness ─────────────────────────────────────────────────────────────────
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}
const tick = () => new Promise((r) => setTimeout(r, 80))
/** Entries actually stored in an address's inbox, newest-first. */
const inbox = (addr: string): Record<string, unknown>[] => {
  const m = zsets.get(`kismetart:notif:${addr.toLowerCase()}`)
  if (!m) return []
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([raw]) => JSON.parse(raw))
}

await new Promise<void>((r) => redisServer.listen(0, '127.0.0.1', r))
await new Promise<void>((r) => rpcServer.listen(0, '127.0.0.1', r))
const redisPort = (redisServer.address() as { port: number }).port
const rpcPort = (rpcServer.address() as { port: number }).port
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${redisPort}`
process.env.UPSTASH_REDIS_REST_TOKEN = 'sim-token'
process.env.BASE_RPC_URL = `http://127.0.0.1:${rpcPort}`

// Everything off-box is stubbed; anything unstubbed 503s rather than escaping
// to the network, so a forgotten dependency shows up as a failed check.
const realFetch = globalThis.fetch
let fcVerifications: 'transient' | string[] = 'transient'
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init)
  if (url.includes('api.farcaster.xyz/v2/verifications')) {
    // 429 is the TRANSIENT branch getVerifiedAddressesByFidChecked exists for.
    if (fcVerifications === 'transient') return new Response('rate limited', { status: 429 })
    return new Response(
      JSON.stringify({ result: { verifications: fcVerifications.map((a) => ({ address: a })) } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return new Response('blocked', { status: 503 })
}) as typeof fetch

// Dynamic imports AFTER the env vars point at the mocks — lib/redis and
// lib/rpc read them at module-evaluation time.
const notifications = await import(new URL('../lib/notifications.ts', import.meta.url).href)
const listings = await import(new URL('../lib/listings.ts', import.meta.url).href)
const seaport = await import(new URL('../lib/seaport.ts', import.meta.url).href)
const inprocess = await import(new URL('../lib/inprocess.ts', import.meta.url).href)
const farcasterAuth = await import(new URL('../lib/farcasterAuth.ts', import.meta.url).href)

// ════════════════════════════════════════════════════════════════════════════
console.log('\nG5  notifications addressed to an unreachable smart-wallet inbox')
{
  const OWNER = '0x1111111111111111111111111111111111111111'
  const ALIAS = '0x2222222222222222222222222222222222222222'
  const BUYER = '0x3333333333333333333333333333333333333333'
  strings.set(`kismetart:smartwallet-owner:${ALIAS}`, OWNER)

  await notifications.writeNotification({
    type: 'sale', recipient: ALIAS, actor: BUYER,
    tokenAddress: '0xc0ffee', tokenId: '1', price: '1000',
  })
  check('alias sale lands in the OWNER inbox', inbox(OWNER).length === 1)
  check('alias inbox itself stays empty', inbox(ALIAS).length === 0)
  check('stored recipient is rewritten, not just the key', inbox(OWNER)[0]?.recipient === OWNER)

  // Non-regression: an ordinary address must be untouched by the lookup.
  const PLAIN = '0x4444444444444444444444444444444444444444'
  await notifications.writeNotification({
    type: 'sale', recipient: PLAIN, actor: BUYER, tokenAddress: '0xc0ffee', tokenId: '2', price: '1',
  })
  check('a plain address is delivered as addressed', inbox(PLAIN).length === 1)

  // The resolution must precede every downstream decision, or an entry could be
  // deduped against one inbox and written to another.
  sets.set(`kismetart:notif-muted-types:${OWNER}`, new Set(['collect']))
  await notifications.writeNotification({
    type: 'collect', recipient: ALIAS, actor: BUYER, tokenAddress: '0xc0ffee', tokenId: '3',
  })
  check("OWNER's type-mute suppresses a collect addressed to the ALIAS", inbox(OWNER).length === 1)
  sets.delete(`kismetart:notif-muted-types:${OWNER}`)

  // The burst lock is the second derivation that must agree. Addressing the
  // SAME (actor, collection) tuple once via the alias and once directly must
  // collide on ONE lock key — if the lock still keyed off the unresolved
  // address the second write would land and the inbox would hold two.
  const BURST = { type: 'collect' as const, actor: BUYER, tokenAddress: '0xdecaf', tokenId: '7' }
  await notifications.writeNotification({ ...BURST, recipient: ALIAS })
  const afterFirst = inbox(OWNER).length
  await notifications.writeNotification({ ...BURST, recipient: OWNER, tokenId: '8' })
  check('the burst lock keys off the RESOLVED address, not the alias',
    inbox(OWNER).length === afterFirst)

  // The follow-dedup scan is the third: it reads the inbox zset directly, so a
  // stale key would scan an empty set and let a duplicate follow through.
  await notifications.writeNotification({ type: 'follow', recipient: OWNER, actor: BUYER })
  const afterFollow = inbox(OWNER).length
  await notifications.writeNotification({ type: 'follow', recipient: ALIAS, actor: BUYER })
  check('the follow-dedup scan reads the RESOLVED inbox', inbox(OWNER).length === afterFollow)

  // Self-action is judged on the resolved address too. Asserted as a DELTA:
  // an absolute count silently rots as soon as a case is added above it.
  const beforeSelf = inbox(OWNER).length
  await notifications.writeNotification({ type: 'follow', recipient: ALIAS, actor: OWNER })
  check('self-action detected through the alias', inbox(OWNER).length === beforeSelf)
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nG3  a lost notification left no trace')
{
  const VICTIM = '0x5555555555555555555555555555555555555555'
  const errs: unknown[][] = []
  const realErr = console.error
  console.error = (...a: unknown[]) => { errs.push(a) }
  fail.cmds.add('zadd')
  const ok = await notifications.writeNotification({
    // `comment` and `note` are load-bearing test data, not decoration: without a
    // private field actually PRESENT on the input, the privacy assertion below
    // holds for any log shape at all, including one that spreads the whole input.
    type: 'sale', recipient: VICTIM, actor: '0x9', tokenAddress: '0xc0ffee', tokenId: '1', price: '5',
    comment: 'saw this at the show — congrats', note: 'private release note',
  })
  fail.cmds.delete('zadd')
  console.error = realErr

  check('a failed write still returns false', ok === false)
  check('and no longer fails silently', errs.some((e) => String(e[0]).includes('[notifications] write failed')))
  const logged = errs.find((e) => String(e[0]).includes('write failed'))?.[1] as Record<string, unknown> | undefined
  check('the log carries the routing fields needed to trace it', logged?.type === 'sale' && logged?.recipient === VICTIM)
  check('but never the payload (a collector comment is private)',
    logged !== undefined && !('comment' in logged) && !('note' in logged))

  // The leak that mattered was not a stray field on our own object — it was the
  // Upstash error itself. On any NON-2xx the SDK throws
  // `<reason>, command was: <the whole serialized body>`, and auto-pipelining
  // makes that body the entire tick. Asserted over the SERIALIZED log line, not
  // over key names, because the payload arrived inside a value.
  const errs2: unknown[][] = []
  const realErr2 = console.error
  console.error = (...a: unknown[]) => { errs2.push(a) }
  fail.httpError = 'ERR max daily request limit exceeded'
  await notifications.writeNotification({
    type: 'sale', recipient: VICTIM, actor: '0x9', tokenAddress: '0xc0ffee', tokenId: '9', price: '5',
    comment: 'SECRET-COLLECTOR-COMMENT', note: 'SECRET-RELEASE-NOTE',
  })
  fail.httpError = null
  console.error = realErr2
  // JSON.stringify alone is NOT enough here: an Error's name/message are
  // non-enumerable, so a logged Error serializes to {} and the assertion below
  // would pass while the payload sailed out through err.message. Unfold errors
  // explicitly — this test exists precisely to catch that shape.
  const line = JSON.stringify(errs2, (_k, v) =>
    v instanceof Error ? `${v.name}: ${v.message}` : v,
  )
  check('an Upstash transport error is logged at all', /write failed/.test(line))
  check('  …with the reason kept (an operator needs to know WHY)', /max daily request limit/.test(line))
  check('  …and the echoed command body stripped, payload and all',
    !/SECRET-COLLECTOR-COMMENT/.test(line) && !/SECRET-RELEASE-NOTE/.test(line))
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nG7  inbox retention: the bounds nothing was checking')
{
  // Both of these passed with a mock that returned 0 for the range-trims and
  // ignored min/max on ZRANGE, so a bound that wiped every inbox on every write
  // — and a dedup window ~53,000 years wide — were both invisible.
  const KEEPER = '0x9999999999999999999999999999999999999999'
  for (let i = 0; i < 5; i++) {
    await notifications.writeNotification({
      type: 'collect', recipient: KEEPER, actor: `0xa${i}`, tokenAddress: '0xbeef', tokenId: String(i), price: '1',
    })
  }
  check('the per-write trim keeps entries rather than clearing the inbox', inbox(KEEPER).length === 5)

  // The follow-dedup WINDOW, not just its parse shape. A follow older than
  // FOLLOW_DEDUP_WINDOW_SECS (7d) must NOT suppress; a recent one must.
  const FA = '0xb111111111111111111111111111111111111111'
  const OLD = '0xb222222222222222222222222222222222222222'
  const nowSec = Math.floor(Date.now() / 1000)
  const stale = JSON.stringify({
    id: 'stale', type: 'follow', recipient: FA, actor: OLD,
    timestamp: nowSec - 8 * 24 * 60 * 60, priority: true,
  })
  zsets.set(`kismetart:notif:${FA}`, new Map([[stale, nowSec - 8 * 24 * 60 * 60]]))
  await notifications.writeNotification({ type: 'follow', recipient: FA, actor: OLD })
  check('a follow older than the 7d window does NOT suppress a new one', inbox(FA).length === 2)
  await notifications.writeNotification({ type: 'follow', recipient: FA, actor: OLD })
  check('  …while one inside the window does', inbox(FA).length === 2)
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nG1  a listing filled off-platform announced "expired"')
{
  const SELLER = '0x6666666666666666666666666666666666666666'
  const mkListing = (id: string, tokenId: string) => {
    const order = seaport.buildSellOrder({
      offerer: SELLER as Hex, collectionAddress: '0x00000000000000000000000000000000c0ffee01' as Hex,
      tokenId, sellerProceeds: 1000n, royaltyReceiver: SELLER as Hex, royaltyAmount: 0n,
      platformFee: 0n, platformFeeRecipient: SELLER as Hex, counter: 0n,
    })
    const listing = {
      id, collectionAddress: '0x00000000000000000000000000000000c0ffee01', tokenId, seller: SELLER,
      price: '1000', sellerProceeds: '1000', royaltyReceiver: SELLER, royaltyAmount: '0',
      currency: 'eth', platformFee: '0', platformFeeRecipient: SELLER,
      orderComponents: seaport.serializeOrder(order), signature: '0x',
      createdAt: Date.now() - 2000, expiresAt: Date.now() - 1000, status: 'active',
      name: `Piece ${tokenId}`,
    }
    strings.set(`kismetart:listing:${id}`, JSON.stringify(listing))
    const z = zsets.get('kismetart:listings') ?? new Map<string, number>()
    z.set(id, Date.now()); zsets.set('kismetart:listings', z)
    return seaport.listingOrderHash(listing).toLowerCase()
  }

  // Unhashable orderComponents, seeded FIRST so it is skipped by the compaction
  // and every later result must be re-mapped through `idx`. Without this the
  // mapping is the identity permutation and out[j] passes for out[idx[j]].
  strings.set('kismetart:listing:L-unhashable', JSON.stringify({
    id: 'L-unhashable', collectionAddress: '0x00000000000000000000000000000000c0ffee01',
    tokenId: '99', seller: SELLER, price: '1', sellerProceeds: '1', royaltyReceiver: SELLER,
    royaltyAmount: '0', currency: 'eth', platformFee: '0', platformFeeRecipient: SELLER,
    orderComponents: { offerer: 'not-an-order' }, signature: '0x',
    createdAt: Date.now() - 2000, expiresAt: Date.now() - 1000, status: 'active', name: 'Broken',
  }))
  {
    // Score deliberately ABOVE the others: sweepExpiredListings reads the index
    // with { rev: true }, so this must sort FIRST to be the row the compaction
    // skips. Seeded last-in-order it would sort last, idx would stay the
    // identity permutation, and out[j] would pass for out[idx[j]].
    const z = zsets.get('kismetart:listings') ?? new Map<string, number>()
    z.set('L-unhashable', Date.now() + 10_000); zsets.set('kismetart:listings', z)
  }

  const soldHash = mkListing('L-sold', '11')
  const goneHash = mkListing('L-cancelled', '22')
  mkListing('L-expired', '33')
  orderStatus.set(soldHash, { cancelled: false, filled: 1n })
  orderStatus.set(goneHash, { cancelled: true, filled: 0n })

  await listings.sweepExpiredListings()
  await tick()

  const notes = inbox(SELLER)
  const byToken = (t: string) => notes.find((n) => n.tokenId === t)
  check('an off-platform fill is announced as a SALE, not an expiry', byToken('11')?.type === 'sale')
  check('  …and its row is recorded filled', JSON.parse(strings.get('kismetart:listing:L-sold')!).status === 'filled')
  check('  …with no invented buyer', byToken('11')?.actor === undefined)
  check('  …carrying the price so the row renders', byToken('11')?.price === '1000')
  check('an on-chain cancel is recorded, not announced', byToken('22') === undefined)
  check('  …and its row is recorded cancelled', JSON.parse(strings.get('kismetart:listing:L-cancelled')!).status === 'cancelled')
  check('a genuinely untouched order still expires (non-regression)', byToken('33')?.type === 'listing_expired')
  check('an unhashable order expires without aborting the batch', byToken('99')?.type === 'listing_expired')
  check('  …and results are re-mapped through idx, not by position',
    JSON.parse(strings.get('kismetart:listing:L-unhashable')!).status === 'expired' &&
    JSON.parse(strings.get('kismetart:listing:L-sold')!).status === 'filled')

  // An order Seaport cannot answer for must expire (safe) AND be counted, so a
  // systematically wrong ABI is visible instead of looking like "nothing sold".
  {
    const warns: unknown[][] = []
    const realWarn = console.warn
    console.warn = (...a: unknown[]) => { warns.push(a) }
    mkListing('L-unreadable', '55')
    rpcFailCalls = true
    await listings.sweepExpiredListings()
    await tick()
    rpcFailCalls = false
    console.warn = realWarn
    check('an unreadable order still expires (safe fallback)',
      inbox(SELLER).find((n) => n.tokenId === '55')?.type === 'listing_expired')
    check('  …and is counted, so a wrong ABI cannot fail silently',
      warns.some((w) => String(w[0]).includes('order-status unreadable')))
  }

  // Chain health must never turn a correct expiry into a stall or a wrong call.
  const rpcHash = mkListing('L-rpcdown', '44')
  orderStatus.set(rpcHash, { cancelled: false, filled: 1n })
  rpcMode = 'dead'
  await listings.sweepExpiredListings()
  await tick()
  rpcMode = 'ok'
  check('a dead RPC falls back to today\'s behavior, never a stall', inbox(SELLER).find((n) => n.tokenId === '44')?.type === 'listing_expired')
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nG2  a Farcaster blip reassigned identity and deleted the choice')
{
  const CHOSEN = '0xaaaa000000000000000000000000000000000001'
  const OTHER = '0xbbbb000000000000000000000000000000000002'

  // A user whose identity lives on the LEGACY pointer — the destructive path.
  const FID = 4001
  strings.set(`kismetart:fc:identity:${FID}`, CHOSEN)
  strings.set(`kismetart:fc:primary:${FID}`, OTHER)
  fcVerifications = 'transient'
  const during = await farcasterAuth.getKismetIdentityAddress(FID)
  check('a transient failure keeps the stored identity', during === CHOSEN)
  check('  …and does NOT delete it', strings.get(`kismetart:fc:identity:${FID}`) === CHOSEN)

  // A DEFINITIVE answer that the address is no longer verified must still prune.
  const FID2 = 4002
  strings.set(`kismetart:fc:identity:${FID2}`, CHOSEN)
  strings.set(`kismetart:fc:primary:${FID2}`, OTHER)
  fcVerifications = [OTHER]
  const after = await farcasterAuth.getKismetIdentityAddress(FID2)
  check('a definitive un-verify still prunes the ghost pointer (non-regression)', strings.get(`kismetart:fc:identity:${FID2}`) === undefined)
  check('  …and falls through to the next precedence step', after === OTHER)

  // FidProfile.currentAddress — the modern pointer — must not be swapped either.
  const FID3 = 4003
  strings.set(`kismetart:profile:fid:${FID3}`, JSON.stringify({ fid: FID3, currentAddress: CHOSEN }))
  strings.set(`kismetart:fc:primary:${FID3}`, OTHER)
  fcVerifications = 'transient'
  check('a transient failure keeps FidProfile.currentAddress', (await farcasterAuth.getKismetIdentityAddress(FID3)) === CHOSEN)

  const FID4 = 4004
  strings.set(`kismetart:profile:fid:${FID4}`, JSON.stringify({ fid: FID4, currentAddress: CHOSEN }))
  strings.set(`kismetart:fc:primary:${FID4}`, OTHER)
  fcVerifications = [OTHER]
  check('a definitive un-verify still moves off it (non-regression)', (await farcasterAuth.getKismetIdentityAddress(FID4)) === OTHER)

  // The WEB-FIRST cohort: an address-keyed profile, no FidProfile, no legacy
  // pointer. Steps 1 and 2 give no answer, so before the guard was extended
  // this fell through step 3 (an empty enumeration) into step 4 and answered
  // with the FC primary — a DIFFERENT wallet — during a transient. Fixing only
  // steps 1-2 left the same defect one branch further down.
  const FID5 = 4005
  strings.set(`kismetart:fc:primary:${FID5}`, OTHER)
  fcVerifications = 'transient'
  check('a user with NO stored choice still resolves during a transient (availability)',
    (await farcasterAuth.getKismetIdentityAddress(FID5)) === OTHER)

  const FID6 = 4006
  strings.set(`kismetart:fc:primary:${FID6}`, OTHER)
  fcVerifications = []
  check('  …but a DEFINITIVE empty still answers with primary (non-regression)',
    (await farcasterAuth.getKismetIdentityAddress(FID6)) === OTHER)
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nG4  a malformed activity row crashed the whole panel')
{
  const f = inprocess.isPlatformCollectComment
  // isPlatformCollectComment also answers for Notification.comment, which is
  // genuinely optional in its own domain — so tolerating absence is its
  // contract now, not a patch over this crash.
  check('undefined no longer throws', f(undefined) === true)
  check('null no longer throws', f(null) === true)
  check('empty is still platform-default (non-regression)', f('') === true)
  check('the default label still matches', f('collected on kismet') === true)
  check('a legacy label still matches', f('collected via Kismet Art') === true)
  check('a Zora frame comment still matches', f('Collecting from the frame by x') === true)
  check('a real comment is still a real comment', f('love this') === false)

  // The real fix is the boundary parse that makes MomentComment a guarantee.
  // Behavioural, not a source grep: the previous version of these checks
  // asserted on the SHAPE of the calling code, which passes for a screen
  // sitting in the wrong place and breaks on reformatting.
  const n = inprocess.normalizeMomentComments
  const row = (o: Record<string, unknown>) => ({ sender: '0xabc', timestamp: 1, ...o })

  // The container itself — the case a per-row guard can NEVER reach, because
  // `.filter` is the throw. MomentCard cached `data.comments ?? []` unchecked.
  check('a non-array payload yields no rows', n({}).length === 0)
  check('null yields no rows', n(null).length === 0)
  check('undefined yields no rows', n(undefined).length === 0)
  check('a string yields no rows', n('nope').length === 0)

  // Repaired: the fault is cosmetic and the event is real, so keep it.
  check('a null comment is repaired, not dropped', n([row({ comment: null })])[0]?.comment === '')
  check('an absent comment is repaired, not dropped', n([row({})])[0]?.comment === '')
  check('a non-string comment is repaired', n([row({ comment: 42 })])[0]?.comment === '')
  check('  …and reads as the platform default, exactly like an empty on-chain one',
    f(n([row({ comment: null })])[0].comment) === true)
  check('a numeric-string timestamp is coerced', n([row({ timestamp: '1700000000' })])[0]?.timestamp === 1700000000)

  // Dropped: unattributable or unorderable, so rendering it prints garbage.
  check('a row with no sender is dropped', n([row({ sender: undefined })]).length === 0)
  check('a row with an empty sender is dropped', n([row({ sender: '' })]).length === 0)
  check('a row with a non-finite timestamp is dropped', n([row({ timestamp: 'abc' })]).length === 0)
  // Number(null) === Number('') === Number([]) === Number(false) === 0, i.e.
  // FINITE — so a bare Number() guard keeps these and renders a ~20000d age.
  // 'abc' alone could never prove the guard does anything.
  check('  …and so is timestamp: null', n([row({ timestamp: null })]).length === 0)
  check('  …and timestamp: undefined', n([row({ timestamp: undefined })]).length === 0)
  check('  …and timestamp: false', n([row({ timestamp: false })]).length === 0)
  check('  …and timestamp: [] ', n([row({ timestamp: [] })]).length === 0)
  check('  …and the empty string', n([row({ timestamp: '' })]).length === 0)
  check('a non-object row is dropped', n([null, 7, 'x']).length === 0)

  // Must not become the thing that strips upstream's newer columns.
  const kept = n([row({ comment: 'hi', kind: 'airdrop', username: 'ada', commentId: null })])[0]
  check('a good row survives intact', kept?.sender === '0xabc' && kept?.comment === 'hi')
  check('opaque upstream fields are preserved', (kept as Record<string, unknown>)?.username === 'ada')
  check('kind is preserved (airdrop rows key separately)', kept?.kind === 'airdrop')
  check('one bad row no longer costs the good ones', n([row({}), null, row({ sender: '' })]).length === 1)

  // The parse only helps where it is actually applied, and TypeScript cannot
  // force it: `res.json()` is `any`, so assigning it to MomentComment[] type-
  // checks with or without the call. Assert the invariant at source instead —
  // on IMPORTS, not on statement shapes, so it survives reformatting: any file
  // that reads this feed must also parse it. Mirrors the repo's other
  // source-level gates (verify-a11y-text, check-resource-hint-cors).
  const READERS = [
    'components/MomentActivity.tsx',
    'components/MomentCard.tsx',
    'app/api/moment/comments/route.ts',
  ]
  // Counted WITH the open paren, which is what separates a call from the import
  // line: matching the bare identifier let a reader delete the call, keep the
  // import, and stay green — all three boundary mutants survived that way.
  // MomentActivity has two fetch sites, so one call is not enough there.
  const MIN_CALLS: Record<string, number> = {
    'components/MomentActivity.tsx': 2,
    'components/MomentCard.tsx': 1,
    'app/api/moment/comments/route.ts': 1,
  }
  for (const f of READERS) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    const calls = src.split('normalizeMomentComments(').length - 1
    check(`${f} parses the feed it reads (${MIN_CALLS[f]}+ call sites)`, calls >= MIN_CALLS[f])
    // Every reference to the raw payload must be inside a parse call. Catches a
    // NEW unparsed read added beside the existing parsed one. Comment text is
    // stripped first — these very files DISCUSS `data.comments ?? []` in prose,
    // and counting that made the check fail on correct code.
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    const raw = code.split('data.comments').length - 1
    const parsed = code.split('normalizeMomentComments(data.comments').length - 1
    if (raw > 0) check(`  …and every data.comments read in ${f} is parsed`, raw === parsed)
  }
  // And no OTHER file may quietly start reading it unparsed.
  const unguarded = execSync(
    `grep -rl "api/moment/comments" --include=*.ts --include=*.tsx components app lib hooks || true`,
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .filter((f) => !READERS.includes(f))
    .filter((f) => !readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').includes('normalizeMomentComments'))
  check('no unparsed reader of the comments feed exists', unguarded.length === 0, unguarded.join(', '))
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\nG6  a paid collect recorded as free silences the bell badge')
{
  // Not a fix on this branch's original five — this is the consequence chain
  // behind lib/saleConfig's newly-guarded readSalePricePerToken. An unset sale
  // row returned 0n rather than null and /api/collect overwrote the collector's
  // real price with "0", which skips isPriority's `price !== '0'` shortcut.
  // The effect is CONDITIONAL and the cases below pin both sides of it: with
  // the price intact the collect badges outright, while at "0" it falls
  // through to `isFollowing || KEY_PROFILES` — dark for a stranger, still lit
  // for a known collector. It is the badge, not the list, that goes quiet.
  const ARTIST = '0x7777777777777777777777777777777777777777'
  const B1 = '0x8888888888888888888888888888888888888881'
  const B2 = '0x8888888888888888888888888888888888888882'

  await notifications.writeNotification({
    type: 'collect', recipient: ARTIST, actor: B1,
    tokenAddress: '0xfeed', tokenId: '1', price: '1000', currency: 'eth',
  })
  const paid = inbox(ARTIST).find((n) => n.tokenId === '1')
  check('a priced collect is priority, so it reaches the badge', paid?.priority === true)

  await notifications.writeNotification({
    type: 'collect', recipient: ARTIST, actor: B2,
    tokenAddress: '0xfeed', tokenId: '2', price: '0', currency: 'eth',
  })
  const free = inbox(ARTIST).find((n) => n.tokenId === '2')
  check('  …a zero price from an UNKNOWN collector is not (the badge goes dark)',
    free?.priority === false)

  // The other side of the fall-through, so the conditionality is pinned rather
  // than implied: a collector in KEY_PROFILES badges even at price "0". Without
  // this case the suite would read as "zero price ⇒ always dark", which is the
  // overstatement the guard's comment was corrected for.
  const B3 = '0x8888888888888888888888888888888888888883'
  sets.set('kismetart:profiles', new Set([B3]))
  await notifications.writeNotification({
    type: 'collect', recipient: ARTIST, actor: B3,
    tokenAddress: '0xfeed', tokenId: '3', price: '0', currency: 'eth',
  })
  check('  …but a KNOWN collector still badges at price 0 (effect is conditional)',
    inbox(ARTIST).find((n) => n.tokenId === '3')?.priority === true)

  // The guard itself: an unset row must read as "no answer", not "free".
  // Sliced to the function body rather than regex-spanning a distance, so
  // adding or removing comment lines cannot silently break the assertion.
  const src = readFileSync(new URL('../lib/saleConfig.ts', import.meta.url), 'utf8')
  const start = src.indexOf('export async function readSalePricePerToken')
  const body = start >= 0 ? src.slice(start, src.indexOf('\nexport ', start + 1)) : ''
  check('readSalePricePerToken gates on an unset sale row like its siblings',
    body.includes('saleEnd === 0n) return null'))
}

// ════════════════════════════════════════════════════════════════════════════
console.log(failures === 0 ? '\nverify-notification-gaps: all checks passed' : `\nverify-notification-gaps: ${failures} FAILED`)
redisServer.close(); rpcServer.close()
process.exit(failures === 0 ? 0 : 1)
