// Verifies /api/img's resized-variant disk cache + single-flight coalescing
// (lib/media/imgVariantCache).
//
// THE COST IT GUARDS: sources past the next/image optimizer's size limit
// (the Patron Collection's physical-artwork scans — e.g. the featured
// "Facing Desolation" mint pass) fall back to /api/img?w=, which used to
// re-download the full multi-MB source and re-run the sharp resize on EVERY
// request. These checks pin the cache-key math (width bucketing bounds the
// per-asset variant count), the atomic write→read round trip, LRU eviction
// ordering (+ stale .tmp reaping), and the coalescer's one-compute-per-key
// semantics that keep a cold drop-time burst from fanning out N downloads.
//
// Run: node --experimental-strip-types scripts/verify-img-cache.ts

import { mkdtemp, readdir, stat, utimes, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bucketWidth,
  evictOverCap,
  readVariant,
  SingleFlight,
  variantFileName,
  writeVariant,
} from '../lib/media/imgVariantCache.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// ---- bucketWidth: bounds the per-asset variant set ----
check('2048 (the one real producer) buckets to itself', bucketWidth(2048) === 2048)
check('tiny widths land in the smallest bucket', bucketWidth(1) === 256)
check('widths snap UP, never down', bucketWidth(257) === 512)
check('1080 (a next/image breakpoint) → 2048', bucketWidth(1080) === 2048)
check('exact bucket boundaries map to themselves', bucketWidth(1024) === 1024)
check('past the top bucket clamps to 4096', bucketWidth(9999) === 4096)

// ---- variantFileName: stable, distinct, filesystem-safe ----
const U = 'ar://nKPQRtSGwlgpHXffkW4ngRJOwYjJUCtMCKDae2c_bWI'
check('stable for the same inputs', variantFileName(U, 2048) === variantFileName(U, 2048))
check('distinct per width', variantFileName(U, 2048) !== variantFileName(U, 1024))
check('distinct per source', variantFileName(U, 2048) !== variantFileName('ar://other', 2048))
check(
  'safe flat filename (uri chars hashed away)',
  /^v1-[0-9a-f]{64}-w2048\.webp$/.test(variantFileName(U, 2048)),
  variantFileName(U, 2048),
)

// ---- disk round trip ----
const dir = await mkdtemp(join(tmpdir(), 'img-cache-'))
const name = variantFileName(U, 2048)
check('read before write → miss', (await readVariant(dir, name)) === null)
check('read on a missing dir → miss, not throw', (await readVariant(join(dir, 'nope'), name)) === null)
await writeVariant(dir, name, Buffer.from('webp-bytes'))
const hit = await readVariant(dir, name)
check('write → read round trip', hit !== null && hit.toString() === 'webp-bytes')
check('no .tmp strays after an atomic write', (await readdir(dir)).every((n) => !n.endsWith('.tmp')))
{
  // A hit must refresh mtime so the eviction sweep's oldest-first order is
  // LRU. Backdate the file, read it, expect a recent mtime again.
  const file = join(dir, name)
  const past = new Date(Date.now() - 60_000)
  await utimes(file, past, past)
  await readVariant(dir, name)
  // The touch is fire-and-forget — give it a beat.
  await new Promise((r) => setTimeout(r, 50))
  const after = (await stat(file)).mtimeMs
  check('read refreshes mtime (LRU recency)', Date.now() - after < 5_000, `mtime age ${Date.now() - after}ms`)
}

// ---- eviction: oldest-mtime first, down to target, .tmp hygiene ----
{
  const evDir = await mkdtemp(join(tmpdir(), 'img-evict-'))
  const mk = async (n: string, size: number, ageMs: number) => {
    await writeFile(join(evDir, n), Buffer.alloc(size))
    const t = new Date(Date.now() - ageMs)
    await utimes(join(evDir, n), t, t)
  }
  await mk('old.webp', 100, 60_000)
  await mk('mid.webp', 100, 30_000)
  await mk('new.webp', 100, 1_000)
  await mk('stale.tmp', 10, 2 * 60 * 60 * 1000) // crashed mid-write, hours old
  await mk('fresh.tmp', 10, 1_000) // in-flight write — must survive
  // 300 variant bytes > 250 cap → evict oldest until ≤ 225 (0.9 × cap):
  // exactly old.webp goes (300 → 200).
  await evictOverCap(evDir, 250)
  await new Promise((r) => setTimeout(r, 50)) // stray-.tmp rm is fire-and-forget
  const left = new Set(await readdir(evDir))
  check('oldest variant evicted first', !left.has('old.webp'), [...left].join(','))
  check('recently-used variants survive', left.has('mid.webp') && left.has('new.webp'))
  check('stale .tmp stray reaped', !left.has('stale.tmp'))
  check('fresh .tmp (in-flight write) kept', left.has('fresh.tmp'))
  await rm(evDir, { recursive: true, force: true })
}
{
  // Under-cap directory: nothing evicted.
  const okDir = await mkdtemp(join(tmpdir(), 'img-undercap-'))
  await writeFile(join(okDir, 'a.webp'), Buffer.alloc(50))
  await evictOverCap(okDir, 250)
  check('under-cap sweep is a no-op', (await readdir(okDir)).includes('a.webp'))
  await rm(okDir, { recursive: true, force: true })
}

// ---- SingleFlight: one compute per key, shared result, clean retry ----
{
  const flight = new SingleFlight<string>()
  let computes = 0
  const slow = () =>
    new Promise<string>((resolve) => setTimeout(() => { computes++; resolve('result') }, 30))
  const [a, b, c] = await Promise.all([
    flight.run('k', slow),
    flight.run('k', slow),
    flight.run('k', slow),
  ])
  check(
    'concurrent same-key callers share ONE compute',
    computes === 1 && a === 'result' && b === 'result' && c === 'result',
    `computes=${computes}`,
  )
  check('slot clears after settle', flight.size === 0)
  const d = await flight.run('k', async () => { computes++; return 'second' })
  check('post-settle run computes fresh', d === 'second' && computes === 2)

  let failComputes = 0
  const failing = () => { failComputes++; return Promise.reject(new Error('boom')) }
  const settled = await Promise.allSettled([flight.run('f', failing), flight.run('f', failing)])
  check(
    'rejection fans out to every waiter from ONE compute',
    failComputes === 1 && settled.every((s) => s.status === 'rejected'),
    `computes=${failComputes}`,
  )
  check('failed slot clears for retry', flight.size === 0)
  check('retry after failure recomputes', (await flight.run('f', async () => 'healed')) === 'healed')

  const [x, y] = await Promise.all([
    flight.run('k1', async () => 'one'),
    flight.run('k2', async () => 'two'),
  ])
  check('different keys do not coalesce', x === 'one' && y === 'two')

  // has(): the join-vs-start signal the route's concurrency cap reads —
  // and the synchronous-start contract that makes check-then-run atomic
  // on the event loop (compute's first statements run inside run()).
  check('has() is false before any run', flight.has('h') === false)
  let sawSyncStart = false
  const hp = flight.run('h', async () => {
    sawSyncStart = true
    await new Promise((r) => setTimeout(r, 20))
    return 'held'
  })
  check('compute body starts synchronously inside run()', sawSyncStart)
  check('has() is true while in flight', flight.has('h') === true)
  await hp
  check('has() clears after settle', flight.has('h') === false)
}

await rm(dir, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${failures} img-cache check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll img-cache checks passed.')
