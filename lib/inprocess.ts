import { formatEther, formatUnits } from 'viem'
import { USDC_BASE } from './zoraMint'

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

// Legacy default-comment strings still present in historical on-chain data
// and the upstream comments feed: pre-rename ("collected via Kismet Art") and
// the post-brand-rename interim ("collected via Kismet"). Used by the activity
// renderer so old rows show the same standardized label as new ones.
const LEGACY_DEFAULT_COLLECT_COMMENTS = [
  'collected via kismet art',
  'collected via kismet',
] as const

export function isPlatformCollectComment(comment: string): boolean {
  const c = comment.trim().toLowerCase()
  if (!c) return true
  if (c === DEFAULT_COLLECT_COMMENT) return true
  return LEGACY_DEFAULT_COLLECT_COMMENTS.includes(c as typeof LEGACY_DEFAULT_COLLECT_COMMENTS[number])
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
  // Server-stitched from Kismet KV. Absent for FC-only creators —
  // MomentCard's resolver handles those.
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
  hidden?: boolean
  // Server-stitched by /api/timeline so MomentCard doesn't have to fire
  // a follow-up /api/moment per card (N+1 client round-trips eliminated).
  // Optional because (a) other callers of MomentCard pass moments from
  // sources that don't enrich, (b) the per-moment upstream fetch may
  // legitimately fail without poisoning the whole timeline response —
  // MomentCard's existing per-card fetch is the fallback in both cases.
  // Shape matches MomentDetail.saleConfig for trivial assignability.
  saleConfig?: {
    type?: 'fixedPrice' | 'erc20Mint'
    pricePerToken: string
    saleStart?: string
    saleEnd?: string
    currency?: string
  }
  // Server-stitched chip metadata. `name: null` means "known contract,
  // no chip" (don't re-fetch). Field undefined means the route didn't
  // enrich, and MomentCard falls back to fetchCollectionChip.
  kismetCollection?: {
    name: string | null
    image: string | null
  }
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
  saleConfig: {
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
    const trimmed = pricePerToken.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
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

export function formatRelativeTime(timestamp: number): string {
  const secs = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp
  const diff = Math.floor(Date.now() / 1000) - secs
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
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
  const { revalidate = 60, limit = 50, timeoutMs } = options
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
