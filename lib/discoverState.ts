// Discover filter state — pure, framework-free, and deliberately OUTSIDE any
// 'use client' module: app/discover/page.tsx (a Server Component) calls
// parseDiscoverState during server render, and an export of a client module is
// an opaque client reference there — invoking one throws "Attempted to call
// parseDiscoverState() from the server" (the production /discover 500, digest
// 1841440540). Everything here is shared by the server page and the client
// pill bar; the UI lives in components/DiscoverFilters.tsx.
//
// One flat model for both markets. Every server-facing field maps 1:1 to a
// validated route param; market/watchlist are view-level. The URL is the
// single source of truth so filter states are shareable and the back button
// restores them. All writes flow through reconcileState so client state can
// never express a combination the server rejects or that is empty by
// definition.

export type PrimarySort = 'new' | 'trending' | 'latest-sales' | 'ending-soon'
export type SecondarySort = 'new' | 'price-asc' | 'price-desc' | 'expiring'
export type MediaKind = 'image' | 'video' | 'gif' | 'text'

export interface DiscoverState {
  market: 'primary' | 'secondary'
  // Primary
  sortP: PrimarySort
  free: boolean
  media: MediaKind | null
  /** 'standalone' (solo mints, the page default) | 'collections' | 'all'. */
  scope: 'standalone' | 'collections' | 'all'
  /** Only mints with a live secondary listing (the bridge as a filter). */
  resale: boolean
  /** Show the viewer's local watchlist instead of the feed (primary only). */
  watchlist: boolean
  // Secondary
  sortS: SecondarySort
  currency: 'eth' | 'usdc' | null
  priceMin: string | null
  priceMax: string | null
  expiring: boolean
  sellerArtist: boolean
  /** Only listings under their (server-snapshotted) mint price. */
  below: boolean
  royaltyMin: string | null
  collection: string | null
}

const DEFAULT_DISCOVER_STATE: DiscoverState = {
  market: 'primary',
  sortP: 'new',
  free: false,
  media: null,
  scope: 'standalone',
  resale: false,
  watchlist: false,
  sortS: 'new',
  currency: null,
  priceMin: null,
  priceMax: null,
  expiring: false,
  sellerArtist: false,
  below: false,
  royaltyMin: null,
  collection: null,
}

export const DECIMAL = /^\d+(\.\d{1,18})?$/
const ADDR = /^0x[a-fA-F0-9]{40}$/

// Per-currency decimal cap, mirroring the server's parseUnits denomination
// (USDC is 6dp). Without this a 7dp USDC bound passes the generic DECIMAL
// regex client-side but 400s server-side — bricking the feed behind a retry
// that can never succeed.
export function amountValid(v: string, currency: 'eth' | 'usdc'): boolean {
  return currency === 'usdc' ? /^\d+(\.\d{1,6})?$/.test(v) : DECIMAL.test(v)
}

// Sales-derived sorts (trending / latest-sales) exclude free mints by design —
// a free mint is not a sale — so free=1 under them is empty by definition. One
// choke point drops the incoherent combination (and any price bound the active
// currency's denomination can't express), applied to every parse AND every
// update so neither a pill tap nor a hand-edited URL can express a state the
// server would answer with a lie.
export function reconcileState(s: DiscoverState): DiscoverState {
  const next = { ...s }
  if (next.free && (next.sortP === 'trending' || next.sortP === 'latest-sales')) next.free = false
  if (!next.currency) {
    next.priceMin = null
    next.priceMax = null
  } else {
    if (next.priceMin && !amountValid(next.priceMin, next.currency)) next.priceMin = null
    if (next.priceMax && !amountValid(next.priceMax, next.currency)) next.priceMax = null
  }
  return next
}

/** Parse a query getter into a state. Lenient: anything malformed falls back
 *  to the default (a shared link with a bad param still renders the page). */
export function parseDiscoverState(get: (key: string) => string | null): DiscoverState {
  const s = { ...DEFAULT_DISCOVER_STATE }
  if (get('m') === 'secondary') s.market = 'secondary'
  const sortP = get('sort_p')
  if (sortP === 'trending' || sortP === 'latest-sales' || sortP === 'ending-soon') s.sortP = sortP
  if (get('free') === '1') s.free = true
  const media = get('media')
  if (media === 'image' || media === 'video' || media === 'gif' || media === 'text') s.media = media
  const scope = get('scope')
  if (scope === 'collections' || scope === 'all') s.scope = scope
  if (get('resale') === '1') s.resale = true
  if (get('watch') === '1') s.watchlist = true
  const sortS = get('sort_s')
  if (sortS === 'price-asc' || sortS === 'price-desc' || sortS === 'expiring') s.sortS = sortS
  const currency = get('currency')
  if (currency === 'eth' || currency === 'usdc') s.currency = currency
  const priceMin = get('price_min')
  if (priceMin && DECIMAL.test(priceMin) && s.currency) s.priceMin = priceMin
  const priceMax = get('price_max')
  if (priceMax && DECIMAL.test(priceMax) && s.currency) s.priceMax = priceMax
  if (get('expiring') === '1') s.expiring = true
  if (get('seller') === 'artist') s.sellerArtist = true
  if (get('below') === '1') s.below = true
  const royaltyMin = get('royalty_min')
  if (royaltyMin && DECIMAL.test(royaltyMin) && Number(royaltyMin) <= 100) s.royaltyMin = royaltyMin
  const collection = get('collection')
  if (collection && ADDR.test(collection)) s.collection = collection
  return reconcileState(s)
}

/** Canonical /discover querystring for a state — fixed param order so equal
 *  states always produce byte-identical URLs (one edge-cache/react-query key
 *  family per state, never order-shuffled duplicates). Defaults are omitted,
 *  so the base page stays bare /discover. */
export function discoverUrl(s: DiscoverState): string {
  const q = new URLSearchParams()
  if (s.market === 'secondary') q.set('m', 'secondary')
  if (s.sortP !== 'new') q.set('sort_p', s.sortP)
  if (s.scope !== 'standalone') q.set('scope', s.scope)
  if (s.free) q.set('free', '1')
  if (s.media) q.set('media', s.media)
  if (s.resale) q.set('resale', '1')
  if (s.watchlist) q.set('watch', '1')
  if (s.sortS !== 'new') q.set('sort_s', s.sortS)
  if (s.currency) q.set('currency', s.currency)
  if (s.priceMin) q.set('price_min', s.priceMin)
  if (s.priceMax) q.set('price_max', s.priceMax)
  if (s.expiring) q.set('expiring', '1')
  if (s.sellerArtist) q.set('seller', 'artist')
  if (s.below) q.set('below', '1')
  if (s.royaltyMin) q.set('royalty_min', s.royaltyMin)
  if (s.collection) q.set('collection', s.collection)
  const str = q.toString()
  return str ? `/discover?${str}` : '/discover'
}

/** Primary feed apiUrl. Param order (scope, sort, free, media, resale) keeps
 *  the default byte-identical to the pre-filter era
 *  ('/api/timeline?scope=standalone') so existing edge + react-query cache
 *  entries stay warm. */
export function primaryApiUrl(s: DiscoverState): string {
  let url = `/api/timeline?scope=${s.scope}`
  if (s.sortP !== 'new') url += `&sort=${s.sortP}`
  if (s.free) url += '&free=1'
  if (s.media) url += `&media=${s.media}`
  if (s.resale) url += '&resale=1'
  return url
}

/** Secondary feed apiUrl — default stays exactly '/api/listings'. */
export function secondaryApiUrl(s: DiscoverState): string {
  const q = new URLSearchParams()
  if (s.collection) q.set('collection', s.collection)
  if (s.currency) q.set('currency', s.currency)
  if (s.priceMin) q.set('price_min', s.priceMin)
  if (s.priceMax) q.set('price_max', s.priceMax)
  if (s.expiring) q.set('expiring', '1')
  if (s.sellerArtist) q.set('seller_type', 'artist')
  if (s.below) q.set('below', '1')
  if (s.royaltyMin) q.set('royalty_min', s.royaltyMin)
  if (s.sortS !== 'new') q.set('sort', s.sortS)
  const str = q.toString()
  return str ? `/api/listings?${str}` : '/api/listings'
}

export function hasActiveFilters(s: DiscoverState): boolean {
  return s.market === 'primary'
    ? s.free || s.media !== null || s.scope !== 'standalone' || s.resale || s.watchlist
    : s.currency !== null ||
        s.priceMin !== null ||
        s.priceMax !== null ||
        s.expiring ||
        s.sellerArtist ||
        s.below ||
        s.royaltyMin !== null ||
        s.collection !== null
}

/** The cleared-filters version of a state (market + sorts survive). */
export function clearedFilters(s: DiscoverState): DiscoverState {
  return {
    ...DEFAULT_DISCOVER_STATE,
    market: s.market,
    sortP: s.sortP,
    sortS: s.sortS,
  }
}
