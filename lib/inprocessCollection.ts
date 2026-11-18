import { isAddress } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'
import { LRUCache } from '@/lib/lruCache'

// ───────────────────────────────────────────────────────────────────────────
// In Process COLLECTION DETAIL — the single client for one collection's record.
//
// WHY THIS MODULE EXISTS (2026-11-18): In Process removed the query-param route
// `GET /collection?collectionAddress=&chainId=` (and its path form
// `/collection/{address}`). Both now 404 with Next's HTML "page not found"
// (`x-matched-path: /404`) for EVERY collection, while every caller read that 404
// as "indexer hasn't picked this collection up yet" and fell back to KV — so the
// header username, OG creator, feed creator chips, and the Patron pass-exclude
// roles all degraded with nothing in the logs. Nine call sites each built the URL
// and parsed the body themselves; they now all come through here.
//
// The replacement is the CAIP route In Process documents as `getCollectionInfo`:
//   GET /collections/{network}/{contract}  with  network=eip155:8453,
//                                                contract=erc1155:<address>
//
// LIVE SHAPE ≠ DOCUMENTED SHAPE. Verified against production on 2026-11-18 (the
// docs repo sweetmantech/docs @ 5c3b33d describes `creator` as an object):
//   { id, address, chain_id, uri, name, protocol, created_at, updated_at,
//     creator: "0x…"            ← a bare ADDRESS STRING, not {address, username}
//     creator_username: "…"|null ← the handle, hoisted to the top level
//     admins: ["0x…", …],  metadata: { name, image, description, … } }
// and there is no `default_admin` and no `payout_recipient` any more (dropped
// from the contract in March 2026). `normalizeCollectionDetail` maps every shape
// seen so far — live, documented, and the legacy `default_admin` one — onto the
// object form Kismet's consumers read. The upstream `creator` is documented as
// the CollectionDefaultAdmin ("original admin set at collection creation"), so
// it fills BOTH `creator` and `default_admin`. `payout_recipient` is now read
// on-chain (lib/collectionRoles.ts), not from In Process.
//
// PRIVACY: `creator_username` is consumed here and NEVER passed through. The
// hidden-deployer gate (lib/hiddenDeployer) nulls `creator.username` /
// `default_admin.username`; a raw top-level handle would slip past it. Output is
// an explicit field whitelist for the same reason — a future upstream identity
// field cannot leak by passthrough.
//
// FAILURES ARE CLASSIFIED, AND THE CONTRACT-BREAKING ONES ARE LOUD — throttled
// process-wide to one line per (kind, call site) for the route-wide kinds and
// one per (kind, collection) otherwise, every MISS_LOG_INTERVAL_MS:
//   route_missing   404 that never reached the collection route (HTML body /
//                   x-matched-path=/404) — the regression above. Always logged.
//   rejected        any other 4xx: our request no longer fits the contract
//                   (CAIP format, auth, rate limit). Always logged.
//   bad_body        2xx that is not a recognizable collection, or names a
//                   different contract. Always logged.
//   not_found       JSON 404 (documented), 2xx null/empty (pre-index), or a 5xx
//                   with an EMPTY body — which is what the live route returns for
//                   an unindexed contract today (verified 2026-11-18).
//   upstream_error  any other 5xx.     network   fetch threw (timeout, reset).
// The last three are expected during indexer lag for a fresh deploy, so they are
// logged only when the caller says the collection is KNOWN to be indexed
// (`expectIndexed`, typically isKnownIndexed(kvMeta) or the Patron collection).
// Every miss still returns `detail: null`, so each caller keeps its fallback.
// ───────────────────────────────────────────────────────────────────────────

export const COLLECTION_DETAIL_CHAIN_ID = 8453

/** The upstream URL for one collection's detail record. */
export function collectionDetailUrl(
  address: string,
  chainId: number = COLLECTION_DETAIL_CHAIN_ID,
): string {
  return inprocessUrl(`/collections/eip155:${chainId}/erc1155:${address.toLowerCase()}`)
}

export interface CollectionIdentity {
  address: string
  /** null once lib/hiddenDeployer has stripped a hidden identity's handle. */
  username?: string | null
}

export interface CollectionDetailMetadata {
  name?: string
  image?: string
  description?: string
  kismet_thumbhash?: string
  [key: string]: unknown
}

/** Kismet-side normalized collection record (field names are the ones every consumer reads). */
export interface InprocessCollectionDetail {
  /** Lowercased contract address. */
  address: string
  id?: string
  chain_id?: number
  name?: string
  uri?: string
  protocol?: string
  /** The deployer identity. Same value as `default_admin` (see header). */
  creator?: CollectionIdentity
  default_admin?: CollectionIdentity
  /** Only if In Process ever returns it again; Kismet reads it on-chain now. */
  payout_recipient?: string
  admins?: string[]
  created_at?: string
  updated_at?: string
  metadata?: CollectionDetailMetadata
}

export type CollectionDetailMissKind =
  | 'route_missing'
  | 'rejected'
  | 'bad_body'
  | 'not_found'
  | 'upstream_error'
  | 'network'

export interface CollectionDetailMiss {
  kind: CollectionDetailMissKind
  status?: number
}

export type CollectionDetailResult =
  | { detail: InprocessCollectionDetail; miss?: undefined }
  | { detail: null; miss: CollectionDetailMiss }

// ── parsing ───────────────────────────────────────────────────────────────────

const HEX40 = /^0x[0-9a-fA-F]{40}$/

function hexAddress(v: unknown): string | undefined {
  return typeof v === 'string' && HEX40.test(v) ? v.toLowerCase() : undefined
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function isoDate(v: unknown): string | undefined {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `"0x…"` (live) or `{ address, username }` (documented / legacy) → identity. */
function parseIdentity(v: unknown, hoistedUsername?: unknown): CollectionIdentity | undefined {
  if (typeof v === 'string') {
    const address = hexAddress(v)
    if (!address) return undefined
    const username = nonEmptyString(hoistedUsername)
    return username ? { address, username } : { address }
  }
  if (isPlainObject(v)) {
    const address = hexAddress(v.address)
    if (!address) return undefined
    const username = nonEmptyString(v.username) ?? nonEmptyString(hoistedUsername)
    return username ? { address, username } : { address }
  }
  return undefined
}

/** Admins arrive as address strings here, as {artist_address} rows on the plural route. */
function parseAdmins(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: string[] = []
  for (const a of v) {
    const addr = hexAddress(isPlainObject(a) ? (a.artist_address ?? a.address) : a)
    if (addr && !out.includes(addr)) out.push(addr)
  }
  return out
}

function parseMetadata(v: unknown): CollectionDetailMetadata | undefined {
  if (!isPlainObject(v)) return undefined
  // Arbitrary keys pass (this is the creator-authored contract-metadata JSON,
  // not In Process identity data); the four keys Kismet renders must be strings.
  const out: CollectionDetailMetadata = { ...v }
  for (const k of ['name', 'image', 'description', 'kismet_thumbhash'] as const) {
    if (k in out && typeof out[k] !== 'string') delete out[k]
  }
  return out
}

/**
 * Map an upstream collection body onto the normalized record. Returns null when
 * the body is not a recognizable collection, or names a different contract than
 * `requestedAddress` (an upstream bug we must not render as this collection).
 */
export function normalizeCollectionDetail(
  raw: unknown,
  requestedAddress: string,
): InprocessCollectionDetail | null {
  if (!isPlainObject(raw)) return null
  const requested = requestedAddress.toLowerCase()
  const bodyAddress = hexAddress(raw.address) ?? hexAddress(raw.contractAddress)
  if (bodyAddress && bodyAddress !== requested) return null

  const legacyAdmin = parseIdentity(raw.default_admin)
  const creator = parseIdentity(raw.creator, raw.creator_username) ?? legacyAdmin
  const defaultAdmin = legacyAdmin ?? creator
  const metadata = parseMetadata(raw.metadata)
  const created_at = isoDate(raw.created_at)

  // Something collection-shaped must be present, or this is shape drift.
  if (!bodyAddress && !creator && !created_at && !metadata && !nonEmptyString(raw.uri)) return null

  const chainId = typeof raw.chain_id === 'number' ? raw.chain_id : Number(raw.chain_id ?? raw.chainId)
  const detail: InprocessCollectionDetail = { address: bodyAddress ?? requested }
  const id = nonEmptyString(raw.id)
  if (id) detail.id = id
  if (Number.isInteger(chainId) && chainId > 0) detail.chain_id = chainId
  const name = nonEmptyString(raw.name)
  if (name) detail.name = name
  const uri = nonEmptyString(raw.uri)
  if (uri) detail.uri = uri
  const protocol = nonEmptyString(raw.protocol)
  if (protocol) detail.protocol = protocol
  if (creator) detail.creator = creator
  if (defaultAdmin) detail.default_admin = defaultAdmin
  const payout = hexAddress(raw.payout_recipient)
  if (payout) detail.payout_recipient = payout
  const admins = parseAdmins(raw.admins)
  if (admins) detail.admins = admins
  if (created_at) detail.created_at = created_at
  const updated_at = isoDate(raw.updated_at)
  if (updated_at) detail.updated_at = updated_at
  if (metadata) detail.metadata = metadata
  return detail
}

export interface CollectionDetailResponse {
  status: number
  contentType: string | null
  matchedPath: string | null
  bodyText: string
}

/** Pure classification of one upstream response (no I/O, no logging). */
export function classifyCollectionDetailResponse(
  r: CollectionDetailResponse,
  requestedAddress: string,
): CollectionDetailResult {
  const body = r.bodyText.trim()
  const isJson = (r.contentType ?? '').toLowerCase().includes('json')
  const miss = (kind: CollectionDetailMissKind): CollectionDetailResult => ({
    detail: null,
    miss: { kind, status: r.status },
  })
  // Vercel stamps the route that served the request; '/404' means none did.
  if (r.matchedPath === '/404') return miss('route_missing')
  if (r.status >= 200 && r.status < 300) {
    // A null/empty 2xx was the old route's pre-index answer.
    if (!body || body === 'null') return miss('not_found')
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return miss('bad_body')
    }
    const detail = normalizeCollectionDetail(parsed, requestedAddress)
    return detail ? { detail } : miss('bad_body')
  }
  if (r.status === 404) return miss(isJson ? 'not_found' : 'route_missing')
  if (r.status >= 400 && r.status < 500) return miss('rejected')
  if (r.status >= 500 && !body) return miss('not_found')
  return miss('upstream_error')
}

// ── "known indexed" ───────────────────────────────────────────────────────────

/** In Process's indexer picks a deploy up within minutes; past this, a miss is a regression. */
export const INDEXER_GRACE_MS = 60 * 60 * 1000

/**
 * True when Kismet's own KV record proves the collection should be indexed by
 * now: a meta row exists and its deploy stamp is older than INDEXER_GRACE_MS. A
 * row with no stamp predates stamping (addTrackedCollection), so it is old.
 * Structural type, so lib/kv can use this without an import cycle.
 */
export function isKnownIndexed(
  meta: { createdAt?: number } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!meta) return false
  const t = meta.createdAt
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return true
  return now - t > INDEXER_GRACE_MS
}

// ── loud, throttled logging ───────────────────────────────────────────────────

const ALWAYS_LOUD: ReadonlySet<CollectionDetailMissKind> = new Set([
  'route_missing',
  'rejected',
  'bad_body',
])

export const MISS_LOG_INTERVAL_MS = 10 * 60 * 1000

// Next compiles each route into its own server bundle, each with its own copy
// of this module, so module state would throttle per bundle rather than per
// process. The log ledger therefore lives on globalThis.
type MissLog = LRUCache<string, { last: number; suppressed: number }>
const MISS_LOG_SLOT = Symbol.for('kismet.inprocessCollection.missLog')
const missLog: MissLog = ((globalThis as unknown as Record<symbol, MissLog | undefined>)[
  MISS_LOG_SLOT
] ??= new LRUCache(500))

// Returns how many identical lines were swallowed since the last emit, or null
// to stay quiet. A contract break hits every lookup (feeds fan out per
// collection), so route-wide kinds key by CALL SITE — one line per affected
// surface, not per lookup; per-collection kinds key by address so each
// known-indexed collection that goes missing is named once.
function claimLogSlot(key: string, now: number): number | null {
  const entry = missLog.get(key)
  if (entry && now - entry.last < MISS_LOG_INTERVAL_MS) {
    entry.suppressed++
    return null
  }
  missLog.set(key, { last: now, suppressed: 0 })
  return entry?.suppressed ?? 0
}

const DRIFT_HINT =
  'Callers fall back to KV, so header usernames, OG creators, feed creator chips and the Patron ' +
  'pass-exclude roles degrade without any other error. Re-check lib/inprocessCollection.ts against the ' +
  'LIVE route (documented as GET /collections/{network}/{contract}, operationId getCollectionInfo).'

async function reportMiss(
  address: string,
  miss: CollectionDetailMiss,
  ctx: {
    caller: string
    url: string
    contentType?: string | null
    matchedPath?: string | null
    bodySnippet?: string
    expectIndexed?: boolean | (() => boolean | Promise<boolean>)
  },
): Promise<void> {
  const loud = ALWAYS_LOUD.has(miss.kind)
  if (!loud) {
    let expected = false
    try {
      const e = ctx.expectIndexed
      expected = typeof e === 'function' ? await e() : e === true
    } catch {
      expected = false
    }
    if (!expected) return
  }
  const key = loud ? `route:${miss.kind}:${ctx.caller}` : `collection:${miss.kind}:${address}`
  const suppressed = claimLogSlot(key, Date.now())
  if (suppressed === null) return
  const parts = [
    miss.status !== undefined ? `HTTP ${miss.status}` : 'no response',
    ctx.matchedPath ? `x-matched-path=${ctx.matchedPath}` : null,
    ctx.contentType ? ctx.contentType.split(';')[0] : null,
  ].filter(Boolean)
  const what = loud
    ? `collection-detail ${miss.kind.toUpperCase().replace('_', ' ')}`
    : `collection-detail ${miss.kind} for a collection Kismet knows is indexed`
  const tail = suppressed > 0 ? ` (+${suppressed} similar suppressed in the last ${MISS_LOG_INTERVAL_MS / 60_000}m)` : ''
  const body = ctx.bodySnippet ? ` body=${JSON.stringify(ctx.bodySnippet)}` : ''
  console.error(
    `[inprocess] ${what} (${parts.join(', ')}) for ${address} via ${ctx.caller} — GET ${ctx.url}.${body} ${DRIFT_HINT}${tail}`,
  )
}

// ── fetch ─────────────────────────────────────────────────────────────────────

export interface FetchCollectionDetailOptions {
  /** Short call-site label for logs, e.g. 'collection-page'. */
  caller: string
  /** Defaults to Base (8453). */
  chainId?: number
  /** Next data-cache window in seconds (default 60). Ignored with noStore. */
  revalidate?: number
  /** Bypass Next's data cache (cron rebuilds, boot probes that need live truth). */
  noStore?: boolean
  timeoutMs?: number
  /**
   * Whether this collection is KNOWN to be indexed, which makes a not_found /
   * upstream_error / network miss loud. Pass a thunk when the answer needs I/O
   * that is already in flight (a KV read): it is only evaluated on a miss.
   */
  expectIndexed?: boolean | (() => boolean | Promise<boolean>)
}

/**
 * Fetch and normalize one collection's In Process record. Never throws: a miss
 * returns `{ detail: null, miss }` so the caller's existing fallback runs, and
 * the miss is logged per the rules in the header.
 */
export async function fetchInprocessCollection(
  address: string,
  opts: FetchCollectionDetailOptions,
): Promise<CollectionDetailResult> {
  if (!isAddress(address)) return { detail: null, miss: { kind: 'rejected' } }
  const lower = address.toLowerCase()
  const url = collectionDetailUrl(lower, opts.chainId)
  let res: Response
  let bodyText: string
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      ...(opts.noStore ? { cache: 'no-store' as const } : { next: { revalidate: opts.revalidate ?? 60 } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000),
    })
    bodyText = await res.text()
  } catch {
    const result: CollectionDetailResult = { detail: null, miss: { kind: 'network' } }
    await reportMiss(lower, result.miss, { caller: opts.caller, url, expectIndexed: opts.expectIndexed })
    return result
  }
  const contentType = res.headers.get('content-type')
  const matchedPath = res.headers.get('x-matched-path')
  const result = classifyCollectionDetailResponse(
    { status: res.status, contentType, matchedPath, bodyText },
    lower,
  )
  if (result.miss) {
    // An HTML 404 page is noise in a log line; a JSON error body is the useful part.
    const bodySnippet = result.miss.kind === 'route_missing' ? undefined : bodyText.trim().slice(0, 200) || undefined
    await reportMiss(lower, result.miss, {
      caller: opts.caller,
      url,
      contentType,
      matchedPath,
      bodySnippet,
      expectIndexed: opts.expectIndexed,
    })
  }
  return result
}
