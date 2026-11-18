// Pins the In Process collection-detail client (lib/inprocessCollection) to
// responses captured from PRODUCTION on 2026-11-18, when the singular
// `GET /collection?collectionAddress=` route was found removed upstream:
//   • normalization of the LIVE shape (bare `creator` address + hoisted
//     `creator_username`), the DOCUMENTED shape (creator object), and the
//     LEGACY shape (default_admin + payout_recipient) onto one record;
//   • miss classification — the removed route's HTML 404 is `route_missing`
//     (always loud), the live route's empty 500 for an unindexed contract is
//     `not_found` (quiet unless the collection is known indexed);
//   • the hidden-deployer gate covers the hoisted `creator_username`;
//   • the loud log fires (throttled) for route_missing, and for a not_found
//     only when the caller knows the collection is indexed.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//        --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        scripts/verify-inprocess-collection.ts

import {
  classifyCollectionDetailResponse,
  collectionDetailUrl,
  fetchInprocessCollection,
  INDEXER_GRACE_MS,
  isKnownIndexed,
  MISS_LOG_INTERVAL_MS,
  normalizeCollectionDetail,
} from '../lib/inprocessCollection.ts'
import { decodeCollectionConfig } from '../lib/collectionRoles.ts'
import { stripHiddenDeployerIdentityWith } from '../lib/hiddenDeployer.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const PATRON = '0x80ce7bd430f34792490a22ee0fd479e7333715c9'
const TREASURY = '0x099b9bbe0937428e145a3003ddf58e7e0cf69801'

// GET https://api.inprocess.world/api/collections/eip155:8453/erc1155:<PATRON>
// → 200, x-matched-path: /api/collections/[network]/[contract] (2026-11-18).
const LIVE_PATRON_BODY = JSON.stringify({
  id: 'b00de116-f74c-4b5d-b2b6-1626d3085b96',
  address: PATRON,
  chain_id: 8453,
  uri: 'ar://1B5KtwrMhwUAspNmaM4onPpufdqoSaKnXPIgIr_feF8',
  creator: TREASURY,
  created_at: '2026-06-18T02:59:23+00:00',
  updated_at: '2026-06-29T19:19:37+00:00',
  name: 'Kismet Patron Collection',
  protocol: 'in_process',
  creator_username: 'Kismet Art',
  metadata: {
    name: 'Kismet Patron Collection',
    description: 'The Kismet Patron Collection is the first official platform release …',
    image: 'ar://GTMfMdVBP-_qRW4mcD0ZSfZZw9N5P4k4L69UBeVHoYw',
    kismet_thumbhash: 'OxgGDwLHyKd6iYSPdVVop4d1ticISHUA',
    createReferral: '0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75',
  },
  admins: ['0x010abf958d309df82445d156e7d99af82c6d20b2', TREASURY],
})

// The removed route, as served on 2026-11-18 (body trimmed; it is Next's page).
const REMOVED_ROUTE_404 = {
  status: 404,
  contentType: 'text/html; charset=utf-8',
  matchedPath: '/404',
  bodyText: '<!DOCTYPE html><html><head><title>404: This page could not be found.</title></head></html>',
}

// ── URL ──
check(
  'detail URL is the CAIP route, address lowercased',
  collectionDetailUrl('0x80CE7bd430F34792490a22ee0fd479e7333715C9') ===
    `https://api.inprocess.world/api/collections/eip155:8453/erc1155:${PATRON}`,
  collectionDetailUrl(PATRON),
)
check(
  'detail URL carries a non-Base chain id',
  collectionDetailUrl(PATRON, 1).includes('/collections/eip155:1/erc1155:'),
)

// ── normalization: live shape ──
const live = normalizeCollectionDetail(JSON.parse(LIVE_PATRON_BODY), PATRON)
check('live body normalizes', live !== null)
check(
  'live: bare creator string → creator {address, username}',
  live?.creator?.address === TREASURY && live?.creator?.username === 'Kismet Art',
  JSON.stringify(live?.creator),
)
check(
  'live: default_admin mirrors creator (documented as the creation-time default admin)',
  live?.default_admin?.address === TREASURY && live?.default_admin?.username === 'Kismet Art',
)
check(
  'live: creator_username is consumed, never passed through',
  live !== null && !('creator_username' in live),
)
check('live: created_at kept verbatim', live?.created_at === '2026-06-18T02:59:23+00:00')
check(
  'live: metadata passes, incl. thumbhash + unknown keys',
  live?.metadata?.image === 'ar://GTMfMdVBP-_qRW4mcD0ZSfZZw9N5P4k4L69UBeVHoYw' &&
    live?.metadata?.kismet_thumbhash === 'OxgGDwLHyKd6iYSPdVVop4d1ticISHUA' &&
    typeof live?.metadata?.createReferral === 'string',
)
check('live: no payout_recipient invented', live?.payout_recipient === undefined)
check('live: admins lowercased + deduped', live?.admins?.length === 2 && live.admins.every((a) => a === a.toLowerCase()))

// ── normalization: documented + legacy shapes ──
const documented = normalizeCollectionDetail(
  { address: PATRON, creator: { address: TREASURY.toUpperCase().replace('0X', '0x'), username: 'artist name 1' }, created_at: '2025-06-07T20:41:35+00:00' },
  PATRON,
)
check(
  'documented: creator object → same record, address lowercased',
  documented?.creator?.address === TREASURY && documented?.creator?.username === 'artist name 1' &&
    documented?.default_admin?.address === TREASURY,
)
const legacy = normalizeCollectionDetail(
  { address: PATRON, default_admin: { address: TREASURY, username: 'kismet' }, payout_recipient: '0x58f19e55058057B04feAe2EEA88F90B84b7714Eb', created_at: '2026-01-01T00:00:00Z' },
  PATRON,
)
check(
  'legacy: default_admin fills creator too; payout_recipient kept, lowercased',
  legacy?.creator?.address === TREASURY && legacy?.default_admin?.username === 'kismet' &&
    legacy?.payout_recipient === '0x58f19e55058057b04feae2eea88f90b84b7714eb',
)
const noHandle = normalizeCollectionDetail({ address: PATRON, creator: TREASURY, creator_username: null }, PATRON)
check('null creator_username → identity without a username', noHandle?.creator?.address === TREASURY && noHandle.creator.username === undefined)
const badMeta = normalizeCollectionDetail({ address: PATRON, metadata: { name: 7, image: ['x'], description: 'ok' } }, PATRON)
check(
  'non-string rendered metadata keys are dropped, valid ones kept',
  badMeta?.metadata?.name === undefined && badMeta?.metadata?.image === undefined && badMeta?.metadata?.description === 'ok',
)

// ── normalization: rejections ──
check('a different contract is never rendered as this one', normalizeCollectionDetail({ ...JSON.parse(LIVE_PATRON_BODY), address: TREASURY }, PATRON) === null)
check('plural envelope is not a collection', normalizeCollectionDetail({ status: 'success', collections: [], pagination: {} }, PATRON) === null)
check('empty object is not a collection', normalizeCollectionDetail({}, PATRON) === null)
check('array is not a collection', normalizeCollectionDetail([JSON.parse(LIVE_PATRON_BODY)], PATRON) === null)
check('malformed creator address is ignored', normalizeCollectionDetail({ address: PATRON, creator: '0xnothex' }, PATRON)?.creator === undefined)

// ── classification ──
const kind = (r: { status: number; contentType?: string | null; matchedPath?: string | null; bodyText?: string }) => {
  const out = classifyCollectionDetailResponse(
    { status: r.status, contentType: r.contentType ?? null, matchedPath: r.matchedPath ?? null, bodyText: r.bodyText ?? '' },
    PATRON,
  )
  return out.detail ? 'ok' : out.miss.kind
}
check('removed route (HTML 404, x-matched-path=/404) → route_missing', kind(REMOVED_ROUTE_404) === 'route_missing')
check('HTML 404 off Vercel (no x-matched-path) → route_missing', kind({ ...REMOVED_ROUTE_404, matchedPath: null }) === 'route_missing')
check(
  'documented JSON 404 → not_found',
  kind({ status: 404, contentType: 'application/json', matchedPath: '/api/collections/[network]/[contract]', bodyText: '{"status":"error","message":"Collection not found"}' }) === 'not_found',
)
check(
  'live unindexed contract (500, empty body) → not_found',
  kind({ status: 500, matchedPath: '/api/collections/[network]/[contract]' }) === 'not_found',
)
check('500 with a body → upstream_error', kind({ status: 500, contentType: 'application/json', bodyText: '{"message":"boom"}' }) === 'upstream_error')
check(
  'live 400 (bad CAIP param) → rejected',
  kind({ status: 400, contentType: 'application/json', bodyText: '{"status":"error","message":"Invalid contract param"}' }) === 'rejected',
)
check('401 / 429 → rejected', kind({ status: 401 }) === 'rejected' && kind({ status: 429 }) === 'rejected')
check('200 null (old pre-index answer) → not_found', kind({ status: 200, contentType: 'application/json', bodyText: 'null' }) === 'not_found')
check('200 empty → not_found', kind({ status: 200 }) === 'not_found')
check('200 HTML → bad_body', kind({ status: 200, contentType: 'text/html', bodyText: '<html></html>' }) === 'bad_body')
check('200 unrecognizable JSON → bad_body', kind({ status: 200, contentType: 'application/json', bodyText: '{"ok":true}' }) === 'bad_body')
check('200 live body → ok', kind({ status: 200, contentType: 'application/json', matchedPath: '/api/collections/[network]/[contract]', bodyText: LIVE_PATRON_BODY }) === 'ok')

// ── known-indexed ──
const NOW = Date.UTC(2026, 10, 18)
check('no KV row → not known', isKnownIndexed(null, NOW) === false && isKnownIndexed(undefined, NOW) === false)
check('KV row predating the deploy stamp → known', isKnownIndexed({}, NOW) === true)
check('deploy inside the indexer grace window → not known', isKnownIndexed({ createdAt: NOW - INDEXER_GRACE_MS / 2 }, NOW) === false)
check('deploy past the grace window → known', isKnownIndexed({ createdAt: NOW - INDEXER_GRACE_MS - 1 }, NOW) === true)
check('malformed stamp → known (treated as unstamped)', isKnownIndexed({ createdAt: Number.NaN }, NOW) === true)

// ── hidden-deployer gate ──
const hiddenClosure = new Set([TREASURY])
const gated = stripHiddenDeployerIdentityWith(live, hiddenClosure)
check(
  'normalized: hidden deployer handle nulled on creator AND default_admin, address kept',
  gated?.creator?.username === null && gated?.default_admin?.username === null && gated?.creator?.address === TREASURY,
)
const rawGated = stripHiddenDeployerIdentityWith(JSON.parse(LIVE_PATRON_BODY), hiddenClosure) as { creator_username: unknown; creator: unknown }
check('raw live body: hoisted creator_username nulled too', rawGated.creator_username === null && rawGated.creator === TREASURY)
check('not hidden → input returned by reference', stripHiddenDeployerIdentityWith(live, new Set(['0x0000000000000000000000000000000000000001'])) === live)

// ── on-chain roles decode (viem positional array, as read 2026-11-18) ──
const roles = decodeCollectionConfig(['0x099B9BBe0937428e145a3003dDf58e7E0CF69801', 0n, '0x099B9BBe0937428e145a3003dDf58e7E0CF69801', 0n, '0x0000000000000000000000000000000000000000', 0n])
check('config() array → owner + fundsRecipient, lowercased', roles.owner === TREASURY && roles.fundsRecipient === TREASURY)
check(
  'config() object form + zero fundsRecipient → no payout',
  decodeCollectionConfig({ owner: TREASURY, fundsRecipient: '0x0000000000000000000000000000000000000000' }).fundsRecipient === undefined,
)

// ── fetch + loud logging (stubbed fetch, captured console.error) ──
const realFetch = globalThis.fetch
const realError = console.error
const logged: string[] = []
console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
const respond = (status: number, body: string, headers: Record<string, string>) =>
  (async () => new Response(body || null, { status, headers })) as unknown as typeof fetch
try {
  globalThis.fetch = respond(404, REMOVED_ROUTE_404.bodyText, { 'content-type': 'text/html; charset=utf-8', 'x-matched-path': '/404' })
  let thunkCalls = 0
  const r1 = await fetchInprocessCollection(PATRON, { caller: 'verify', expectIndexed: () => { thunkCalls++; return false } })
  check('route_missing → null detail, kind route_missing', r1.detail === null && r1.miss?.kind === 'route_missing')
  check('route_missing logs loudly with no caller knowledge', logged.length === 1 && logged[0].includes('ROUTE MISSING') && logged[0].includes(PATRON))
  check('route_missing never needs the expectIndexed thunk', thunkCalls === 0)
  await fetchInprocessCollection('0x30f5a8a34146343a1afc41fae5838eeb6d748900', { caller: 'verify' })
  check('a second route_missing from the same call site inside the window is throttled (not one line per lookup)', logged.length === 1)
  await fetchInprocessCollection(PATRON, { caller: 'verify-other' })
  check('route_missing from another call site → its own line', logged.length === 2 && logged[1].includes('via verify-other'))
  const realNow = Date.now
  Date.now = () => realNow() + MISS_LOG_INTERVAL_MS + 1
  try {
    await fetchInprocessCollection(PATRON, { caller: 'verify' })
  } finally {
    Date.now = realNow
  }
  check(
    'after the window, the next line reports what was suppressed',
    logged.length === 3 && logged[2].includes('+1 similar suppressed'),
    logged[2],
  )

  globalThis.fetch = respond(500, '', {})
  logged.length = 0
  const fresh = '0xf0f8cfcd6f128fc92d33ee27e9fc7aee7f2540c6'
  const r2 = await fetchInprocessCollection(fresh, { caller: 'verify', expectIndexed: false })
  check('unindexed (empty 500), not known → quiet', r2.miss?.kind === 'not_found' && logged.length === 0)
  const r3 = await fetchInprocessCollection(fresh, { caller: 'verify', expectIndexed: async () => true })
  check(
    'unindexed (empty 500) on a KNOWN-indexed collection → loud',
    r3.miss?.kind === 'not_found' && logged.length === 1 && logged[0].includes('knows is indexed') && logged[0].includes(fresh),
  )

  globalThis.fetch = respond(200, LIVE_PATRON_BODY, { 'content-type': 'application/json' })
  logged.length = 0
  let okThunk = 0
  const r4 = await fetchInprocessCollection(PATRON, { caller: 'verify', expectIndexed: () => { okThunk++; return true } })
  check('live 200 → normalized detail, nothing logged, thunk never evaluated', r4.detail?.creator?.username === 'Kismet Art' && logged.length === 0 && okThunk === 0)

  globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  const r5 = await fetchInprocessCollection(PATRON, { caller: 'verify' })
  check('network failure → null detail, never throws', r5.detail === null && r5.miss?.kind === 'network')

  let called = false
  globalThis.fetch = (async () => { called = true; return new Response('{}') }) as unknown as typeof fetch
  const r6 = await fetchInprocessCollection('not-an-address', { caller: 'verify' })
  check('invalid address → rejected without a request', r6.miss?.kind === 'rejected' && !called)
} finally {
  globalThis.fetch = realFetch
  console.error = realError
}

console.log(failures === 0 ? '\nAll inprocess-collection checks passed.' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
