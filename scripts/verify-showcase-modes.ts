// End-to-end verification of the pinned-showcase / public-view state machine.
// Boots a mock Upstash REST server (pipeline-aware, base64 response encoding,
// per-command failure injection), points the REAL lib/redis client at it, then
// drives the REAL lib/showcase.ts through every user state the feature has:
// fresh profiles, legacy (pre-rollout) pinners and all three grandfather
// paths, first pins locking 'full', unpin-all in both eras, explicit choices,
// partial and total Redis failures (fail-private), the pin cap, newest-first
// ordering, and admin erase. Hermetic — no live Redis, no env needed.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-showcase-modes.ts

import { createServer } from 'node:http'

// ── mock Upstash ────────────────────────────────────────────────────────────
const strings = new Map<string, string>()
const zsets = new Map<string, Map<string, number>>()
const fail = { all: false, cmds: new Set<string>() }

function exec(cmd: unknown[]): unknown {
  const name = String(cmd[0]).toLowerCase()
  if (fail.all || fail.cmds.has(name)) throw new Error('injected failure')
  const args = cmd.slice(1).map(String)
  switch (name) {
    case 'get': return strings.get(args[0]) ?? null
    case 'set': { strings.set(args[0], args[1]); return 'OK' }
    case 'del': { let n = 0; for (const k of args) { if (strings.delete(k)) n++; if (zsets.delete(k)) n++ } return n }
    case 'zadd': { const m = zsets.get(args[0]) ?? new Map<string, number>(); m.set(args[2], Number(args[1])); zsets.set(args[0], m); return 1 }
    case 'zcard': return zsets.get(args[0])?.size ?? 0
    case 'zscore': { const s = zsets.get(args[0])?.get(args[1]); return s === undefined ? null : s }
    case 'zrem': { const m = zsets.get(args[0]); let n = 0; for (const mem of args.slice(1)) { if (m?.delete(mem)) n++ } return n }
    case 'zrange': {
      const m = zsets.get(args[0]); if (!m) return []
      const entries = [...m.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      const rev = args.some((a) => a.toLowerCase() === 'rev')
      return (rev ? entries.reverse() : entries).map(([mem]) => mem)
    }
    default: throw new Error(`unsupported cmd ${name}`)
  }
}

// Protocol fidelity: the SDK sends `Upstash-Encoding: base64` and DECODES
// every string result except the literal "OK" (including strings nested in
// arrays) — so the mock must ENCODE them, exactly like real Upstash.
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
        : (() => { try { return { result: enc(exec(parsed)) } } catch (e) { return { error: String(e) } } })()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: String(e) }))
    }
  })
})

// ── harness ─────────────────────────────────────────────────────────────────
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}
const tick = () => new Promise((r) => setTimeout(r, 60)) // let background SETs land
const modeKey = (a: string) => `kismetart:profile-public-view:${a}`
const pinKey = (c: string, a: string) => `kismetart:pins:${c}:${a}`
const rawMode = (a: string): string | null => {
  const v = strings.get(modeKey(a)); if (v === undefined) return null
  try { return JSON.parse(v) as string } catch { return v }
}
// Seed a LEGACY pin exactly as production wrote it — the SDK sends string
// members RAW on the wire (verified by probe), so stored members are raw.
const seedLegacyPin = (a: string, cat: string, member: string, score: number) => {
  const k = pinKey(cat, a); const m = zsets.get(k) ?? new Map<string, number>()
  m.set(member, score); zsets.set(k, m)
}

await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as { port: number }).port
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${port}`
process.env.UPSTASH_REDIS_REST_TOKEN = 'sim-token'

// Dynamic import AFTER the env vars point at the mock — lib/redis.ts reads
// them at module-evaluation time.
const sc = await import(new URL('../lib/showcase.ts', import.meta.url).href)

// ── S1: fresh profile (never pinned, never chose) ───────────────────────────
console.log('S1 fresh profile')
{
  const a = '0xaaa1'
  const mode = await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a))
  check('resolves full (new default)', mode === 'full')
  await tick()
  check('no mode key materialized for the pinless long tail', rawMode(a) === null)
}

// ── S2: legacy pinner — read path grandfathers + materializes ───────────────
console.log('S2 legacy pinner, first read after rollout')
{
  const a = '0xaaa2'
  seedLegacyPin(a, 'mints', '0xc0ffee:7', 1_700_000_000_000)
  const mode = await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a))
  check('resolves curated (grandfathered)', mode === 'curated')
  await tick()
  check("materialized 'curated' in background", rawMode(a) === 'curated')
  const again = await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a))
  check('stays curated on later reads (stored)', again === 'curated')
}

// ── S3: legacy pinner unpins everything (DELETE flow), never read before ────
console.log('S3 legacy pinner unpin-all before any read')
{
  const a = '0xaaa3'
  seedLegacyPin(a, 'collected', '0xbeef:1', 1_700_000_000_001)
  await sc.ensureViewModeForPinChange(a)           // DELETE handler prelude
  await sc.removePin('collected', a, '0xBEEF', '1')
  check("prelude locked 'curated' before the unpin", rawMode(a) === 'curated')
  const mode = await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a))
  check('zero pins now, still curated (grandfather survives)', mode === 'curated')
}

// ── S4: fresh user's first pin (POST flow) ──────────────────────────────────
console.log('S4 fresh user first pin')
{
  const a = '0xaaa4'
  await sc.ensureViewModeForPinChange(a)           // POST handler prelude
  const ok = await sc.addPin('mints', a, '0xDeAd', '3')
  check('pin accepted', ok === true)
  check("prelude locked 'full' (pin = float first, not hide rest)", rawMode(a) === 'full')
  const mode = await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a))
  check('resolves full with a pin present', mode === 'full')
}

// ── S5: that user unpins everything — stays full ────────────────────────────
console.log('S5 post-rollout pinner unpin-all')
{
  const a = '0xaaa4'
  await sc.ensureViewModeForPinChange(a)
  await sc.removePin('mints', a, '0xDeAd', '3')
  const mode = await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a))
  check('still full after unpinning all (stored choice wins)', mode === 'full')
}

// ── S6: explicit choices always stick ───────────────────────────────────────
console.log('S6 explicit choices')
{
  const a = '0xaaa6' // pinless chooses curated
  await sc.setPublicViewMode(a, 'curated')
  check('pinless + explicit curated -> curated', await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a)) === 'curated')
  const b = '0xaaa7' // grandfathered pinner chooses full (the manual switch)
  seedLegacyPin(b, 'listings', '0xf00d:9', 1_700_000_000_002)
  await sc.setPublicViewMode(b, 'full')
  check('pinned + explicit full -> full (manual switch works)', await sc.resolvePublicViewMode(b, sc.getAllPinsChecked(b)) === 'full')
}

// ── S7: pins read fails, mode read fine → fail private, no bad write ────────
console.log('S7 partial failure: pins unreadable  (expect one logged best-effort line)')
{
  const a = '0xaaa8'
  fail.cmds.add('zrange')
  const mode = await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a))
  fail.cmds.delete('zrange')
  check('resolves curated (pins unknown ≠ pinless)', mode === 'curated')
  await tick()
  check('no verdict materialized off a failed read', rawMode(a) === null)
}

// ── S8: mode read fails → fail private ──────────────────────────────────────
console.log('S8 partial failure: mode unreadable')
{
  const a = '0xaaa2' // even a profile whose pins would derive curated
  fail.cmds.add('get')
  const mode = await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a))
  fail.cmds.delete('get')
  check('resolves curated on mode-read failure', mode === 'curated')
}

// ── S9: total outage → curated, ensure swallows ─────────────────────────────
console.log('S9 total outage  (expect one logged best-effort line)')
{
  const a = '0xaaa9'
  fail.all = true
  const mode = await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a))
  let ensureThrew = false
  try { await sc.ensureViewModeForPinChange(a) } catch { ensureThrew = true }
  fail.all = false
  check('resolves curated during outage', mode === 'curated')
  check('ensure swallows the failure (pin op may proceed)', !ensureThrew)
}

// ── S10: the per-category cap is enforced at MAX_PINS_PER_CATEGORY ──────────
// Derived from the real export so this suite always exercises the shipped
// cap; the explicit value check pins the product decision (6).
console.log('S10 pin cap')
{
  const a = '0xaab0'
  const CAP = sc.MAX_PINS_PER_CATEGORY as number
  check('MAX_PINS_PER_CATEGORY is 6', CAP === 6)
  await sc.ensureViewModeForPinChange(a)
  for (let i = 1; i <= CAP; i++) {
    check(`pin ${i} accepted`, await sc.addPin('mints', a, '0xCafe', String(i)) === true)
  }
  check(`pin ${CAP + 1} (distinct) rejected (409 path)`, await sc.addPin('mints', a, '0xCafe', String(CAP + 1)) === false)
  check('re-pin of existing member at cap allowed', await sc.addPin('mints', a, '0xCafe', '2') === true)
}

// ── S11: newest-pinned-first ordering through the real stack ────────────────
console.log('S11 pin ordering')
{
  const a = '0xaab1'
  await sc.addPin('mints', a, '0xAb01', '1'); await tick()
  await sc.addPin('mints', a, '0xAb01', '2'); await tick()
  await sc.addPin('mints', a, '0xAb01', '3')
  const pins = await sc.getAllPinsChecked(a)
  check('zrange REV returns newest-pinned first', JSON.stringify(pins?.mints) === JSON.stringify(['0xab01:3', '0xab01:2', '0xab01:1']))
}

// ── S12: legacy pinner pins again before any read → curated locked ──────────
console.log('S12 legacy pinner pins again pre-read')
{
  const a = '0xaab2'
  seedLegacyPin(a, 'mints', '0x1111:1', 1_700_000_000_003)
  await sc.ensureViewModeForPinChange(a)           // POST prelude
  await sc.addPin('mints', a, '0x2222', '2')
  check("prelude locked 'curated' (had pins already)", rawMode(a) === 'curated')
  check('resolves curated', await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a)) === 'curated')
}

// ── S13: admin erase resets to the fresh default ────────────────────────────
console.log('S13 admin erase')
{
  const a = '0xaaa2' // grandfathered + materialized above
  await sc.clearAllPins(a)
  check('pins gone', (await sc.getAllPinsChecked(a))?.mints.length === 0)
  check('mode key gone', rawMode(a) === null)
  check('resolves full (fresh state)', await sc.resolvePublicViewMode(a, sc.getAllPinsChecked(a)) === 'full')
}

server.close()
if (failures > 0) { console.error(`\nverify-showcase-modes: ${failures} check(s) FAILED`); process.exit(1) }
console.log('\nverify-showcase-modes: all checks passed')
