import { formatEther, formatUnits } from 'viem'
import { USDC_BASE } from './zoraMint'

// ───────────────────────────────────────────────────────────────────────────
// TERMINOLOGY: "moment" (In Process wire) ⇄ "artwork" (Kismet UI)
//
// In Process — the upstream protocol/API this module is the SOLE client of —
// calls each NFT a "moment". Kismet presents that same object to users as an
// "artwork". That is a display-layer rename only: it lives in user-facing copy
// and deliberately does NOT cross this wire boundary. So, on purpose and
// permanently, the In Process contract keeps "moment" here:
//   • endpoint paths:  moment/create, moment/create/writing,
//                      /moment (GET + PATCH)
//     (comment READS moved off the moment namespace entirely: In Process's
//      2026-07 comments-contract migration removed /moment/comments and
//      serves GET /comments instead — same params and envelope)
//   • response keys:   `moments` (timeline array), `momentAdmins`
//   • request key:     the `moment: {…}` wrapper in the PATCH /moment body
//   • the `Moment` / `MomentDetail` interfaces below mirror In Process's JSON
//     field-for-field (token_id, created_at, admins, …) with NO remap layer,
//     so those field names are load-bearing wherever a response is consumed.
// The type/component NAMES (`Moment`, `MomentCard`, …) are Kismet-side labels,
// intentionally left as-is: renaming them buys no user-visible change and In
// Process can't observe them either way. When editing here, keep every wire
// token above intact and rebrand only what a user reads.
//
// URLs (2026-07 migration): Kismet's public pages live at /artwork/… —
// /moment/… is a permanent 308 redirect kept forever (next.config.mjs), and
// inbound-URL parsers accept both forms. Kismet's own /api/moment/* routes
// are internal machine endpoints and keep their paths. ESLint bans building
// new /moment links (eslint.config.mjs no-restricted-syntax).
// ───────────────────────────────────────────────────────────────────────────

export const INPROCESS_API = 'https://api.inprocess.world/api'

/** Build an inprocess API URL. Pass `path` with leading slash; nullish param values are skipped. */
export function inprocessUrl(
  path: string,
  params?: Record<string, string | number | undefined | null>,
): string {
  const url = new URL(`${INPROCESS_API}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v != null) url.searchParams.set(k, String(v))
    }
  }
  return url.toString()
}

// Default comment sent on collect when the user leaves the textarea blank.
// Used by the collect route to filter out non-meaningful comments before storing
// them on notifications. Defined here so frontend and backend share one source.
export const DEFAULT_COLLECT_COMMENT = 'collected on kismet'

// Labels for airdrop rows folded into the moment activity feed. An airdrop is
// a gift, not a purchase, so the copy differs from a collector's "collected on
// kismet". The comments route picks one per moment by collection and stamps it
// as the `comment` of each `kind: 'airdrop'` row:
//   - patron / mint-pass collection → "invited to kismet" (the recipient is
//     being invited to the platform via the pass), else
//   - any other collection → "airdropped on kismet".
export const AIRDROP_INVITE_COMMENT = 'invited to kismet'
export const AIRDROP_GENERIC_COMMENT = 'airdropped on kismet'

// Upstream page size of GET /comments. In Process's route hardcodes p_limit =
// COMMENTS_PAGE_SIZE = 20 into its Supabase RPC (in_process_api,
// src/lib/supabase/in_process_moment_comments/getMomentCommentsRpc.ts) and the
// {comments:[…]} envelope carries no total/hasMore of its own, so "raw page
// length >= this" is the only more-pages-exist signal available to the comments
// proxy route. `>=` (not `===`) tolerates an upstream limit+1-style overshoot.
// If In Process RAISES its page size, feeds whose total lands between the two
// values regress to a dead load-more click (self-terminating — degraded, not
// broken); if they LOWER it, full pages stop reaching this threshold and deeper
// rows would become unreachable — re-verify this constant on any comments
// migration audit (cf. the 2026-07 /moment/comments → /comments move).
export const INPROCESS_COMMENTS_PAGE_SIZE = 20

// Legacy default-comment strings still present in historical on-chain data
// and the upstream comments feed: pre-rename ("collected via Kismet Art") and
// the post-brand-rename interim ("collected via Kismet"). Used by the activity
// renderer so old rows show the same standardized label as new ones.
const LEGACY_DEFAULT_COLLECT_COMMENTS = [
  'collected via kismet art',
  'collected via kismet',
] as const

export function isPlatformCollectComment(comment: string | null | undefined): boolean {
  // Absent is the same answer as empty — either way there is no human-written
  // comment to surface. The wide signature is for Notification.comment, which
  // is genuinely optional in its own domain: NotificationRow and
  // farcasterNotifications both hold a possibly-absent value and had to guard
  // truthiness before calling in. (Activity rows arrive already normalized —
  // see normalizeMomentComments — so they are never the reason for this.)
  const c = comment?.trim().toLowerCase() ?? ''
  if (!c) return true
  if (c === DEFAULT_COLLECT_COMMENT) return true
  if (LEGACY_DEFAULT_COLLECT_COMMENTS.includes(c as typeof LEGACY_DEFAULT_COLLECT_COMMENTS[number])) return true
  // Zora stamps "Collecting from the frame by <creator>" as the on-chain
  // comment when a collect originates from its Farcaster Frame — an artifact
  // of that path, not a comment the collector wrote. Prefix match because the
  // trailing creator name varies; normalize it to the standard label too.
  return c.startsWith('collecting from the frame')
}

interface SalesConfig {
  type: 'fixedPrice' | 'erc20Mint'
  pricePerToken: string
  saleStart: string
  saleEnd: string
  currency?: string
}

interface MomentAdmin {
  address: string
  username?: string
  hidden: boolean
  // Server-stitched from Kismet KV; absent for FC-only creators.
  avatarUrl?: string
}

interface MomentMetadataInline {
  name?: string
  description?: string
  image?: string
  animation_url?: string
  external_url?: string
  content?: { uri?: string; mime?: string }
  /**
   * Base64-encoded thumbhash (~25 bytes) generated at upload time. When
   * present, MomentImage renders it as a blurDataURL placeholder for an
   * instant low-fi preview while real bytes load. Custom field — namespaced
   * to survive indexer passthrough of unknown JSON keys.
   */
  kismet_thumbhash?: string
}

// Moment object as returned by GET /api/timeline (metadata inlined)
export interface MomentSaleConfig {
  /** Zora sale strategy: fixedPrice = ETH (FixedPriceSaleStrategy),
   *  erc20Mint = USDC (ERC20Minter). Drives inferCollectCurrency. */
  type?: 'fixedPrice' | 'erc20Mint'
  /** Price per token in base units (wei for ETH, 6-dp for USDC). */
  pricePerToken: string
  saleStart?: string
  saleEnd?: string
  /** ERC20 currency address (USDC) when type === 'erc20Mint'. */
  currency?: string
}

export interface Moment {
  address: string
  token_id: string
  chain_id?: number
  protocol?: string
  id?: string
  uri: string
  creator: MomentAdmin
  admins: MomentAdmin[]
  created_at: string
  updated_at?: string
  metadata?: MomentMetadataInline
  // Set to true by the timeline API when a hidden moment is returned to its
  // creator on their own profile feed, so the UI can show the hidden badge.
  // ENFORCED at the route: upstream inprocess rows can arrive with their own
  // `hidden` value, and the timeline strips it (normalizeHiddenFlag) so this
  // field only ever carries Kismet's verdict — consumers (the badge, the
  // public-view visibleToPublic filter) may trust it as-is.
  hidden?: boolean
  // Optional sale config. NOTE: /api/timeline does NOT currently stitch this
  // — server-side per-moment enrichment was reverted because the cold-cache
  // fan-out latency stacked onto mobile hydration (see the comment near the
  // end of app/api/timeline/route.ts). MomentCard's per-card /api/moment
  // fetch is the canonical price path for feed moments today. This field
  // stays so the fast path still fires for any caller that DOES supply it
  // (and so a future warm-cache enrichment can populate it without a type
  // change). Shape matches MomentDetail.saleConfig for trivial assignability.
  saleConfig?: MomentSaleConfig
  // Server-stitched chip metadata. Undefined = route didn't enrich
  // (client falls back). Defined-with-null-name = known contract, no
  // chip (suppress without re-fetching). isCuratedCollection marks whether
  // `address` is a curator-blessed collection (created via the Create
  // Collection flow, or an existing collection minted into) versus an
  // individual mint's auto-deployed wrapper — it drives whether the card
  // shows the collection name. Absent on non-enriched paths, where the
  // client's /api/collections?address fetch already gates the name on the
  // same blessed set.
  kismetCollection?: {
    name: string | null
    image: string | null
    isCuratedCollection?: boolean
  }
  // Video duration in whole seconds, server-stitched from MomentMeta
  // by /api/timeline. Populated only for Kismet-minted moments that
  // sent durationSec at mint time. Consumed by PaginatedGrid to seed
  // lib/media/durationCache so InlineVideo can pick long-form
  // preload at element-create time instead of waiting for loadedmetadata.
  kismet_duration_sec?: number
}

export interface Split {
  address: string
  percentAllocation: number
}

export interface CreateMomentPayload {
  contract: {
    address?: string
    name?: string
    uri?: string
  }
  token: {
    tokenMetadataURI: string
    createReferral: string
    salesConfig: SalesConfig
    mintToCreatorCount: number
    payoutRecipient?: string
    maxSupply?: number
  }
  splits?: Split[]
  account: string
}

export interface MomentComment {
  sender: string
  comment: string
  timestamp: number // may be ms or seconds — normalize before use
  // 'airdrop' marks a synthetic activity row the comments route folds in from
  // a Kismet airdrop record: `sender` is the RECIPIENT (the invited artist)
  // and the UI renders it as "invited to kismet". Absent/'collect' = an
  // on-chain collect comment from the inprocess feed.
  kind?: 'collect' | 'airdrop'
}

/**
 * Parse an untrusted `comments` payload into rows that satisfy MomentComment.
 *
 * This is what makes the interface above a GUARANTEE rather than a hope. Rows
 * are upstream data from In Process's Supabase-backed feed and cross two
 * boundaries that checked nothing — the /api/moment/comments proxy, which
 * relays them opaquely, and `res.json()` on the client, which is `any` and was
 * asserted straight into `MomentComment[]`. So the declared types were claims
 * nobody enforced, and three faults reached code that trusted them:
 *
 *   - a null/absent `comment` (the natural encoding of an empty nullable text
 *     column) threw in isPlatformCollectComment's `comment.trim()`,
 *   - an absent `sender` threw in the activity list's row-key derivation —
 *     before render, so the whole panel went down, not one row,
 *   - and a `comments` value that was not an ARRAY at all defeated any
 *     per-row guard, because `.filter` was the throw.
 *
 * Rows are REPAIRED where the fault is cosmetic and DROPPED only where it is
 * disqualifying: a missing comment becomes '' (which isPlatformCollectComment
 * already reads as the platform default label, exactly as an empty on-chain
 * comment does today), while a row with no sender or no finite timestamp is
 * dropped — it cannot be attributed, keyed, ordered, or linked, and rendering
 * it would print visible garbage. Unknown fields are preserved: the proxy
 * relays upstream's newer columns (username, commentId, replies…) opaquely and
 * this must not become the thing that strips them.
 */
export function normalizeMomentComments(rows: unknown): MomentComment[] {
  if (!Array.isArray(rows)) return []
  const out: MomentComment[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.sender !== 'string' || r.sender.length === 0) continue
    // Number() alone would NOT implement the rule stated above: Number(null),
    // Number(''), Number([]) and Number(false) are all 0 — finite — so a row
    // with no timestamp would be kept and rendered as a ~20000d age. Accept
    // only a real number or a numeric string.
    const rawTs = r.timestamp
    const timestamp =
      typeof rawTs === 'number'
        ? rawTs
        : typeof rawTs === 'string' && rawTs.trim() !== ''
          ? Number(rawTs)
          : NaN
    if (!Number.isFinite(timestamp)) continue
    // `kind` is Kismet's OWN synthetic marker (the comments route stamps
    // 'airdrop' on its folded rows; upstream rows carry no kind at all), so a
    // value outside the declared union can only be junk — normalized to
    // absent rather than carried through typed as something it is not.
    const kind = r.kind === 'collect' || r.kind === 'airdrop' ? r.kind : undefined
    out.push({
      ...r,
      sender: r.sender,
      timestamp,
      comment: typeof r.comment === 'string' ? r.comment : '',
      kind,
    } as MomentComment)
  }
  return out
}

/** Convert ar:// or ipfs:// URIs to fetchable HTTPS URLs */
export function resolveUri(uri: string): string {
  if (!uri) return ''
  if (uri.startsWith('ar://')) {
    return `https://arweave.net/${uri.slice(5)}`
  }
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.slice(7)}`
  }
  return uri
}

// No `maxSupply` field — /api/moment doesn't return one. Read on-chain
// via getTokenInfo(tokenId) instead.
export interface MomentDetail {
  uri: string
  owner: string
  // Optional: the upstream /moment payload can omit saleConfig for a moment
  // with no active sale (or during an indexer gap). /api/moments already
  // coalesces it to null and MomentDetailView guards every read; typed
  // honestly here so a new consumer is forced to handle the absent case
  // rather than crashing on an unchecked `detail.saleConfig.*`.
  saleConfig?: {
    type?: 'fixedPrice' | 'erc20Mint'
    pricePerToken: string
    saleStart: string
    saleEnd: string
    currency?: string
  }
  momentAdmins: string[]
  metadata: {
    name?: string
    description?: string
    image?: string
    animation_url?: string
    content?: { mime?: string; uri?: string }
    kismet_thumbhash?: string
  }
  // Set by /api/moment from the kismetart:hidden-moments KV. True when the
  // creator has hidden the moment from public feeds. Detail page renders
  // an unhide affordance for the creator and a hidden placeholder otherwise.
  hidden?: boolean
  // Set by /api/moment via a parallel lookup against the timeline endpoint,
  // which has a dedicated `creator` field. Inprocess's own /api/moment
  // shape only exposes momentAdmins (an unordered list of every admin
  // including platform/smart-wallet keys), so position [0] is not reliably
  // the minter. Prefer this when displaying "creator".
  creator?: { address: string; username: string | null } | null
}

/**
 * Map an inprocess saleConfig to the currency tag used by the direct-collect
 * hook. Prefers the explicit `type` field; falls back to comparing `currency`
 * against the USDC address. Returns 'eth' as a safe default for legacy
 * responses missing both fields.
 */
export function inferCollectCurrency(saleConfig: {
  type?: string
  currency?: string
}): 'eth' | 'usdc' {
  if (saleConfig.type === 'erc20Mint') return 'usdc'
  if (saleConfig.type === 'fixedPrice') return 'eth'
  // Fallback: only USDC is currently supported as an ERC20 currency.
  if (saleConfig.currency && saleConfig.currency.toLowerCase() === USDC_BASE.toLowerCase()) return 'usdc'
  return 'eth'
}

/**
 * Format a price for display. Accepts two input formats:
 * - **Base units** (e.g. `"100000000000000000"` for 0.1 ETH, or `"5000000"`
 *   for 5 USDC) — what we get back from on-chain reads and inprocess
 *   `saleConfig.pricePerToken`. ETH = 18 decimals, USDC = 6.
 * - **Human-formatted decimal** (e.g. `"0.1"`, `"5"`) — what inprocess
 *   `/api/payments` returns in `amount`. We render as-is with the right suffix.
 *
 * Returns `"free"` when the value is zero. Currency defaults to ETH for
 * legacy callers that don't pass it.
 */
export function formatPrice(
  pricePerToken: string,
  currency: 'eth' | 'usdc' = 'eth',
): string {
  if (!pricePerToken) return ''
  // Decimal-string path: inprocess `amount` like "0.1" or "5".
  if (pricePerToken.includes('.')) {
    // Strip trailing zeros + a bare trailing dot via an index walk, NOT a
    // backtracking `/…0+$/` regex (quadratic ReDoS on a crafted long decimal).
    let end = pricePerToken.length
    while (end > 0 && pricePerToken[end - 1] === '0') end--
    if (end > 0 && pricePerToken[end - 1] === '.') end--
    const trimmed = pricePerToken.slice(0, end)
    if (trimmed === '0') return 'free'
    return currency === 'usdc' ? `$${trimmed}` : `${trimmed} ETH`
  }
  // Base-units path: integer string like "100000000000000000".
  let value: bigint
  try {
    value = BigInt(pricePerToken)
  } catch {
    // Garbage input — render verbatim rather than crash.
    return pricePerToken
  }
  if (value === 0n) return 'free'
  if (currency === 'usdc') {
    const usd = formatUnits(value, 6)
    const trimmed = usd.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    return `$${trimmed}`
  }
  const eth = formatEther(value)
  const trimmed = eth.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return `${trimmed} ETH`
}

/** Shorten an Ethereum address for display */
export function shortAddress(address: string): string {
  if (!address) return ''
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * Normalize a timestamp that may be in seconds or milliseconds to milliseconds.
 * Activity rows mix sources — inprocess collect comments (seconds or ms) and
 * Kismet airdrop rows (ms from Date.now) — so a merged feed must compare them
 * on one scale. Same >1e12 heuristic formatRelativeTime uses internally.
 */
export function normalizeTimestampMs(timestamp: number): number {
  return timestamp > 1e12 ? timestamp : timestamp * 1000
}

export function formatRelativeTime(timestamp: number): string {
  const secs = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp
  const diff = Math.floor(Date.now() / 1000) - secs
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

// Max-uint64 "never expires" sentinel the mint form writes for an open-ended
// sale (components/MintForm.tsx) and the sale-window editor re-writes when a
// close date is cleared (lib/saleEdit.ts). Any saleEnd at or above this is not
// a real deadline — it must never render as a countdown ("closes in 5e11
// years"). Exported so mint + edit share one constant and can't drift; on
// chain uint64 can't exceed it, so open-ended ⇔ saleEnd == sentinel exactly.
export const OPEN_ENDED_SALE_SENTINEL = 18446744073709551615n

/**
 * Parse a saleConfig.saleEnd string to a real deadline in unix seconds, or
 * null when it names no deadline ("0" / the sentinel / non-numeric / absent).
 * THE single "is this a real deadline" classifier — getSaleWindow (countdown
 * display) and lib/saleEnds (the ending-soon feed index) both apply it, so
 * the two surfaces can't silently disagree about what counts as a deadline.
 * BigInt-parses first so the sentinel can't overflow Number precision and
 * read as a real (astronomically distant) deadline.
 */
export function parseRealSaleEnd(saleEnd: string | undefined | null): number | null {
  if (!saleEnd) return null
  try {
    const end = BigInt(saleEnd)
    if (end > 0n && end < OPEN_ENDED_SALE_SENTINEL) return Number(end)
  } catch {
    // non-numeric → no deadline
  }
  return null
}

/**
 * Classify a saleConfig.pricePerToken as free (true), priced (false), or
 * unknown (null). pricePerToken is base units — an integer string (wei for ETH,
 * 6-dp for USDC) — so a zero value is a free mint, which is not a "sale" and is
 * filtered out of the Latest/Most Sales feeds via the write-through free index
 * (lib/saleEnds). Absent / non-numeric input returns null so an ambiguous
 * value is never classified either way — the same "leave untouched" contract
 * parseRealSaleEnd uses for an absent saleEnd.
 */
export function isZeroPrice(pricePerToken: string | undefined | null): boolean | null {
  if (pricePerToken == null || pricePerToken === '') return null
  try {
    return BigInt(pricePerToken) === 0n
  } catch {
    return null
  }
}

export type SaleWindowState = 'scheduled' | 'closing' | 'live' | 'ended'

export interface SaleWindowInfo {
  /** Where the (collection, token) sits in its sale window right now. */
  state: SaleWindowState
  /** Unix-second timestamp of the edge this state hinges on — saleStart for
   *  `scheduled`, saleEnd for `closing` / `ended`. null for `live` (an
   *  open-ended sale in progress has no date to surface). */
  atSec: number | null
}

/**
 * Classify a moment's sale window for display — the structured companion to the
 * saleStart/saleEnd gating MomentCard + MomentDetailView already do, so
 * collectors can see WHEN a scheduled drop opens or a live one closes instead
 * of just a disabled "not started" / "sale ended" button. Returns null when
 * there's no saleConfig at all (nothing to say). Pair with formatSaleWindowLabel
 * to render an absolute, viewer-local date.
 *
 * saleStart/saleEnd are unix-second strings. saleStart "0"/absent = opens-now;
 * saleEnd "0"/absent or the max-uint64 sentinel = open-ended (per
 * parseRealSaleEnd, the shared deadline classifier).
 */
export function getSaleWindow(
  saleConfig: { saleStart?: string; saleEnd?: string } | null | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): SaleWindowInfo | null {
  if (!saleConfig) return null

  const startNum = saleConfig.saleStart ? Number(saleConfig.saleStart) : 0

  // Resolve a real end (in seconds) or treat as open-ended.
  const realEnd = parseRealSaleEnd(saleConfig.saleEnd)
  const openEnded = realEnd === null
  const endNum = realEnd ?? 0

  // Not opened yet → scheduled (the start date is what matters).
  if (Number.isFinite(startNum) && startNum > nowSec) {
    return { state: 'scheduled', atSec: startNum }
  }
  // Real end already passed → ended.
  if (!openEnded && endNum <= nowSec) {
    return { state: 'ended', atSec: endNum }
  }
  // Live with a real upcoming close → closing.
  if (!openEnded) {
    return { state: 'closing', atSec: endNum }
  }
  // Live and open-ended → no date to surface.
  return { state: 'live', atSec: null }
}

/**
 * Format a unix-second instant as a short, absolute, VIEWER-LOCAL date —
 * "Jul 3, 3:00 PM" (or "Jul 3, 3:00 PM EDT" with the zone, or "Jul 3" date-only
 * for space-constrained surfaces). The year is appended only when the instant
 * isn't in the current year, so near-term drops stay terse while a far-future
 * (or far-past) one reads unambiguously. Locale + timezone come from the
 * runtime, so this MUST run client-side (see components/SaleWindow) or the SSR
 * pass would format in the server's timezone and mismatch on hydration.
 * Internal — callers go through formatSaleWindowLabel.
 */
function formatSaleDate(
  unixSec: number,
  { withTime = true, withTimeZone = false }: { withTime?: boolean; withTimeZone?: boolean } = {},
): string {
  const d = new Date(unixSec * 1000)
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric'
  if (withTime) {
    opts.hour = 'numeric'
    opts.minute = '2-digit'
    if (withTimeZone) opts.timeZoneName = 'short'
  }
  return d.toLocaleString(undefined, opts)
}

// Verb fronting the absolute date per state. `live` has no date, so no verb.
const SALE_STATE_VERB: Record<SaleWindowState, string | null> = {
  scheduled: 'Opens',
  closing: 'Sale ends',
  ended: 'Ended',
  live: null,
}

/**
 * Build the display label for a sale window — "Opens Jul 3, 3:00 PM",
 * "Sale ends Jul 8, 5:00 PM", "Ended Jun 25". Returns null when there's no dated
 * edge to show (no saleConfig, or a live open-ended sale). Formatting opts
 * (time, timezone) are forwarded to formatSaleDate so a roomy surface can show
 * the zone while a compact card shows date-only.
 */
export function formatSaleWindowLabel(
  info: SaleWindowInfo | null,
  opts?: { withTime?: boolean; withTimeZone?: boolean },
): string | null {
  if (!info || info.atSec == null) return null
  const verb = SALE_STATE_VERB[info.state]
  if (!verb) return null
  return `${verb} ${formatSaleDate(info.atSec, opts)}`
}

/**
 * Fetch the moments inside a single collection from inprocess's timeline API.
 * Returns [] on any error (network, non-2xx, malformed JSON, timeout) so
 * callers can render an empty state cleanly. `revalidate` controls
 * Next.js fetch caching. `timeoutMs` bounds a single request — without it
 * a hung upstream blocks the caller indefinitely, which is the difference
 * between "search is slow" and "search froze" when this is fanned out
 * across many collections (see lib/search.ts).
 */
export async function fetchCollectionMoments(
  collectionAddress: string,
  options: { revalidate?: number; limit?: number; timeoutMs?: number } = {},
): Promise<Moment[]> {
  // Default to a bounded read so a new caller that forgets `timeoutMs` can't
  // reintroduce an indefinite hang — opting out must be explicit (pass 0).
  const { revalidate = 60, limit = 50, timeoutMs = 8_000 } = options
  const controller = timeoutMs ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const url = inprocessUrl('/timeline', {
      collection: collectionAddress,
      limit,
      chain_id: '8453',
    })
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate },
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.moments) ? data.moments : []
  } catch {
    return []
  } finally {
    if (timer) clearTimeout(timer)
  }
}
