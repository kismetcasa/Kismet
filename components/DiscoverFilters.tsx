'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { shortAddress } from '@/lib/inprocess'

// ── Discover filter state ─────────────────────────────────────────────────────
// One flat model for both markets. Every field maps 1:1 to a validated server
// param (commit 1); the URL is the single source of truth so filter states are
// shareable and the back button restores them.

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
  // Secondary
  sortS: SecondarySort
  currency: 'eth' | 'usdc' | null
  priceMin: string | null
  priceMax: string | null
  expiring: boolean
  sellerArtist: boolean
  royaltyMin: string | null
  collection: string | null
}

export const DEFAULT_DISCOVER_STATE: DiscoverState = {
  market: 'primary',
  sortP: 'new',
  free: false,
  media: null,
  scope: 'standalone',
  sortS: 'new',
  currency: null,
  priceMin: null,
  priceMax: null,
  expiring: false,
  sellerArtist: false,
  royaltyMin: null,
  collection: null,
}

const DECIMAL = /^\d+(\.\d{1,18})?$/
const ADDR = /^0x[a-fA-F0-9]{40}$/

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
  const royaltyMin = get('royalty_min')
  if (royaltyMin && DECIMAL.test(royaltyMin) && Number(royaltyMin) <= 100) s.royaltyMin = royaltyMin
  const collection = get('collection')
  if (collection && ADDR.test(collection)) s.collection = collection
  return s
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
  if (s.sortS !== 'new') q.set('sort_s', s.sortS)
  if (s.currency) q.set('currency', s.currency)
  if (s.priceMin) q.set('price_min', s.priceMin)
  if (s.priceMax) q.set('price_max', s.priceMax)
  if (s.expiring) q.set('expiring', '1')
  if (s.sellerArtist) q.set('seller', 'artist')
  if (s.royaltyMin) q.set('royalty_min', s.royaltyMin)
  if (s.collection) q.set('collection', s.collection)
  const str = q.toString()
  return str ? `/discover?${str}` : '/discover'
}

/** Primary feed apiUrl. Param order (scope, sort, free, media) keeps the
 *  default byte-identical to the pre-filter era ('/api/timeline?scope=standalone')
 *  so existing edge + react-query cache entries stay warm. */
export function primaryApiUrl(s: DiscoverState): string {
  let url = `/api/timeline?scope=${s.scope}`
  if (s.sortP !== 'new') url += `&sort=${s.sortP}`
  if (s.free) url += '&free=1'
  if (s.media) url += `&media=${s.media}`
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
  if (s.royaltyMin) q.set('royalty_min', s.royaltyMin)
  if (s.sortS !== 'new') q.set('sort', s.sortS)
  const str = q.toString()
  return str ? `/api/listings?${str}` : '/api/listings'
}

export function hasActiveFilters(s: DiscoverState): boolean {
  return s.market === 'primary'
    ? s.free || s.media !== null || s.scope !== 'standalone'
    : s.currency !== null ||
        s.priceMin !== null ||
        s.priceMax !== null ||
        s.expiring ||
        s.sellerArtist ||
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

// ── Shared pill primitives ────────────────────────────────────────────────────

const PILL_BASE =
  'shrink-0 rounded-full border px-3 py-1.5 font-mono text-[11px] tracking-wide transition-colors'
const PILL_OFF = 'border-line text-muted hover:border-dim hover:text-dim'
const PILL_ON = 'border-accent bg-accent/10 text-accent'

function PillToggle({
  label,
  on,
  onClick,
}: {
  label: string
  on: boolean
  onClick: () => void
}) {
  return (
    <button aria-pressed={on} onClick={onClick} className={`${PILL_BASE} ${on ? PILL_ON : PILL_OFF}`}>
      {label}
    </button>
  )
}

/** NavDropdown-style popover menu pill (outside-click + Escape to close). */
function PillMenu({
  label,
  active,
  children,
}: {
  label: ReactNode
  active: boolean
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEscapeKey(() => setOpen(false))
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`${PILL_BASE} inline-flex items-center gap-1 ${active ? PILL_ON : PILL_OFF}`}
      >
        {label}
        <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 min-w-[9rem] rounded-xl border border-line bg-[#121212] p-1 shadow-lg">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function MenuOption({
  label,
  selected,
  onSelect,
}: {
  label: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={`block w-full rounded-lg px-3 py-1.5 text-left font-mono text-[11px] transition-colors ${
        selected ? 'text-accent' : 'text-muted hover:bg-[#1c1c1c] hover:text-ink'
      }`}
    >
      {label}
    </button>
  )
}

/** Styled native select for sorts — accessible, zero-dependency. */
function SortSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      aria-label="Sort"
      className="shrink-0 appearance-none rounded-full border border-line bg-[#141414] px-3 py-1.5 font-mono text-[11px] text-dim outline-none hover:border-dim"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          ↓ {o.label}
        </option>
      ))}
    </select>
  )
}

// ── Price pill (secondary) ────────────────────────────────────────────────────
// Currency + min/max in one popover. Bounds commit on blur/Enter; the server
// requires a pinned currency for a price bound, so the inputs stay disabled
// until one is chosen.

function PricePill({
  state,
  onChange,
}: {
  state: DiscoverState
  onChange: (patch: Partial<DiscoverState>) => void
}) {
  const active = !!(state.currency || state.priceMin || state.priceMax)
  const label = active
    ? [
        state.priceMin && `≥ ${state.priceMin}`,
        state.priceMax && `≤ ${state.priceMax}`,
        state.currency?.toUpperCase() ?? '',
      ]
        .filter(Boolean)
        .join(' ') || 'price'
    : 'price'

  const commit = (key: 'priceMin' | 'priceMax', raw: string) => {
    const v = raw.trim()
    onChange({ [key]: v && DECIMAL.test(v) ? v : null })
  }

  return (
    <PillMenu label={label} active={active}>
      {() => (
        <div className="w-56 p-2">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">currency</p>
          <div className="mb-3 flex gap-1">
            {([null, 'eth', 'usdc'] as const).map((c) => (
              <button
                key={c ?? 'all'}
                onClick={() =>
                  // Clearing the currency clears the bounds with it — a
                  // currency-less price range is meaningless (server 400s it).
                  onChange(c === null ? { currency: null, priceMin: null, priceMax: null } : { currency: c })
                }
                className={`${PILL_BASE} px-2.5 py-1 ${state.currency === c ? PILL_ON : PILL_OFF}`}
              >
                {c === null ? 'all' : c.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">
            range {state.currency ? `(${state.currency.toUpperCase()})` : '— pick a currency'}
          </p>
          <div className="flex items-center gap-2">
            <input
              key={`min-${state.priceMin ?? ''}`}
              defaultValue={state.priceMin ?? ''}
              placeholder="min"
              inputMode="decimal"
              disabled={!state.currency}
              onBlur={(e) => commit('priceMin', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commit('priceMin', (e.target as HTMLInputElement).value)}
              className="w-full rounded-lg border border-line bg-[#0d0d0d] px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint disabled:opacity-40"
            />
            <span className="font-mono text-[11px] text-faint">—</span>
            <input
              key={`max-${state.priceMax ?? ''}`}
              defaultValue={state.priceMax ?? ''}
              placeholder="max"
              inputMode="decimal"
              disabled={!state.currency}
              onBlur={(e) => commit('priceMax', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commit('priceMax', (e.target as HTMLInputElement).value)}
              className="w-full rounded-lg border border-line bg-[#0d0d0d] px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint disabled:opacity-40"
            />
          </div>
        </div>
      )}
    </PillMenu>
  )
}

// ── Filters drawer (secondary long tail: collection, royalty) ─────────────────

interface CollectionOption {
  contractAddress: string
  label: string
}

function FiltersDrawer({
  state,
  onChange,
  onClose,
}: {
  state: DiscoverState
  onChange: (patch: Partial<DiscoverState>) => void
  onClose: () => void
}) {
  useEscapeKey(onClose)
  useBodyScrollLock()
  const [collections, setCollections] = useState<CollectionOption[] | null>(null)
  useEffect(() => {
    fetch('/api/collections?feed=1&page=1&limit=50')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const rows = Array.isArray(d?.collections) ? d.collections : []
        setCollections(
          rows.map((c: { contractAddress: string; name?: string; metadata?: { name?: string } }) => ({
            contractAddress: c.contractAddress,
            label: c.metadata?.name || c.name || shortAddress(c.contractAddress),
          })),
        )
      })
      .catch(() => setCollections([]))
  }, [])

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-label="All filters">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute bottom-0 right-0 top-0 w-80 max-w-full overflow-y-auto border-l border-line bg-[#121212] p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-dim">all filters</h2>
          <button onClick={onClose} aria-label="Close filters" className="p-1 text-muted hover:text-ink">
            <X size={15} />
          </button>
        </div>

        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">collection</p>
        <select
          value={state.collection ?? ''}
          onChange={(e) => onChange({ collection: e.target.value || null })}
          className="mb-4 w-full appearance-none rounded-lg border border-line bg-[#0d0d0d] px-2 py-2 font-mono text-[11px] text-ink outline-none"
        >
          <option value="">all collections</option>
          {(collections ?? []).map((c) => (
            <option key={c.contractAddress} value={c.contractAddress}>
              {c.label}
            </option>
          ))}
        </select>
        {collections === null && <p className="-mt-3 mb-4 font-mono text-[10px] text-faint">loading collections…</p>}

        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">min royalty %</p>
        <input
          key={state.royaltyMin ?? ''}
          defaultValue={state.royaltyMin ?? ''}
          placeholder="e.g. 5"
          inputMode="decimal"
          onBlur={(e) => {
            const v = e.target.value.trim()
            onChange({ royaltyMin: v && DECIMAL.test(v) && Number(v) <= 100 ? v : null })
          }}
          className="mb-6 w-full rounded-lg border border-line bg-[#0d0d0d] px-2 py-2 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
        />

        <button
          onClick={() => {
            onChange({ collection: null, royaltyMin: null })
            onClose()
          }}
          className="w-full rounded-full border border-line py-2 font-mono text-[11px] uppercase tracking-wider text-muted hover:border-dim hover:text-dim"
        >
          clear these
        </button>
      </div>
    </div>
  )
}

// ── The pill bar ──────────────────────────────────────────────────────────────

const PRIMARY_SORTS: { value: PrimarySort; label: string }[] = [
  { value: 'new', label: 'newest first' },
  { value: 'trending', label: 'most collected' },
  { value: 'latest-sales', label: 'latest sales' },
  { value: 'ending-soon', label: 'ending soon' },
]
const SECONDARY_SORTS: { value: SecondarySort; label: string }[] = [
  { value: 'new', label: 'newest listed' },
  { value: 'price-asc', label: 'price: low → high' },
  { value: 'price-desc', label: 'price: high → low' },
  { value: 'expiring', label: 'expiring first' },
]
const MEDIA_LABEL: Record<MediaKind, string> = {
  image: 'images',
  video: 'video',
  gif: 'gifs',
  text: 'writing',
}
const SCOPE_LABEL: Record<DiscoverState['scope'], string> = {
  standalone: 'solo mints',
  collections: 'collections',
  all: 'everything',
}

export function DiscoverPillBar({
  state,
  onChange,
  onSortChange,
}: {
  state: DiscoverState
  /** Filter refinement (history.replaceState). */
  onChange: (patch: Partial<DiscoverState>) => void
  /** Sort change (history.pushState — a navigation-grade change). */
  onSortChange: (patch: Partial<DiscoverState>) => void
}) {
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {state.market === 'primary' ? (
        <>
          <SortSelect value={state.sortP} options={PRIMARY_SORTS} onChange={(v) => onSortChange({ sortP: v })} />
          <PillToggle label="free mints" on={state.free} onClick={() => onChange({ free: !state.free })} />
          <PillMenu label={state.media ? MEDIA_LABEL[state.media] : 'media'} active={state.media !== null}>
            {(close) => (
              <>
                <MenuOption label="all media" selected={state.media === null} onSelect={() => { onChange({ media: null }); close() }} />
                {(Object.keys(MEDIA_LABEL) as MediaKind[]).map((k) => (
                  <MenuOption key={k} label={MEDIA_LABEL[k]} selected={state.media === k} onSelect={() => { onChange({ media: k }); close() }} />
                ))}
              </>
            )}
          </PillMenu>
          <PillMenu label={SCOPE_LABEL[state.scope]} active={state.scope !== 'standalone'}>
            {(close) => (
              <>
                {(['standalone', 'collections', 'all'] as const).map((sc) => (
                  <MenuOption key={sc} label={SCOPE_LABEL[sc]} selected={state.scope === sc} onSelect={() => { onChange({ scope: sc }); close() }} />
                ))}
              </>
            )}
          </PillMenu>
        </>
      ) : (
        <>
          <SortSelect value={state.sortS} options={SECONDARY_SORTS} onChange={(v) => onSortChange({ sortS: v })} />
          <PricePill state={state} onChange={onChange} />
          <PillToggle label="expiring soon" on={state.expiring} onClick={() => onChange({ expiring: !state.expiring })} />
          <PillToggle label="artist listings" on={state.sellerArtist} onClick={() => onChange({ sellerArtist: !state.sellerArtist })} />
          <button
            onClick={() => setDrawerOpen(true)}
            className={`${PILL_BASE} ${state.collection || state.royaltyMin ? PILL_ON : PILL_OFF}`}
          >
            filters ▾
          </button>
          {drawerOpen && <FiltersDrawer state={state} onChange={onChange} onClose={() => setDrawerOpen(false)} />}
        </>
      )}
    </div>
  )
}
