// Verifies the one door In Process's GET /moment body comes through —
// normalizeMomentDetail (lib/inprocess.ts) — pinned to bodies captured
// verbatim from the live endpoint on 2026-11-25 (scripts/fixtures/
// inprocess-moment/, byte-for-byte as served), plus the decisions that rode on
// In Process's 2026-06-19 change to that body (`momentAdmins` → `admins`,
// `saleConfig` → `sale`, sale window as JSON numbers):
//
//   1. Normalization. The live body and its legacy-named twin land on the same
//      MomentDetail; the max-uint64 sentinel the wire rounds to 2^64 is
//      restored exactly; null, saleEnd-0, and malformed sales are "no sale";
//      the live 404 envelope and non-objects are not moments; upstream extras
//      (including a `hidden` / `creator` only Kismet may set) are dropped.
//   2. The moment-admin check that replaced the admin-list auth fallback in
//      /api/distribute and the raffle-manage gate (lib/momentAuthz): ADMIN on
//      the token row OR the tokenId-0 row, nothing else; unreadable → throw.
//   3. Cover synthesis never throws: the real module, with fetch and Upstash
//      mocked, fed the live body, the body shape that used to throw (no admin
//      list under either name), and bodies that fail every other way.
//   4. A static guard: every upstream GET /moment reader normalizes (or reads
//      only `metadata`), and no source outside the normalizer reads
//      `.momentAdmins`.
//
// Fixtures (GET https://api.inprocess.world/api/moment?collectionAddress=…&tokenId=…&chainId=8453):
//   fixed-price.json      0x80ce7bd430f34792490a22ee0fd479e7333715c9 #3  Kismet Patron Collection
//   open-ended-usdc.json  0xde7c6bb5faa199545e6aa1b44bad5a0f852fdd85 #7  erc20Mint, never-expires
//   no-sale.json          0x1540f039f7e835444d613d2aada6f83dc00850ad #1  unindexed: sale null, admins []
//   not-found.json        0x80ce7bd430f34792490a22ee0fd479e7333715c9 #4  404 envelope
//
// Run:  npm run verify:moment-wire              offline, deterministic (part of `check`)
//       npm run verify:moment-wire -- --live    also re-fetch every fixture's URL and fail
//                                               on schema drift (key sets, value types) —
//                                               the check that would have caught 2026-06-19

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  INPROCESS_API,
  OPEN_ENDED_SALE_SENTINEL,
  formatPrice,
  getSaleWindow,
  inferCollectCurrency,
  inprocessUrl,
  isZeroPrice,
  normalizeMomentDetail,
  parseRealSaleEnd,
  type InProcessMomentBody,
  type MomentDetailSaleConfig,
} from '../lib/inprocess.ts'
import { SALE_CLOSED_AT_CREATE } from '../lib/creatorCopy.ts'
import { isOnchainMomentAdmin } from '../lib/momentAuthz.ts'
import type { OnchainSaleConfig } from '../lib/saleConfig.ts'
import { createMockUpstash } from './_mock-upstash.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
const section = (title: string) => console.log(`\n── ${title}`)

// Compile-time (npm run typecheck covers scripts/): the chain fallback's shape
// must stay assignable to the normalized one, or /api/moment and
// fetchMomentDetail couldn't backfill a missing sale into the same slot.
const _chainFillsTheSameSlot = (c: OnchainSaleConfig): MomentDetailSaleConfig => c

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const keysOf = (v: unknown) => (isRecord(v) ? Object.keys(v).sort() : [])
const sameKeys = (v: unknown, keys: readonly string[]) => isDeepStrictEqual(keysOf(v), [...keys].sort())
const typeMap = (v: unknown) =>
  isRecord(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === null ? 'null' : typeof x])) : null

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'inprocess-moment')
const CASES = {
  fixedPrice: { file: 'fixed-price.json', collection: '0x80ce7bd430f34792490a22ee0fd479e7333715c9', tokenId: '3', status: 200 },
  openEndedUsdc: { file: 'open-ended-usdc.json', collection: '0xde7c6bb5faa199545e6aa1b44bad5a0f852fdd85', tokenId: '7', status: 200 },
  noSale: { file: 'no-sale.json', collection: '0x1540f039f7e835444d613d2aada6f83dc00850ad', tokenId: '1', status: 200 },
  notFound: { file: 'not-found.json', collection: '0x80ce7bd430f34792490a22ee0fd479e7333715c9', tokenId: '4', status: 404 },
} as const
type Case = (typeof CASES)[keyof typeof CASES]
const fixtureText = (c: Case) => readFileSync(path.join(FIXTURES, c.file), 'utf8')
// JSON.parse of the served text is exactly what `res.json()` hands a route —
// including the rounding of a uint64 window value to the nearest double.
const fixtureBody = (c: Case) => JSON.parse(fixtureText(c)) as InProcessMomentBody

const LIVE_KEYS = ['id', 'uri', 'contentUri', 'owner', 'sale', 'soldOut', 'protocol', 'admins', 'metadata', 'video']
const LIVE_SALE_KEYS = ['pricePerToken', 'saleStart', 'saleEnd', 'maxTokensPerAddress', 'fundsRecipient', 'type']
// The patron collection's tokenId-0 ADMIN holders on 2026-11-25 — each one
// confirmed against permissions(0, addr) on Base when the fixture was taken.
const PATRON_ADMINS = [
  '0x010abf958d309df82445d156e7d99af82c6d20b2',
  '0x0734462efff84ede22e75fa8fb39f2064c9cb147',
  '0x099b9bbe0937428e145a3003ddf58e7e0cf69801',
  '0x4bb3b1ce8bf14a8846dee0375227dbc617ac7a73',
  '0x651d699af32cd71b5573571935c99c35f074dd51',
  '0x65652f9e955475d8dba0f90c4dd2c0c090800fb5',
  '0x6c1cbe8cfc32a74188a9d3bf364945ea53b01b04',
  '0xa0be5a9b02b7b7290f89e4e2a01faf46ef00baf5',
  '0xbd5a42ddb098613ec2a9d75f94f6df681164674e',
]
const SENTINEL = OPEN_ENDED_SALE_SENTINEL.toString()

// The legacy (pre-2026-06-19) rendering of a current body: same data under the
// old names, window as decimal strings — what the normalizer must also accept.
function toLegacy(b: InProcessMomentBody): InProcessMomentBody {
  const { admins, sale, ...rest } = b
  return {
    ...rest,
    momentAdmins: admins,
    saleConfig: sale
      ? { type: sale.type, pricePerToken: sale.pricePerToken, saleStart: String(sale.saleStart), saleEnd: String(sale.saleEnd) }
      : null,
  }
}

// ── 1. Normalization ────────────────────────────────────────────────────────

section('1. normalizeMomentDetail against the live bodies')

const fixedRaw = fixtureBody(CASES.fixedPrice)
const fixed = normalizeMomentDetail(fixedRaw)
const s = fixedRaw.sale!

check('live body: the post-2026-06-19 schema — admins/sale, no momentAdmins/saleConfig', sameKeys(fixedRaw, LIVE_KEYS), keysOf(fixedRaw).join(','))
check('live body: sale has a NUMERIC window and no currency', sameKeys(s, LIVE_SALE_KEYS) && typeof s.saleStart === 'number' && typeof s.saleEnd === 'number', JSON.stringify(typeMap(s)))
check(
  'normalizes to exactly the Kismet shape (decimal-string window, lowercased collection admins)',
  isDeepStrictEqual(fixed, {
    uri: 'ar://epQmwO5Dsv-5m99x1-pSn2drclK4GYkqjKOdhBLFgVI',
    owner: '0x099b9bbe0937428e145a3003ddf58e7e0cf69801',
    saleConfig: { type: 'fixedPrice', pricePerToken: '33000000000000000', saleStart: '0', saleEnd: '1790477940' },
    collectionAdmins: PATRON_ADMINS,
    metadata: fixedRaw.metadata,
  }),
  JSON.stringify(fixed),
)
check(
  '…which the sale classifiers read as priced, with a real deadline, in ETH',
  !!fixed?.saleConfig &&
    isZeroPrice(fixed.saleConfig.pricePerToken) === false &&
    parseRealSaleEnd(fixed.saleConfig.saleEnd) === 1790477940 &&
    formatPrice(fixed.saleConfig.pricePerToken, inferCollectCurrency(fixed.saleConfig)) === '0.033 ETH',
)
check('the legacy-named twin (momentAdmins / saleConfig, string window) normalizes identically', isDeepStrictEqual(normalizeMomentDetail(toLegacy(fixedRaw)), fixed))
{
  const both = {
    ...fixedRaw,
    momentAdmins: ['0x000000000000000000000000000000000000dead'],
    saleConfig: { pricePerToken: '1', saleStart: '0', saleEnd: '5' },
  }
  const n = normalizeMomentDetail(both)
  check('both generations present: the current names win', isDeepStrictEqual(n?.collectionAdmins, PATRON_ADMINS) && n?.saleConfig?.pricePerToken === '33000000000000000')
  const nulled = normalizeMomentDetail({ ...both, sale: null })
  check('…an explicit `sale: null` included (a stale legacy sale is not resurrected)', nulled !== null && nulled.saleConfig === undefined)
}

const usdcText = fixtureText(CASES.openEndedUsdc)
const usdcRaw = JSON.parse(usdcText) as InProcessMomentBody
const usdc = normalizeMomentDetail(usdcRaw)
check(
  'live wire: the open-ended sentinel arrives as a rounded JSON number (2^64, not 2^64 - 1)',
  usdcText.includes('"saleEnd":18446744073709552000') && usdcRaw.sale?.saleEnd === 2 ** 64,
)
check('normalization restores the EXACT max-uint64 sentinel', usdc?.saleConfig?.saleEnd === SENTINEL, usdc?.saleConfig?.saleEnd)
check(
  '…which reads as open-ended, and fits a uint64 again (the raw value overflows one)',
  parseRealSaleEnd(usdc?.saleConfig?.saleEnd) === null &&
    BigInt(usdc?.saleConfig?.saleEnd ?? '0') === (1n << 64n) - 1n &&
    BigInt(String(usdcRaw.sale?.saleEnd)) > (1n << 64n) - 1n,
)
check(
  'erc20Mint with no currency on the wire → USDC by type, priced as $1',
  usdc?.saleConfig?.type === 'erc20Mint' &&
    usdc.saleConfig.currency === undefined &&
    inferCollectCurrency(usdc.saleConfig) === 'usdc' &&
    formatPrice(usdc.saleConfig.pricePerToken, 'usdc') === '$1',
)
check(
  'its scheduled start survives as a string: scheduled before, live (no date) after',
  usdc?.saleConfig?.saleStart === '1794264995' &&
    getSaleWindow(usdc.saleConfig, 1794264995 - 1)?.state === 'scheduled' &&
    getSaleWindow(usdc.saleConfig, 1794264995 + 1)?.state === 'live',
)
check('its legacy twin (stringified rounded sentinel) normalizes identically', isDeepStrictEqual(normalizeMomentDetail(toLegacy(usdcRaw)), usdc))

const noSaleRaw = fixtureBody(CASES.noSale)
const noSale = normalizeMomentDetail(noSaleRaw)
check('live: an unindexed moment comes as sale: null, admins: []', noSaleRaw.sale === null && isDeepStrictEqual(noSaleRaw.admins, []))
check('…→ no saleConfig (the routes backfill it from chain) and an empty admin list', noSale !== null && noSale.saleConfig === undefined && isDeepStrictEqual(noSale.collectionAdmins, []))
check('the live 404 envelope is not a moment', normalizeMomentDetail(fixtureBody(CASES.notFound)) === null)

section('1b. sale edge cases (mutations of the live sale)')
const saleOf = (sale: unknown) => normalizeMomentDetail({ ...fixedRaw, sale })?.saleConfig
check('saleEnd 0 — the unset row — is no sale, never a free, open, live drop', saleOf({ ...s, saleEnd: 0 }) === undefined && saleOf({ ...s, saleEnd: 0, pricePerToken: '0' }) === undefined)
check('saleEnd 1 (created closed) becomes the string the closed-at-create check compares', saleOf({ ...s, saleEnd: 1 })?.saleEnd === SALE_CLOSED_AT_CREATE && getSaleWindow(saleOf({ ...s, saleEnd: 1 })) === null)
check(
  '…where the raw number would have rendered as "Ended Jan 1, 1970"',
  getSaleWindow({ saleStart: 0, saleEnd: 1 } as unknown as { saleStart?: string; saleEnd?: string })?.state === 'ended',
)
check('a price arriving as a JSON number is kept only while exact', saleOf({ ...s, pricePerToken: 33 })?.pricePerToken === '33' && saleOf({ ...s, pricePerToken: 33e18 }) === undefined)
check('an unknown sale strategy is no sale (Kismet cannot price it)', saleOf({ ...s, type: 'timedSale' }) === undefined)
check('a sale without `type` is kept typeless (legacy bodies could omit it)', isDeepStrictEqual(saleOf({ pricePerToken: '5', saleStart: '0', saleEnd: '9' }), { pricePerToken: '5', saleStart: '0', saleEnd: '9' }))
check(
  'a missing, negative, fractional, or non-numeric window is no sale',
  [{ ...s, saleStart: undefined }, { ...s, saleEnd: -1 }, { ...s, saleStart: 1.5 }, { ...s, saleEnd: 'soon' }, { ...s, saleEnd: '' }, { ...s, pricePerToken: undefined }].every((x) => saleOf(x) === undefined),
)
check('a window past 2^53 that is not the rounded sentinel is refused, not guessed', saleOf({ ...s, saleEnd: 2 ** 60 }) === undefined)
check(
  'legacy strings: exact sentinel, stringified double, and 2^64 itself all → the sentinel',
  ['18446744073709551615', '18446744073709552000', '18446744073709551616'].every((e) => saleOf({ ...s, saleEnd: e })?.saleEnd === SENTINEL),
)
check('…but a 20-digit value nowhere near uint64 is refused', saleOf({ ...s, saleEnd: '99999999999999999999' }) === undefined)
check('decimal strings canonicalize (leading zeros)', isDeepStrictEqual(saleOf({ ...s, saleStart: '0007', pricePerToken: '010' }), { type: 'fixedPrice', pricePerToken: '10', saleStart: '7', saleEnd: '1790477940' }))
check(
  'a legacy currency is kept only when it is an address',
  saleOf({ ...s, currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' })?.currency === '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' &&
    saleOf({ ...s, currency: 'USDC' })?.currency === undefined,
)

section('1c. admin-list and body edge cases')
const adminsOf = (admins: unknown) => normalizeMomentDetail({ ...fixedRaw, admins })?.collectionAdmins
check(
  'admin list: lowercased, de-duplicated, non-addresses dropped',
  isDeepStrictEqual(adminsOf(['0xABCDEF0123456789ABCDEF0123456789ABCDEF01', '0xabcdef0123456789abcdef0123456789abcdef01', 42, null, '0x123', 'nope']), [
    '0xabcdef0123456789abcdef0123456789abcdef01',
  ]),
)
check('a non-array admin list (null / object / string / number) is [], never a throw', [null, {}, 'x', 7].every((a) => isDeepStrictEqual(adminsOf(a), [])))
{
  const { admins: _dropped, ...noList } = fixedRaw
  check('no admin list under either name (the shape that made cover synthesis throw) is []', isDeepStrictEqual(normalizeMomentDetail(noList)?.collectionAdmins, []))
}
check('non-objects are not moments', [null, undefined, 'x', 7, [], [fixedRaw]].every((v) => normalizeMomentDetail(v) === null))
check('neither uri nor metadata → not a moment', normalizeMomentDetail({ admins: [], sale: null, soldOut: false }) === null)
check('uri without metadata → metadata {} (the type promises an object)', isDeepStrictEqual(normalizeMomentDetail({ uri: 'ar://x' })?.metadata, {}))
check('metadata without uri → uri ""', normalizeMomentDetail({ metadata: { name: 'x' } })?.uri === '')
check(
  'upstream extras are dropped — a `hidden` / `creator` of upstream\'s own included',
  sameKeys(normalizeMomentDetail({ ...fixedRaw, hidden: true, creator: { address: PATRON_ADMINS[0] } }), ['uri', 'owner', 'saleConfig', 'collectionAdmins', 'metadata']),
)
check('a non-address owner is dropped', normalizeMomentDetail({ ...fixedRaw, owner: 'kismet' })?.owner === undefined)

// ── 2. Moment-admin authorization ───────────────────────────────────────────

section('2. isOnchainMomentAdmin — the distribute / raffle "moment admin" check')

type Row = bigint | string | Error
function fakeClient(rows: { token: Row; collection: Row }) {
  const calls: { address: string; functionName: string; tokenId: bigint; user: string }[] = []
  return {
    calls,
    readContract: async (args: { address: string; functionName: string; args: readonly unknown[] }) => {
      const [tokenId, user] = args.args as [bigint, string]
      calls.push({ address: args.address, functionName: args.functionName, tokenId, user })
      const v = tokenId === 0n ? rows.collection : rows.token
      if (v instanceof Error) throw v
      return v
    },
  }
}
const COLL = CASES.fixedPrice.collection as `0x${string}`
const CALLER = '0x651d699af32cd71b5573571935c99c35f074dd51' as `0x${string}`
const isAdmin = (rows: { token: Row; collection: Row }) => isOnchainMomentAdmin(fakeClient(rows), COLL, 3n, CALLER)
const rejects = (p: Promise<unknown>) => p.then(() => false, () => true)

check('ADMIN on the token row → admin', await isAdmin({ token: 2n, collection: 0n }))
check('ADMIN on tokenId 0 → admin of every token in the collection', await isAdmin({ token: 0n, collection: 2n }))
check('ADMIN alongside other bits still counts', await isAdmin({ token: 2n | 4n | 16n, collection: 0n }))
check('MINTER / SALES / METADATA / FUNDS_MANAGER without ADMIN → not an admin', !(await isAdmin({ token: 4n | 8n | 16n, collection: 4n | 8n | 16n | 32n })))
check('no permissions → not an admin', !(await isAdmin({ token: 0n, collection: 0n })))
{
  const c = fakeClient({ token: 0n, collection: 2n })
  await isOnchainMomentAdmin(c, COLL, 3n, CALLER)
  check(
    'reads exactly permissions(tokenId, caller) and permissions(0, caller) on the collection',
    c.calls.length === 2 &&
      c.calls.every((x) => x.functionName === 'permissions' && x.address === COLL && x.user === CALLER) &&
      c.calls.some((x) => x.tokenId === 3n) &&
      c.calls.some((x) => x.tokenId === 0n),
  )
}
check('one row unreadable but the other grants ADMIN → admin (a yes needs one row)', await isAdmin({ token: new Error('rpc down'), collection: 2n }))
check('unreadable with no grant → throws (the routes answer 502, never a false 403)', await rejects(isAdmin({ token: new Error('rpc down'), collection: 0n })))
check('a non-bigint permissions() result → throws too', await rejects(isAdmin({ token: '2', collection: 0n })))

// ── 3. Cover synthesis never throws ─────────────────────────────────────────

section('3. synthesizeMissingCoverMoment — the real module, fetch + Upstash mocked')

const upstash = createMockUpstash()
const redisUrl = await upstash.start()
process.env.UPSTASH_REDIS_REST_URL = redisUrl
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token'

// In Process answers from the fixtures; the mock Upstash passes through;
// anything else 503s, so an unstubbed dependency fails a check instead of
// reaching the network.
const realFetch = globalThis.fetch
let momentReply: () => Response = () => new Response('{}', { status: 500 })
const hits = { moment: 0, offBox: [] as string[] }
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith(redisUrl)) return realFetch(input, init)
  if (url.startsWith(`${INPROCESS_API}/moment?`)) {
    hits.moment++
    return momentReply()
  }
  if (url.startsWith(`${INPROCESS_API}/collection?`)) return Response.json({ created_at: '2026-06-01T00:00:00.000Z' })
  hits.offBox.push(url)
  return new Response('blocked', { status: 503 })
}) as typeof fetch

try {
  // Imported only now: lib/redis reads the Upstash env at module evaluation.
  const { synthesizeMissingCoverMoment } = await import('../lib/coverMomentSynthesis.ts')
  type Synth = typeof synthesizeMissingCoverMoment
  const settle = async (...args: Parameters<Synth>) => {
    try {
      return { threw: false, out: await synthesizeMissingCoverMoment(...args) }
    } catch {
      return { threw: true, out: null }
    }
  }
  const COVER = CASES.fixedPrice.collection
  const ARTIST = '0x0734462efff84ede22e75fa8fb39f2064c9cb147'
  const meta = { address: COVER, name: 'Kismet Patron Collection', coverTokenId: '3', artist: ARTIST }
  const reply = (status: number, text: string) => () => new Response(text, { status, headers: { 'content-type': 'application/json' } })

  momentReply = reply(200, fixtureText(CASES.fixedPrice))
  const live = await settle(COVER, [], meta)
  check(
    'the live body yields the cover moment (uri, creator, created_at)',
    !live.threw && live.out?.token_id === '3' && live.out.uri === fixed?.uri && live.out.creator.address === ARTIST && live.out.created_at === '2026-06-01T00:00:00.000Z',
    JSON.stringify(live),
  )
  check('…its admins are the collection list as Moment admin objects', isDeepStrictEqual(live.out?.admins, PATRON_ADMINS.map((address) => ({ address, hidden: false }))))
  check('…and its metadata is the body\'s', isDeepStrictEqual(live.out?.metadata, fixedRaw.metadata))

  upstash.store.set(`kismetart:moment-meta:${COVER}:3`, { v: JSON.stringify({ creator: '0x651D699AF32CD71B5573571935C99C35F074DD51' }) })
  check('KV moment-meta names the creator when present (lowercased)', (await settle(COVER, [], meta)).out?.creator.address === '0x651d699af32cd71b5573571935c99c35f074dd51')
  upstash.store.delete(`kismetart:moment-meta:${COVER}:3`)

  const { admins: _dropped, ...noAdmins } = fixedRaw
  momentReply = reply(200, JSON.stringify(noAdmins))
  const noList = await settle(COVER, [], meta)
  check('a body with no admin list under either name (what threw) → the cover, admins []', !noList.threw && noList.out !== null && isDeepStrictEqual(noList.out.admins, []))
  momentReply = reply(200, JSON.stringify(toLegacy(fixedRaw)))
  check('a legacy-named body still yields the same cover', isDeepStrictEqual((await settle(COVER, [], meta)).out, live.out))

  const unusable: [string, () => Response][] = [
    ['the live 404', reply(404, fixtureText(CASES.notFound))],
    ['a 200 that is not JSON', reply(200, '<html>')],
    ['an empty 200', reply(200, '')],
    ['a 200 JSON scalar', reply(200, '42')],
    ['a 200 error envelope', reply(200, '{"error":"boom"}')],
    ['a network failure', () => { throw new TypeError('fetch failed') }],
  ]
  for (const [label, r] of unusable) {
    momentReply = r
    const res = await settle(COVER, [], meta)
    check(`${label} → null, no throw`, !res.threw && res.out === null, JSON.stringify(res))
  }

  momentReply = reply(200, fixtureText(CASES.fixedPrice))
  upstash.setFailing(true)
  const kvDown = await settle(COVER, [], meta)
  upstash.setFailing(false)
  check('Upstash down → falls back to the collection artist, no throw', !kvDown.threw && kvDown.out?.creator.address === ARTIST)

  const before = hits.moment
  const listed = await settle(COVER, [{ token_id: 3 }], meta)
  check('cover already in the timeline → null, without fetching /moment', !listed.threw && listed.out === null && hits.moment === before)
  check('no coverTokenId → null', (await settle(COVER, [], { ...meta, coverTokenId: undefined })).out === null)

  // An unforeseen fault past every inner guard: the outer catch must turn it
  // into null — and say so in the log rather than swallow it.
  const logged: unknown[][] = []
  const realError = console.error
  console.error = (...a: unknown[]) => { logged.push(a) }
  const hostile = {
    address: COVER,
    name: 'x',
    get coverTokenId(): string {
      throw new Error('unforeseen')
    },
  }
  const faulted = await settle(COVER, [], hostile)
  console.error = realError
  check(
    'an unforeseen fault inside → null, no throw, and logged',
    !faulted.threw && faulted.out === null && logged.some((a) => String(a[0]).includes('[coverMomentSynthesis]')),
  )
  check('nothing reached the network', hits.offBox.length === 0, hits.offBox.join(', '))
} finally {
  globalThis.fetch = realFetch
  upstash.close()
}

// ── 4. Static guard ─────────────────────────────────────────────────────────

section('4. every upstream GET /moment reader goes through the normalizer')

const ROOT = path.resolve(import.meta.dirname, '..')
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(e.name)) yield p
  }
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/')
const sources = ['app', 'lib', 'components', 'hooks', 'contexts', 'providers']
  .map((d) => path.join(ROOT, d))
  .filter((d) => existsSync(d))
  .flatMap((d) => [...walk(d)])
  .map((p) => ({ file: rel(p), src: readFileSync(p, 'utf8') }))
// Readers that take only `metadata` off the body, which the rename never
// touched. A new reader goes through normalizeMomentDetail, or joins this list
// by reading nothing else.
const METADATA_ONLY = new Set(['app/api/profile/[address]/theme/route.ts', 'lib/experience/artwork.ts'])
const readers = sources.filter((f) => /inprocessUrl\(\s*['"`]\/moment['"`]/.test(f.src))
const bypassing = readers.filter((f) =>
  METADATA_ONLY.has(f.file)
    ? /\.(sale|admins|saleConfig|momentAdmins|owner)\b/.test(f.src)
    : !f.src.includes('normalizeMomentDetail('),
)
check(
  `each of the ${readers.length} upstream /moment readers normalizes, or reads only metadata`,
  readers.length > 0 && bypassing.length === 0,
  bypassing.map((f) => f.file).join(', '),
)
const legacyReads = sources.filter((f) => f.file !== 'lib/inprocess.ts' && /\.momentAdmins\b|\[\s*['"]momentAdmins['"]\s*\]/.test(f.src))
check('nothing outside the normalizer reads `.momentAdmins`', legacyReads.length === 0, legacyReads.map((f) => f.file).join(', '))

// ── 5. Live drift check (opt-in) ────────────────────────────────────────────

if (process.argv.includes('--live')) {
  section('5. live: the endpoint still serves the pinned schema')
  const pinnedSaleTypes = typeMap(s)
  for (const [name, c] of Object.entries(CASES)) {
    const url = inprocessUrl('/moment', { collectionAddress: c.collection, tokenId: c.tokenId, chainId: '8453' })
    let status = 0
    let live: unknown = null
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
      status = res.status
      live = JSON.parse(await res.text())
    } catch (err) {
      check(`${name}: reachable`, false, err instanceof Error ? err.message : String(err))
      continue
    }
    const pinned = fixtureBody(c) as Record<string, unknown>
    check(`${name}: HTTP ${c.status}`, status === c.status, String(status))
    check(`${name}: same top-level keys as the pinned body`, sameKeys(live, Object.keys(pinned)), keysOf(live).join(','))
    if (c.status !== 200) continue
    const liveSale = isRecord(live) ? live.sale : undefined
    // Values move (a sale gets edited, an admin added); keys and value types
    // moving is the drift that broke Kismet last time.
    check(
      `${name}: sale is null or keeps the pinned keys and value types`,
      liveSale === null || isDeepStrictEqual(typeMap(liveSale), pinnedSaleTypes),
      JSON.stringify(typeMap(liveSale)),
    )
    const n = normalizeMomentDetail(live)
    check(`${name}: still normalizes${isRecord(liveSale) ? ', with a sale' : ''}`, n !== null && (!isRecord(liveSale) || n.saleConfig !== undefined))
  }
}

if (failures > 0) {
  console.error(`\n${failures} moment-wire check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll moment-wire checks passed.')
