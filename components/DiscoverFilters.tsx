'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Star, X } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useWatchlist } from '@/hooks/useWatchlist'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import { isAddress } from '@/lib/address'
import { fetchCreatorProfile } from '@/lib/profileCache'
import {
  amountValid,
  DECIMAL,
  type DiscoverState,
  type MediaKind,
  type PrimarySort,
  type SecondarySort,
} from '@/lib/discoverState'

// State model, parsers, and URL builders live in lib/discoverState — pure and
// server-safe, because app/discover/page.tsx calls parseDiscoverState during
// SERVER render and exports of this 'use client' module are opaque client
// references there (invoking one 500s the page). This module is UI only.

// ── Shared pill primitives ────────────────────────────────────────────────────

const PILL_BASE =
  'shrink-0 rounded-full border px-3 py-1.5 font-mono text-[11px] tracking-wide transition-colors'
const PILL_OFF = 'border-line text-muted hover:border-dim hover:text-dim'
const PILL_ON = 'border-accent bg-accent/10 text-accent'

function PillToggle({
  label,
  on,
  onClick,
  disabled,
  disabledReason,
}: {
  label: string
  on: boolean
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
}) {
  return (
    <button
      aria-pressed={on}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      onClick={onClick}
      className={`${PILL_BASE} ${on ? PILL_ON : PILL_OFF} disabled:cursor-not-allowed disabled:opacity-40`}
    >
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
  // enabled=open: closed pills keep no window listener and Escape elsewhere
  // doesn't fan out no-op setStates across every pill on the bar.
  useEscapeKey(() => setOpen(false), open)
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
    // Currency-aware validation (USDC caps at 6dp) — mirrors the server's
    // parseUnits denomination so a committed bound can never 400 the feed.
    onChange({ [key]: v && state.currency && amountValid(v, state.currency) ? v : null })
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

// ── Artist pill (primary) ─────────────────────────────────────────────────────
// Typeahead over the existing /api/search profiles (2+ chars, debounced), plus
// a paste-an-address fast path. The applied pill resolves the artist's display
// name through the same profileCache the feed cards use.

function ArtistPill({
  state,
  onChange,
}: {
  state: DiscoverState
  onChange: (patch: Partial<DiscoverState>) => void
}) {
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    if (!state.artist) {
      setLabel(null)
      return
    }
    let cancelled = false
    fetchCreatorProfile(state.artist)
      .then(({ name }) => {
        if (!cancelled) setLabel(name)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [state.artist])

  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ address: string; username?: string }[] | null>(null)
  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) {
      setHits(null)
      return
    }
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setHits(Array.isArray(d?.users) ? d.users.slice(0, 6) : []))
        .catch(() => setHits([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  const pasted = isAddress(q.trim()) ? q.trim().toLowerCase() : null
  const pick = (address: string, close: () => void) => {
    onChange({ artist: address.toLowerCase() })
    setQ('')
    close()
  }

  return (
    <PillMenu
      label={state.artist ? `artist: ${label ?? shortAddress(state.artist)}` : 'artist'}
      active={state.artist !== null}
    >
      {(close) => (
        <div className="w-64 p-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search artists or paste 0x…"
            className="w-full rounded-lg border border-line bg-[#0d0d0d] px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint"
          />
          <div className="mt-1 flex flex-col">
            {state.artist && (
              <MenuOption label="clear artist" selected={false} onSelect={() => { onChange({ artist: null }); setQ(''); close() }} />
            )}
            {pasted && (
              <MenuOption
                label={`use ${shortAddress(pasted)}`}
                selected={state.artist === pasted}
                onSelect={() => pick(pasted, close)}
              />
            )}
            {hits?.map((u) => (
              <MenuOption
                key={u.address}
                label={u.username ? `${u.username} · ${shortAddress(u.address)}` : shortAddress(u.address)}
                selected={state.artist === u.address.toLowerCase()}
                onSelect={() => pick(u.address, close)}
              />
            ))}
            {hits !== null && hits.length === 0 && !pasted && (
              <p className="px-3 py-1.5 font-mono text-[10px] text-faint">no artists found</p>
            )}
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

/** Per-collection floors (base units per currency) from the listings
 *  snapshot — see ActiveListingSnapshot in lib/listings. */
export type CollectionFloors = Record<string, { eth?: string; usdc?: string }>

// Floor label for a collection option — ETH floor first (the dominant
// denomination), else USDC; nothing when the collection has no priced
// active listing. formatPrice keeps the rendering identical to every
// other price on the site.
function floorLabel(floors: CollectionFloors | null | undefined, address: string): string {
  const f = floors?.[address.toLowerCase()]
  if (!f) return ''
  const label = f.eth ? formatPrice(f.eth, 'eth') : f.usdc ? formatPrice(f.usdc, 'usdc') : null
  return label ? ` · floor ${label}` : ''
}

function FiltersDrawer({
  state,
  floors,
  onChange,
  onClose,
}: {
  state: DiscoverState
  floors?: CollectionFloors | null
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
              {floorLabel(floors, c.contractAddress)}
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
  floors,
  onChange,
  onSortChange,
}: {
  state: DiscoverState
  /** Collection floors for the drawer's picker labels. */
  floors?: CollectionFloors | null
  /** Filter refinement (history.replaceState). */
  onChange: (patch: Partial<DiscoverState>) => void
  /** Sort change (history.pushState — a navigation-grade change). */
  onSortChange: (patch: Partial<DiscoverState>) => void
}) {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { entries: watchlistEntries } = useWatchlist()

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {state.market === 'primary' ? (
        <>
          <SortSelect value={state.sortP} options={PRIMARY_SORTS} onChange={(v) => onSortChange({ sortP: v })} />
          <PillToggle
            label="free mints"
            on={state.free}
            // Sales-derived sorts exclude free mints by definition (see
            // reconcileState) — disabled with the reason, not a lying empty feed.
            disabled={state.sortP === 'trending' || state.sortP === 'latest-sales'}
            disabledReason="free mints have no sales — switch to newest or ending soon"
            onClick={() => onChange({ free: !state.free })}
          />
          <PillToggle label="has resale" on={state.resale} onClick={() => onChange({ resale: !state.resale })} />
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
          <ArtistPill state={state} onChange={onChange} />
          <button
            aria-pressed={state.watchlist}
            onClick={() => onChange({ watchlist: !state.watchlist })}
            className={`${PILL_BASE} inline-flex items-center gap-1.5 ${state.watchlist ? PILL_ON : PILL_OFF}`}
          >
            <Star size={11} strokeWidth={1.5} className={state.watchlist ? 'fill-accent' : ''} />
            watchlist{watchlistEntries.length > 0 ? ` (${watchlistEntries.length})` : ''}
          </button>
        </>
      ) : (
        <>
          <SortSelect value={state.sortS} options={SECONDARY_SORTS} onChange={(v) => onSortChange({ sortS: v })} />
          <PricePill state={state} onChange={onChange} />
          <PillToggle label="below mint" on={state.below} onClick={() => onChange({ below: !state.below })} />
          <PillToggle label="expiring soon" on={state.expiring} onClick={() => onChange({ expiring: !state.expiring })} />
          <PillToggle label="artist listings" on={state.sellerArtist} onClick={() => onChange({ sellerArtist: !state.sellerArtist })} />
          <button
            onClick={() => setDrawerOpen(true)}
            className={`${PILL_BASE} ${state.collection || state.royaltyMin ? PILL_ON : PILL_OFF}`}
          >
            filters ▾
          </button>
          {drawerOpen && <FiltersDrawer state={state} floors={floors} onChange={onChange} onClose={() => setDrawerOpen(false)} />}
        </>
      )}
    </div>
  )
}
