// Verifies the two write-through sale indexes' pure decision logic in CI so a
// regression goes red on the PR instead of silently corrupting the Trending
// feeds:
//   1. isZeroPrice classifies free (0) / priced (>0) / unknown (absent /
//      non-numeric) exactly, so a free mint is never mistaken for a sale.
//   2. recordSaleEnds indexes the ending-soon zset ONLY for ACTIVE window
//      sales (real close date AND started) and un-indexes open-ended,
//      scheduled (not-started), and priced/free transitions correctly.
//   3. The free-mint zset gains price-0 members and drops priced ones, with
//      config===null and absent fields left untouched (no erase on a blip).
//   4. getFreeMoments / getUpcomingSaleEnds shape their reads correctly.
//
// Redis is stubbed (multi()/zrange swapped on the shared singleton), so this
// runs with no network and asserts exactly which commands each config emits.
//
// Run: node --experimental-strip-types scripts/verify-sale-index.ts

import { redis, SALE_ENDS_KEY, SALE_FREE_KEY } from '../lib/redis.ts'
import { isZeroPrice, parseRealSaleEnd } from '../lib/inprocess.ts'
import { recordSaleEnds, getFreeMoments, getUpcomingSaleEnds } from '../lib/saleEnds.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// ── 1. isZeroPrice — the free/priced/unknown classifier ──────────────────────
check('isZeroPrice: "0" -> free', isZeroPrice('0') === true)
check('isZeroPrice: "0000" -> free', isZeroPrice('0000') === true)
check('isZeroPrice: "1000" -> priced', isZeroPrice('1000') === false)
check(
  'isZeroPrice: big priced -> priced',
  isZeroPrice('100000000000000000') === false,
)
check('isZeroPrice: undefined -> unknown', isZeroPrice(undefined) === null)
check('isZeroPrice: null -> unknown', isZeroPrice(null) === null)
check('isZeroPrice: "" -> unknown', isZeroPrice('') === null)
check('isZeroPrice: "0.0" (decimal) -> unknown', isZeroPrice('0.0') === null)
check('isZeroPrice: "abc" -> unknown', isZeroPrice('abc') === null)

// ── 2 + 3. recordSaleEnds command emission ───────────────────────────────────
// Stub the pipeline: capture every command as [cmd, ...args], resolve exec().
type Cmd = [string, ...unknown[]]
let captured: Cmd[] = []
const fakePipeline = () => {
  const rec = (cmd: string) => (...args: unknown[]) => {
    captured.push([cmd, ...args])
    return pipe
  }
  const pipe = {
    zadd: rec('zadd'),
    zrem: rec('zrem'),
    zremrangebyscore: rec('zremrangebyscore'),
    zremrangebyrank: rec('zremrangebyrank'),
    exec: async () => [],
  }
  return pipe
}
;(redis as unknown as { multi: () => unknown }).multi = fakePipeline

// True when a zadd/zrem for `member` on `key` was captured. zadd carries
// {score, member} objects; zrem carries bare member strings.
const emitted = (cmd: 'zadd' | 'zrem', key: string, member: string): boolean =>
  captured.some(
    ([c, k, ...rest]) =>
      c === cmd &&
      k === key &&
      rest.some((a) =>
        cmd === 'zadd'
          ? typeof a === 'object' && a !== null && (a as { member?: string }).member === member
          : a === member,
      ),
  )

const nowSec = Math.floor(Date.now() / 1000)
const future = String(nowSec + 3600)
const past = String(nowSec - 3600)

// Each case uses a UNIQUE key so the per-pod seen-caches never cross-talk.
const run = async (config: Record<string, string> | null, key: string) => {
  captured = []
  await recordSaleEnds([{ key, config }])
}

// Active window sale (started, real end), priced.
await run({ saleStart: '0', saleEnd: future, pricePerToken: '1000' }, 'c:activePriced')
check(
  'active priced sale -> ends zadd',
  emitted('zadd', SALE_ENDS_KEY, 'c:activePriced'),
)
check(
  'active priced sale -> NOT in ends zrem',
  !emitted('zrem', SALE_ENDS_KEY, 'c:activePriced'),
)
check(
  'priced (first sighting) -> free zrem (clears any stale)',
  emitted('zrem', SALE_FREE_KEY, 'c:activePriced'),
)
check(
  'priced sale -> NOT free zadd',
  !emitted('zadd', SALE_FREE_KEY, 'c:activePriced'),
)

// Scheduled sale (real end, NOT started) — not an active window sale.
await run({ saleStart: future, saleEnd: String(nowSec + 7200), pricePerToken: '1000' }, 'c:scheduled')
check(
  'scheduled sale -> ends zrem (excluded from ending-soon)',
  emitted('zrem', SALE_ENDS_KEY, 'c:scheduled'),
)
check(
  'scheduled sale -> NOT ends zadd',
  !emitted('zadd', SALE_ENDS_KEY, 'c:scheduled'),
)

// Started sale via saleStart in the past.
await run({ saleStart: past, saleEnd: future, pricePerToken: '1000' }, 'c:startedPast')
check(
  'started-in-past sale -> ends zadd',
  emitted('zadd', SALE_ENDS_KEY, 'c:startedPast'),
)

// Open-ended sale ("0" saleEnd) — no close date, un-index.
await run({ saleStart: '0', saleEnd: '0', pricePerToken: '1000' }, 'c:openEnded')
check(
  'open-ended sale -> ends zrem',
  emitted('zrem', SALE_ENDS_KEY, 'c:openEnded'),
)
check(
  'open-ended sale -> NOT ends zadd',
  !emitted('zadd', SALE_ENDS_KEY, 'c:openEnded'),
)

// Free active mint — indexed as ending-soon AND as free.
await run({ saleStart: '0', saleEnd: future, pricePerToken: '0' }, 'c:freeActive')
check('free active mint -> ends zadd', emitted('zadd', SALE_ENDS_KEY, 'c:freeActive'))
check('free active mint -> free zadd', emitted('zadd', SALE_FREE_KEY, 'c:freeActive'))
check('free mint -> NOT free zrem', !emitted('zrem', SALE_FREE_KEY, 'c:freeActive'))

// saleEnd absent (partial data) — ends index left untouched; free still classified.
await run({ saleStart: '0', pricePerToken: '0' }, 'c:noEnd')
check(
  'absent saleEnd -> NO ends zadd/zrem',
  !emitted('zadd', SALE_ENDS_KEY, 'c:noEnd') && !emitted('zrem', SALE_ENDS_KEY, 'c:noEnd'),
)
check('absent saleEnd, free -> free zadd', emitted('zadd', SALE_FREE_KEY, 'c:noEnd'))

// Price absent (partial data) — free index left untouched; ends still classified.
await run({ saleStart: '0', saleEnd: future }, 'c:noPrice')
check('absent price -> ends zadd', emitted('zadd', SALE_ENDS_KEY, 'c:noPrice'))
check(
  'absent price -> NO free zadd/zrem',
  !emitted('zadd', SALE_FREE_KEY, 'c:noPrice') && !emitted('zrem', SALE_FREE_KEY, 'c:noPrice'),
)

// config === null (upstream blip) — never touches either index.
await run(null, 'c:nullConfig')
check(
  'null config -> no ends command',
  !emitted('zadd', SALE_ENDS_KEY, 'c:nullConfig') && !emitted('zrem', SALE_ENDS_KEY, 'c:nullConfig'),
)
check(
  'null config -> no free command',
  !emitted('zadd', SALE_FREE_KEY, 'c:nullConfig') && !emitted('zrem', SALE_FREE_KEY, 'c:nullConfig'),
)

// Seen-cache: re-recording an unchanged priced active sale skips the redundant
// free zrem on the second sighting (verdict cached as priced).
captured = []
await recordSaleEnds([{ key: 'c:cacheTest', config: { saleStart: '0', saleEnd: future, pricePerToken: '5' } }])
check('cache warm-up priced -> free zrem once', emitted('zrem', SALE_FREE_KEY, 'c:cacheTest'))
captured = []
await recordSaleEnds([{ key: 'c:cacheTest', config: { saleStart: '0', saleEnd: future, pricePerToken: '5' } }])
check(
  'cached priced sale -> NO repeat free zrem',
  !emitted('zrem', SALE_FREE_KEY, 'c:cacheTest'),
)

// ── 4. Readers ───────────────────────────────────────────────────────────────
;(redis as unknown as { zrange: (...a: unknown[]) => Promise<unknown> }).zrange = async () => [
  'x:1',
  'y:2',
]
const freeSet = await getFreeMoments()
check('getFreeMoments -> Set of members', freeSet.has('x:1') && freeSet.has('y:2') && freeSet.size === 2)

;(redis as unknown as { zrange: (...a: unknown[]) => Promise<unknown> }).zrange = async () => [
  'a:1',
  111,
  'b:2',
  222,
]
const endsMap = await getUpcomingSaleEnds(nowSec)
check(
  'getUpcomingSaleEnds -> member→score map',
  endsMap.get('a:1') === 111 && endsMap.get('b:2') === 222 && endsMap.size === 2,
)

// Reader failure degrades to empty (never throws into the feed).
;(redis as unknown as { zrange: () => Promise<unknown> }).zrange = async () => {
  throw new Error('redis down')
}
check('getFreeMoments failure -> empty set', (await getFreeMoments()).size === 0)
check('getUpcomingSaleEnds failure -> empty map', (await getUpcomingSaleEnds(nowSec)).size === 0)

// parseRealSaleEnd sanity (shared deadline classifier the started-gate builds on).
check('parseRealSaleEnd: "0" -> null', parseRealSaleEnd('0') === null)
check('parseRealSaleEnd: future -> seconds', parseRealSaleEnd(future) === nowSec + 3600)
check(
  'parseRealSaleEnd: uint64 sentinel -> null',
  parseRealSaleEnd('18446744073709551615') === null,
)

console.log(failures === 0 ? '\nAll sale-index checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
