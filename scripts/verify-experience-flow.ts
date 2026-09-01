// CI oracle for the Experience FLOW — the stateful half that scripts/verify-experience.ts
// cannot reach.
//
// verify-experience.ts pins the PURE core: given a snapshot, what are the odds,
// who wins, may this machine exist. But the parts most likely to lose a player
// their artwork are not pure — they are the supply ledger, the claim state
// machine, the epoch seed, and the redraw loop, all of which live behind Redis.
// So this file boots a mock Upstash REST server, points the REAL lib/redis
// client at it, and drives the REAL lib/experience/store and
// lib/experience/runDraw through every branch. Nothing is re-implemented here;
// a behavioural change fails in CI rather than in front of someone who paid.
//
// The four defects this file exists to keep dead:
//
//   F1  buildSnapshot joined the pool to live counts with `?? 0`, but
//       getRemaining maps the -1 UNLIMITED sentinel to `null` — and `null ?? 0`
//       is 0, i.e. EXHAUSTED. Every open edition was permanently undrawable,
//       including the creator floor piece that the entire solvency model rests
//       on, and a floor-backed machine reported itself undercovered forever.
//
//   F2  A racer that lost the last copy left the counter at -1, which IS the
//       unlimited sentinel. An exhausted capped edition therefore came back as
//       infinitely drawable — over-issuing past the artist's consented supply
//       and past the edition's on-chain headroom.
//
//   F3  runDraw released a copy on the lost-race path as well, so once the
//       consume repaired its own overshoot the extra +1 minted a copy that does
//       not exist. The two roll-forward reasons are NOT symmetric and the oracle
//       pins that asymmetry.
//
//   F4  An authority failure must return the copy it genuinely held, or a
//       revoked grant silently burns a copy of an unrelated artist's edition.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-experience-flow.ts

import { createServer } from 'node:http'
import { entryKey, deriveOdds, isDrawable, selectByHash } from '../lib/experience/draw.ts'
import { runDraw } from '../lib/experience/runDraw.ts'
import { commitmentFor, drawHash, epochFor, snapshotHash, verifyDraw } from '../lib/experience/fairness.ts'
import { coverage } from '../lib/experience/solvency.ts'
import type { ClaimRecord, PoolEntry, SnapshotEntry } from '../lib/experience/types.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// ─── mock Upstash (hash-aware) ───────────────────────────────────────────────
// Only the commands lib/experience/store actually issues. An unsupported command
// THROWS rather than returning a plausible zero, so a future store change that
// reaches for a primitive this mock does not model fails loudly here instead of
// silently testing nothing.

const strings = new Map<string, string>()
const hashes = new Map<string, Map<string, string>>()
const zsets = new Map<string, Map<string, number>>()
/** Every command the store issued, for assertions ABOUT the calls themselves
 *  (e.g. that a claim key is never given a TTL). */
const log: string[][] = []

function exec(cmd: unknown[]): unknown {
  const name = String(cmd[0]).toLowerCase()
  const args = cmd.slice(1).map(String)
  log.push([name, ...args])
  const k = args[0]
  switch (name) {
    case 'get':
      return strings.get(k) ?? null
    case 'set': {
      const nx = args.some((a) => a.toLowerCase() === 'nx')
      if (nx && strings.has(k)) return null
      strings.set(k, args[1])
      return 'OK'
    }
    case 'del': {
      let n = 0
      for (const key of args) {
        if (strings.delete(key)) n++
        if (hashes.delete(key)) n++
        if (zsets.delete(key)) n++
      }
      return n
    }
    case 'incrby': {
      const cur = parseInt(strings.get(k) ?? '0', 10)
      const next = (Number.isFinite(cur) ? cur : 0) + Number(args[1])
      strings.set(k, String(next))
      return next
    }
    case 'hset': {
      const m = hashes.get(k) ?? new Map<string, string>()
      for (let i = 1; i < args.length; i += 2) m.set(args[i], args[i + 1])
      hashes.set(k, m)
      return 1
    }
    case 'hget':
      return hashes.get(k)?.get(args[1]) ?? null
    case 'hgetall': {
      const m = hashes.get(k)
      if (!m) return []
      const out: string[] = []
      for (const [f, v] of m) out.push(f, v)
      return out
    }
    case 'hdel': {
      const m = hashes.get(k)
      let n = 0
      for (const f of args.slice(1)) if (m?.delete(f)) n++
      return n
    }
    case 'hincrby': {
      // The real primitive: read-modify-write is atomic server-side, which is
      // exactly why a racer can observe a negative value it must repair.
      const m = hashes.get(k) ?? new Map<string, string>()
      hashes.set(k, m)
      const cur = parseInt(m.get(args[1]) ?? '0', 10)
      const next = (Number.isFinite(cur) ? cur : 0) + Number(args[2])
      m.set(args[1], String(next))
      return next
    }
    case 'zadd': {
      const m = zsets.get(k) ?? new Map<string, number>()
      const rest = args.slice(1).filter((a) => !['nx', 'xx', 'gt', 'lt', 'ch'].includes(a.toLowerCase()))
      m.set(rest[1], Number(rest[0]))
      zsets.set(k, m)
      return 1
    }
    case 'zrange': {
      const m = zsets.get(k)
      if (!m) return []
      let entries = [...m.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      const flags = args.map((a) => a.toLowerCase())
      const start = Number(args[1])
      const stop = Number(args[2])
      if (Number.isFinite(start) && Number.isFinite(stop)) {
        const n = entries.length
        const a = start < 0 ? Math.max(0, n + start) : start
        const b = stop < 0 ? n + stop : Math.min(n - 1, stop)
        entries = b < a ? [] : entries.slice(a, b + 1)
      }
      return (flags.includes('rev') ? entries.reverse() : entries).map(([mem]) => mem)
    }
    case 'zremrangebyrank': {
      const m = zsets.get(k)
      if (!m) return 0
      const sorted = [...m.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      const n = sorted.length
      const start = Number(args[1])
      const stop = Number(args[2])
      const a = start < 0 ? Math.max(0, n + start) : start
      const b = stop < 0 ? n + stop : Math.min(n - 1, stop)
      if (b < a) return 0
      for (const [mem] of sorted.slice(a, b + 1)) m.delete(mem)
      return b - a + 1
    }
    default:
      throw new Error(`unsupported cmd ${name}`)
  }
}

// Protocol fidelity: the SDK sends `Upstash-Encoding: base64` and decodes every
// string result except the literal "OK", so the mock must encode them.
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
function encodeResult(v: unknown): unknown {
  if (typeof v === 'string') return v === 'OK' ? 'OK' : b64(v)
  if (Array.isArray(v)) return v.map(encodeResult)
  return v
}

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      const useB64 = req.headers['upstash-encoding'] === 'base64'
      const enc = (v: unknown) => (useB64 ? encodeResult(v) : v)
      const parsed = JSON.parse(body) as unknown[]
      const isPipeline = Array.isArray(parsed[0])
      const out = isPipeline
        ? (parsed as unknown[][]).map((c) => {
            try { return { result: enc(exec(c)) } } catch (e) { return { error: String(e) } }
          })
        : (() => {
            try { return { result: enc(exec(parsed)) } } catch (e) { return { error: String(e) } }
          })()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    } catch (e) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
})

await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as { port: number }).port
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${port}`
process.env.UPSTASH_REDIS_REST_TOKEN = 'sim-token'

// Imported AFTER the env is wired, so lib/redis reads the mock's URL at module
// scope. This is the REAL store — every assertion below is about production code.
const store = await import(new URL('../lib/experience/store.ts', import.meta.url).href)

// ─── fixtures ────────────────────────────────────────────────────────────────

const CREATOR = '0xc0ffee0000000000000000000000000000000001'
const ART_A = '0xa1000000000000000000000000000000000000a1'
const ART_B = '0xb2000000000000000000000000000000000000b2'
const COLL = '0xdddd000000000000000000000000000000000001'

const entry = (over: Partial<PoolEntry> = {}): PoolEntry => ({
  collection: COLL,
  tokenId: '1',
  artist: ART_A,
  weight: 10,
  supply: 5,
  ...over,
})

/** A hash that makes selectByHash land on cumulative offset `n`. selectByHash
 *  reads the first 128 bits and reduces modulo Σweight, so an exact target lets
 *  a test steer the draw without searching for a seed. */
const hashForTarget = (n: number): string => n.toString(16).padStart(32, '0') + '0'.repeat(32)

/** Read one entry's raw remaining counter through the REAL getRemaining. */
async function remainingOf(machineId: string, e: PoolEntry): Promise<number | null> {
  const r = await store.getRemaining(machineId)
  return r[entryKey(e)]
}

// ═══ 1. buildSnapshot: unlimited and absent are OPPOSITE, not both zero ══════
console.log('\n1. buildSnapshot join semantics (F1)')
{
  const open = entry({ tokenId: '10', supply: 0, artist: CREATOR })
  const capped = entry({ tokenId: '11', supply: 3 })
  const pool = [open, capped]

  // The exact shape getRemaining produces: -1 sentinel -> null.
  const live: Record<string, number | null> = {
    [entryKey(open)]: null,
    [entryKey(capped)]: 3,
  }
  const snap = store.buildSnapshot(pool, live) as SnapshotEntry[]

  check('an unlimited entry freezes as null, not 0', snap[0].remaining === null,
    `got ${String(snap[0].remaining)}`)
  check('an unlimited entry is therefore drawable', isDrawable(snap[0]))
  check('a capped entry keeps its count', snap[1].remaining === 3)

  // The failure that made this matter: a floor-backed machine could never
  // dispense its floor piece, and reported itself undercovered forever.
  const odds = deriveOdds(snap)
  check('the floor piece carries real probability', odds[0].probability > 0)
  const remainingPrizes = snap.some((e) => e.remaining === null)
    ? null
    : snap.reduce((s, e) => s + (e.remaining ?? 0), 0)
  check('a floor-backed pool reports unbounded prizes', remainingPrizes === null)
  check(
    'and therefore reads as covered against an open-edition capsule',
    coverage({ capsuleMaxSupply: null, capsuleMinted: 0, remainingPrizes }).covered,
  )

  // An ABSENT counter is a different thing and must still fail closed.
  const orphan = store.buildSnapshot([entry({ tokenId: '99' })], {}) as SnapshotEntry[]
  check('an entry with no counter at all fails closed at 0', orphan[0].remaining === 0)
  check('and is not drawable', !isDrawable(orphan[0]))
}

// ═══ 2. the supply ledger, against the real Redis-backed store ══════════════
console.log('\n2. supply ledger (F2)')
{
  const M = 'ledger-machine'
  const capped = entry({ tokenId: '20', supply: 2 })
  const open = entry({ tokenId: '21', supply: 0, artist: CREATOR })
  await store.putPoolEntry(M, capped)
  await store.putPoolEntry(M, open)

  check('putPoolEntry seeds a capped counter with its supply', (await remainingOf(M, capped)) === 2)
  check('putPoolEntry seeds an unlimited counter as null', (await remainingOf(M, open)) === null)

  check('consuming a capped copy returns the post-decrement count',
    (await store.consumeOne(M, entryKey(capped))) === 1)
  check('releasing it puts the copy back', (await store.releaseOne(M, entryKey(capped)),
    (await remainingOf(M, capped)) === 2))

  check('consuming an unlimited entry returns null', (await store.consumeOne(M, entryKey(open))) === null)
  check('and never decrements the sentinel', (await remainingOf(M, open)) === null)
  await store.releaseOne(M, entryKey(open))
  check('releasing an unlimited entry is a no-op', (await remainingOf(M, open)) === null)
}

console.log('\n3. the last-copy race never aliases onto the unlimited sentinel (F2)')
{
  const M = 'race-machine'
  const last = entry({ tokenId: '30', supply: 1 })
  await store.putPoolEntry(M, last)

  // Three plays reach for one copy at once — the real production shape.
  const results = await Promise.all([
    store.consumeOne(M, entryKey(last)),
    store.consumeOne(M, entryKey(last)),
    store.consumeOne(M, entryKey(last)),
  ])
  const winners = results.filter((r): r is number => r !== null && r >= 0)
  const losers = results.filter((r): r is number => r !== null && r < 0)

  check('exactly one caller wins the last copy', winners.length === 1, `winners=${JSON.stringify(results)}`)
  check('the other two see a negative count', losers.length === 2)

  const after = await remainingOf(M, last)
  check('the counter settles at 0, not negative', after === 0, `got ${String(after)}`)
  check('and is NOT read back as unlimited', after !== null, `got ${String(after)}`)

  const snap = store.buildSnapshot([last], await store.getRemaining(M)) as SnapshotEntry[]
  check('the exhausted edition is undrawable afterwards', !isDrawable(snap[0]))
}

// ═══ 4. runDraw, every branch, over the real ledger ══════════════════════════
console.log('\n4. runDraw branches')

/** Wire runDraw to the REAL store, with authority and hashing injected. */
function effectsFor(machineId: string, opts: {
  blocked?: Set<string>
  targets?: number[]
  releases: string[]
}) {
  return {
    consume: (key: string) => store.consumeOne(machineId, key) as Promise<number | null>,
    release: async (key: string) => {
      opts.releases.push(key)
      await store.releaseOne(machineId, key)
    },
    authority: async (e: SnapshotEntry) => !opts.blocked?.has(entryKey(e)),
    hash: (attempt: number) => hashForTarget(opts.targets ? opts.targets[attempt] ?? 0 : 0),
  }
}

{
  // 4a — happy path
  const M = 'draw-happy'
  const a = entry({ tokenId: '40', supply: 4, weight: 10 })
  const b = entry({ tokenId: '41', supply: 4, weight: 10, artist: ART_B })
  await store.putPoolEntry(M, a)
  await store.putPoolEntry(M, b)
  const snap = store.buildSnapshot([a, b], await store.getRemaining(M)) as SnapshotEntry[]

  const releases: string[] = []
  // target 0 lands inside a's [0,10) band.
  const res = await runDraw(snap, effectsFor(M, { targets: [0], releases }), 6)
  check('a clean draw returns drawn', res.kind === 'drawn')
  check('on attempt 0', res.attempt === 0)
  check('with the entry the hash selected', res.kind === 'drawn' && res.prize.tokenId === '40')
  check('consuming exactly one copy of it', (await remainingOf(M, a)) === 3)
  check('and touching nothing else', (await remainingOf(M, b)) === 4)
  check('with no release on the success path', releases.length === 0)
}

{
  // 4b — revoked grant: the copy WAS held, so it must come back (F4)
  const M = 'draw-revoked'
  const a = entry({ tokenId: '50', supply: 4, weight: 10 })
  const b = entry({ tokenId: '51', supply: 4, weight: 10, artist: ART_B })
  await store.putPoolEntry(M, a)
  await store.putPoolEntry(M, b)
  const snap = store.buildSnapshot([a, b], await store.getRemaining(M)) as SnapshotEntry[]

  const releases: string[] = []
  const res = await runDraw(
    snap,
    effectsFor(M, { blocked: new Set([entryKey(a)]), targets: [0, 0], releases }),
    6,
  )
  check('a revoked grant rolls forward to a redraw', res.kind === 'drawn' && res.attempt === 1)
  check('and never returns the revoked piece', res.kind === 'drawn' && res.prize.tokenId === '51')
  check('the revoked entry gets its copy back', (await remainingOf(M, a)) === 4)
  check('exactly one release was issued', releases.length === 1 && releases[0] === entryKey(a))
  check('the delivered entry is decremented', (await remainingOf(M, b)) === 3)
}

{
  // 4c — lost race: the copy was NEVER held, so releasing would mint one (F3)
  const M = 'draw-race'
  const a = entry({ tokenId: '60', supply: 1, weight: 10 })
  const b = entry({ tokenId: '61', supply: 4, weight: 10, artist: ART_B })
  await store.putPoolEntry(M, a)
  await store.putPoolEntry(M, b)
  // Freeze while a still shows a copy, then let a concurrent play take it —
  // exactly the stale-snapshot window the redraw exists for.
  const snap = store.buildSnapshot([a, b], await store.getRemaining(M)) as SnapshotEntry[]
  check('the snapshot was frozen with the copy still present', snap[0].remaining === 1)
  await store.consumeOne(M, entryKey(a)) // the other player wins it
  check('the other play took it', (await remainingOf(M, a)) === 0)

  const releases: string[] = []
  const res = await runDraw(snap, effectsFor(M, { targets: [0, 0], releases }), 6)
  check('losing the race rolls forward', res.kind === 'drawn' && res.attempt === 1)
  check('to a different entry', res.kind === 'drawn' && res.prize.tokenId === '61')
  check('NO release is issued for a copy never held', releases.length === 0)
  const aAfter = await remainingOf(M, a)
  check('the raced entry stays exhausted at 0', aAfter === 0, `got ${String(aAfter)}`)
  check('it did not become unlimited', aAfter !== null)
}

{
  // 4d — exhausted pool: every entry rejected, every copy conserved
  const M = 'draw-exhausted'
  const a = entry({ tokenId: '70', supply: 2, weight: 10 })
  const b = entry({ tokenId: '71', supply: 2, weight: 10, artist: ART_B })
  await store.putPoolEntry(M, a)
  await store.putPoolEntry(M, b)
  const snap = store.buildSnapshot([a, b], await store.getRemaining(M)) as SnapshotEntry[]

  const releases: string[] = []
  const res = await runDraw(
    snap,
    effectsFor(M, { blocked: new Set([entryKey(a), entryKey(b)]), targets: [0, 0, 0], releases }),
    6,
  )
  check('a fully unauthorised pool is exhausted', res.kind === 'exhausted')
  check('after trying every entry', res.attempt === 2)
  check('and the ledger is fully conserved', (await remainingOf(M, a)) === 2 && (await remainingOf(M, b)) === 2)
  check('one release per attempt', releases.length === 2)
}

{
  // 4e — attempt ceiling: stop grinding, pend loudly
  const M = 'draw-ceiling'
  const many: PoolEntry[] = []
  for (let i = 0; i < 8; i++) many.push(entry({ tokenId: `8${i}`, supply: 2, weight: 10 }))
  for (const e of many) await store.putPoolEntry(M, e)
  const snap = store.buildSnapshot(many, await store.getRemaining(M)) as SnapshotEntry[]

  const releases: string[] = []
  const res = await runDraw(
    snap,
    effectsFor(M, { blocked: new Set(many.map(entryKey)), targets: [0, 0, 0, 0], releases }),
    3,
  )
  check('the redraw ceiling is honoured', res.kind === 'exhausted' && res.attempt === 3)
  check('the pool was NOT drained past the ceiling', releases.length === 3)
  const counts = await Promise.all(many.map((e) => remainingOf(M, e)))
  check('and every copy is still there', counts.every((c) => c === 2))
}

{
  // 4f — degenerate inputs
  const releases: string[] = []
  let consumed = 0
  let hashed = 0
  const spy = {
    consume: async (_k: string) => { consumed++; return 0 },
    release: async (k: string) => { releases.push(k) },
    authority: async () => true,
    hash: (a: number) => { hashed++; return hashForTarget(a) },
  }
  const empty = await runDraw([], spy, 6)
  check('an empty snapshot is exhausted at attempt 0', empty.kind === 'exhausted' && empty.attempt === 0)
  check('and consumes nothing', consumed === 0)

  const zero = await runDraw([{ ...entry(), remaining: 5 }], spy, 0)
  check('maxAttempts 0 is exhausted at attempt 0', zero.kind === 'exhausted' && zero.attempt === 0)
  check('and does not even hash', hashed === 1, `hashed=${hashed}`)
  check('nor release', releases.length === 0)
}

{
  // 4g — an unlimited entry draws without ever being decremented
  const M = 'draw-open'
  const floor = entry({ tokenId: '90', supply: 0, artist: CREATOR })
  await store.putPoolEntry(M, floor)
  const snap = store.buildSnapshot([floor], await store.getRemaining(M)) as SnapshotEntry[]
  const releases: string[] = []
  const res = await runDraw(snap, effectsFor(M, { targets: [0], releases }), 6)
  check('the floor piece is drawable', res.kind === 'drawn' && res.prize.tokenId === '90')
  check('and is never decremented', (await remainingOf(M, floor)) === null)
  check('a null consume is not mistaken for a lost race', res.kind === 'drawn' && res.attempt === 0)
}

{
  // 4h — determinism: the same frozen snapshot and seed give the same answer
  const snap: SnapshotEntry[] = [
    { ...entry({ tokenId: 'd1', weight: 30 }), remaining: 9 },
    { ...entry({ tokenId: 'd2', weight: 70, artist: ART_B }), remaining: 9 },
  ]
  const seed = 'a'.repeat(64)
  const tx = '0x' + 'c'.repeat(64)
  const inert = {
    consume: async () => 5,
    release: async () => {},
    authority: async () => true,
    hash: (attempt: number) => drawHash({ serverSeed: seed, txHash: tx, unitIndex: 0, attempt }),
  }
  const one = await runDraw(snap, inert, 6)
  const two = await runDraw(snap, inert, 6)
  check('two runs over one frozen snapshot agree',
    one.kind === 'drawn' && two.kind === 'drawn' && one.prize.tokenId === two.prize.tokenId)
  check('and a different unit is an independent draw',
    selectByHash(snap, drawHash({ serverSeed: seed, txHash: tx, unitIndex: 0, attempt: 0 })) !== null &&
    drawHash({ serverSeed: seed, txHash: tx, unitIndex: 0, attempt: 0 }) !==
      drawHash({ serverSeed: seed, txHash: tx, unitIndex: 1, attempt: 0 }))
}

// ═══ 5. the claim state machine ══════════════════════════════════════════════
console.log('\n5. claims are an obligation, not a flag')
{
  const M = 'claim-machine'
  const tx = '0x' + '1'.repeat(64)
  const rec: ClaimRecord = {
    machineId: M,
    claimant: '0x' + '9'.repeat(40),
    txHash: tx,
    unitIndex: 0,
    state: 'claimed',
    createdAt: 1,
  }
  check('the first claim wins', (await store.createClaim(rec)) === true)
  check('a replay does not', (await store.createClaim(rec)) === false)

  // A second unit of the same capsule mint is a SEPARATE claim — collapsing
  // them would silently swallow N-1 paid plays.
  check('unit 1 of the same tx is its own claim',
    (await store.createClaim({ ...rec, unitIndex: 1 })) === true)

  const frozen = await store.advanceClaim(rec, {
    state: 'frozen',
    snapshot: [{ ...entry(), remaining: 5 }],
    snapshotHash: 'deadbeef',
    epoch: '2026-01-01',
  })
  check('advanceClaim moves the state', frozen.state === 'frozen')
  check('and preserves the identity fields', frozen.txHash === tx && frozen.claimant === rec.claimant)

  const read = (await store.getClaim(M, tx, 0)) as ClaimRecord
  check('the advanced claim is what a replay reads back', read.state === 'frozen' && read.epoch === '2026-01-01')
  check('unit 1 is untouched by unit 0 advancing',
    ((await store.getClaim(M, tx, 1)) as ClaimRecord).state === 'claimed')

  // No TTL until terminal. An expiring claim is a paid play with no evidence of
  // what was owed.
  const claimKey = `kismetart:xp:${M}:claim:${tx}:0`
  const ttlOnClaim = log.some(
    (c) =>
      (c[0] === 'expire' || c[0] === 'pexpire' || c[0] === 'expireat') && c[1] === claimKey,
  )
  const setWithTtl = log.some(
    (c) => c[0] === 'set' && c[1] === claimKey && c.some((a) => ['ex', 'px', 'exat', 'pxat'].includes(a.toLowerCase())),
  )
  check('a live claim is never given a TTL', !ttlOnClaim && !setWithTtl)
}

console.log('\n5b. a machine id is claimed, not just checked')
{
  const base = {
    id: 'contested',
    creator: CREATOR,
    name: 'first',
    state: 'draft' as const,
    capsule: { collection: COLL, tokenId: '1' },
    capsuleMaxSupply: 100,
    createdAt: 1,
  }
  check('the first creator claims the id', (await store.createMachine(base)) === true)
  check('a second creator cannot overwrite it',
    (await store.createMachine({ ...base, creator: ART_B, name: 'second' })) === false)
  const held = await store.getMachine('contested')
  check('and the winner keeps the record', held.creator === CREATOR && held.name === 'first')

  // Publish-last: a machine is inert until its pool exists.
  check('a reserved machine starts as a draft', held.state === 'draft')
  check('drafts are not listed publicly',
    ((await store.listMachines(['live', 'ended'])) as { id: string }[]).every((m) => m.id !== 'contested'))
  const live = await store.setMachineState('contested', 'live')
  check('promotion flips it live', live.state === 'live')
  check('and only then is it listed',
    ((await store.listMachines(['live'])) as { id: string }[]).some((m) => m.id === 'contested'))
  check('while its identity is untouched by the flip', live.creator === CREATOR && live.name === 'first')
}

// ═══ 6. epoch seeds: fixed in advance, revealed only once closed ════════════
console.log('\n6. commit and reveal')
{
  const M = 'seed-machine'
  const epoch = '2026-01-01'
  const first = await store.seedForEpoch(M, epoch)
  const second = await store.seedForEpoch(M, epoch)
  check('the first caller fixes the epoch seed', first.seed === second.seed)
  check('and no later caller can replace it', first.commitment === second.commitment)
  check('the commitment is sha256 of the seed', first.commitment === commitmentFor(first.seed))
  check('the public commitment matches without exposing the seed',
    (await store.commitmentForEpoch(M, epoch)) === first.commitment)

  check('a live epoch NEVER reveals its seed', (await store.revealSeed(M, epoch, epoch)) === null)
  check('a future epoch does not either', (await store.revealSeed(M, '2026-01-02', epoch)) === null)
  check('a closed epoch reveals', (await store.revealSeed(M, epoch, '2026-01-02')) === first.seed)
  check('an unopened epoch has no commitment', (await store.commitmentForEpoch(M, '2020-01-01')) === null)
  check('epochFor is the UTC calendar day', epochFor(Date.UTC(2026, 0, 1, 23, 59, 59)) === '2026-01-01')
}

// ═══ 7. end to end: play, then verify the receipt reproduces it ═════════════
console.log('\n7. a whole play, then its receipt')
{
  const M = 'e2e-machine'
  const epoch = '2026-03-01'
  const tx = '0x' + '7'.repeat(64)
  const a = entry({ tokenId: 'e1', supply: 3, weight: 40 })
  const b = entry({ tokenId: 'e2', supply: 3, weight: 60, artist: ART_B })
  await store.putPoolEntry(M, a)
  await store.putPoolEntry(M, b)

  // Freeze exactly as the route does.
  const snapshot = store.buildSnapshot([a, b], await store.getRemaining(M)) as SnapshotEntry[]
  const sHash = snapshotHash(snapshot)
  const { seed, commitment } = await store.seedForEpoch(M, epoch)

  const res = await runDraw(snapshot, {
    consume: (k: string) => store.consumeOne(M, k) as Promise<number | null>,
    release: (k: string) => store.releaseOne(M, k) as Promise<void>,
    authority: async () => true,
    hash: (attempt: number) => drawHash({ serverSeed: seed, txHash: tx, unitIndex: 0, attempt }),
  }, 6)
  check('the play draws', res.kind === 'drawn')
  const prize = res.kind === 'drawn' ? res.prize : null

  // Now the verifier's job, with only what /api/experience/verify publishes.
  const v = verifyDraw({
    serverSeed: seed,
    commitment,
    snapshot,
    snapshotHash: sHash,
    txHash: tx,
    unitIndex: 0,
    attempt: res.attempt,
  })
  check('the published seed matches the published commitment', v.ok)
  const recomputed = v.ok && v.hash ? selectByHash(snapshot, v.hash) : null
  check('and an independent recomputation lands on the delivered prize',
    !!prize && recomputed?.tokenId === prize.tokenId)

  // The half the industry omits: a tampered weight table must fail even though
  // the seed still verifies.
  const rigged = snapshot.map((e) => (e.tokenId === 'e1' ? { ...e, weight: 999 } : e))
  const tampered = verifyDraw({
    serverSeed: seed, commitment, snapshot: rigged, snapshotHash: sHash,
    txHash: tx, unitIndex: 0, attempt: res.attempt,
  })
  check('a valid seed over a rigged weight table FAILS', !tampered.ok)
  check('and says why', (tampered.reason ?? '').includes('weight table'))

  // The play feed is a feed, never the source of truth.
  await store.recordPlay(M, '0x' + '5'.repeat(40), tx)
  const plays = (await store.recentPlays(M, 5)) as { player: string; txHash: string }[]
  check('the play is recorded for the public feed', plays.length === 1 && plays[0].txHash === tx)
  check('and attributed to the player', plays[0].player === '0x' + '5'.repeat(40))
  check('played tx hashes are queryable per player',
    (await store.playedTxHashes(M, '0x' + '5'.repeat(40)) as Set<string>).has(tx))

  // Spark is denominated in plays, never money.
  check('a play credits exactly one spark', (await store.addSpark(M, '0x' + '5'.repeat(40), 1)) === 1)
  check('and reads back', (await store.getSpark(M, '0x' + '5'.repeat(40))) === 1)
}

// ═══ 8. the cross-machine commitment ledger ═════════════════════════════════
console.log('\n8. two machines cannot promise the same copy')
{
  await store.pledgeSupply(COLL, 'x1', 'machine-one', 4)
  await store.pledgeSupply(COLL, 'x1', 'machine-two', 3)
  check('a machine does not count its own pledge against itself',
    (await store.otherPledges(COLL, 'x1', 'machine-one')) === 3)
  check('and sees every other machine that pledged',
    (await store.otherPledges(COLL, 'x1', 'machine-two')) === 4)
  await store.releasePledge(COLL, 'x1', 'machine-two')
  check('releasing a pledge frees the headroom',
    (await store.otherPledges(COLL, 'x1', 'machine-one')) === 0)
  check('an unpledged edition is clear', (await store.otherPledges(COLL, 'x9', 'machine-one')) === 0)
}

// ═══ 9. operator identity: the grant and the signer must be the same account ══
console.log('\n9. operator identity')
{
  const authority = await import(new URL('../lib/experience/authority.ts', import.meta.url).href)
  const saved = process.env.EXPERIENCE_OPERATOR_ADDRESSES

  process.env.EXPERIENCE_OPERATOR_ADDRESSES = ''
  check('no configured operator means no authority at all',
    (await authority.checkPrizeAuthority({ collection: COLL, tokenId: '1' })).ok === false)

  const opA = '0x' + 'a'.repeat(40)
  const opB = '0x' + 'b'.repeat(40)
  process.env.EXPERIENCE_OPERATOR_ADDRESSES = ` ${opA.toUpperCase()} , ${opB} , not-an-address ,`
  const parsed = authority.operatorAddresses() as string[]
  check('the operator list is order-preserving', parsed[0] === opA && parsed[1] === opB)
  check('lowercased', parsed.every((a) => a === a.toLowerCase()))
  check('and junk entries are dropped rather than coerced', parsed.length === 2)

  process.env.EXPERIENCE_OPERATOR_ADDRESSES = saved ?? ''

  // Delivery fails CLOSED on missing credentials — before the Redis lock and
  // before anything is broadcast.
  const delivery = await import(new URL('../lib/experience/delivery.ts', import.meta.url).href)
  const creds = {
    id: process.env.CDP_API_KEY_ID,
    secret: process.env.CDP_API_KEY_SECRET,
    wallet: process.env.CDP_WALLET_SECRET,
  }
  delete process.env.CDP_API_KEY_ID
  delete process.env.CDP_API_KEY_SECRET
  delete process.env.CDP_WALLET_SECRET
  let broadcast = false
  const out = await delivery.deliverPrize({
    collection: COLL,
    tokenId: '1',
    player: '0x' + '3'.repeat(40),
    operator: opA,
    onBroadcast: async () => { broadcast = true },
  })
  check('unconfigured delivery is unavailable, not an exception', out.kind === 'unavailable')
  check('and nothing was ever broadcast', !broadcast)
  if (creds.id) process.env.CDP_API_KEY_ID = creds.id
  if (creds.secret) process.env.CDP_API_KEY_SECRET = creds.secret
  if (creds.wallet) process.env.CDP_WALLET_SECRET = creds.wallet

  // The prize mint itself: adminMint(to, id, 1, 0x) carrying Kismet's ERC-8021
  // attribution, exactly like every other write on the platform.
  const viem = await import('viem')
  const builder = await import(new URL('../lib/builderCode.ts', import.meta.url).href)
  const player = '0x' + '4'.repeat(40)
  const { data } = delivery.buildAdminMintCall(player, '77') as { data: string }
  const selector = viem.toFunctionSelector('adminMint(address,uint256,uint256,bytes)')
  check('the prize call is adminMint', data.startsWith(selector))
  const suffix = builder.BUILDER_DATA_SUFFIX as string | undefined
  check('with the builder attribution suffix appended',
    !suffix || data.endsWith(suffix.slice(2)))
  const bare = suffix ? data.slice(0, data.length - (suffix.length - 2)) : data
  const collections = await import(new URL('../lib/collections.ts', import.meta.url).href)
  const decoded = viem.decodeFunctionData({ abi: collections.COLLECTION_ABI, data: bare as `0x${string}` })
  check('minting exactly one copy to the winner',
    decoded.args?.[0] === viem.getAddress(player) &&
    decoded.args?.[1] === 77n &&
    decoded.args?.[2] === 1n)
}

server.close()
console.log(failures > 0 ? `\n${failures} FAILURE(S)\n` : '\nAll experience flow invariants hold.\n')
if (failures > 0) process.exit(1)
