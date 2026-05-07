'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccount } from 'wagmi'
import { RefreshCw } from 'lucide-react'
import { MomentCard } from '@/components/MomentCard'
import { CollectionCard, type CollectionDisplay } from '@/components/CollectionCard'
import { FeaturedFeed } from '@/components/FeaturedFeed'
import { MarketView } from '@/components/MarketView'
import type { Moment } from '@/lib/inprocess'
import { useAdmin } from '@/contexts/AdminContext'

// ─── types ───────────────────────────────────────────────────────────────────

type TabId = 'featured' | 'trending' | 'main' | 'market'

const DRAGGABLE: TabId[] = ['main', 'featured', 'trending']
const LABEL: Record<TabId, string> = {
  featured: 'featured',
  trending: 'trending',
  main: 'main',
  market: 'market',
}

const ORDER_KEY = 'kismetart:tab-order'

function loadOrder(): TabId[] {
  if (typeof window === 'undefined') return DRAGGABLE
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return DRAGGABLE
    const parsed = JSON.parse(raw) as TabId[]
    if (parsed.length === 3 && DRAGGABLE.every((t) => parsed.includes(t))) return parsed
  } catch {}
  return DRAGGABLE
}

// ─── tab bar ─────────────────────────────────────────────────────────────────

function TabBar({
  order,
  active,
  onSelect,
  onReorder,
}: {
  order: TabId[]
  active: TabId
  onSelect: (t: TabId) => void
  onReorder: (o: TabId[]) => void
}) {
  const dragIdx = useRef<number | null>(null)

  function onDragStart(idx: number) {
    dragIdx.current = idx
  }

  function onDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    if (dragIdx.current === null || dragIdx.current === idx) return
    const next = [...order]
    const [moved] = next.splice(dragIdx.current, 1)
    next.splice(idx, 0, moved)
    dragIdx.current = idx
    onReorder(next)
  }

  function onDragEnd() {
    dragIdx.current = null
  }

  const all: TabId[] = [...order, 'market']

  return (
    <div className="flex items-end gap-0 border-b border-[#2a2a2a]">
      {all.map((tab, idx) => {
        const draggable = idx < 3
        const isActive = tab === active
        return (
          <button
            key={tab}
            draggable={draggable}
            onDragStart={draggable ? () => onDragStart(idx) : undefined}
            onDragOver={draggable ? (e) => onDragOver(e, idx) : undefined}
            onDragEnd={draggable ? onDragEnd : undefined}
            onClick={() => onSelect(tab)}
            className={`
              relative px-3 py-2 text-[11px] font-mono tracking-wider uppercase
              transition-colors select-none
              ${isActive ? 'text-[#efefef]' : 'text-[#444] hover:text-[#888]'}
              ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}
            `}
          >
            {LABEL[tab]}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-px bg-[#efefef]" />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── moment feed ─────────────────────────────────────────────────────────────

function MomentFeed({
  feedKey,
  apiUrl,
  emptyMessage = 'nothing here yet',
  header,
}: {
  feedKey: string
  apiUrl: string
  emptyMessage?: string
  header?: React.ReactNode
}) {
  const [moments, setMoments] = useState<Moment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [refreshing, setRefreshing] = useState(false)

  const fetch_ = useCallback(
    async (p = 1, append = false) => {
      try {
        if (p === 1 && !append) setLoading(true)
        else setRefreshing(true)

        const url = new URL(apiUrl, location.origin)
        url.searchParams.set('page', String(p))
        url.searchParams.set('limit', '18')

        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`Failed (${res.status})`)
        const data = await res.json()

        setMoments((prev) => (append ? [...prev, ...data.moments] : data.moments))
        setTotalPages(data.pagination?.total_pages ?? 1)
        setPage(p)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load')
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiUrl],
  )

  // Reset + refetch when feedKey changes (tab switch or following toggle)
  useEffect(() => {
    setMoments([])
    setPage(1)
    fetch_(1)
  }, [feedKey, fetch_])

  return (
    <div>
      <div className="flex items-center justify-between py-4">
        <div>{header}</div>
        <button
          onClick={() => fetch_(1)}
          disabled={loading || refreshing}
          className="flex items-center gap-2 text-xs font-mono text-[#555] hover:text-[#888] transition-colors disabled:opacity-40"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          refresh
        </button>
      </div>

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-[#161616] border border-[#2a2a2a]">
              <div className="aspect-square bg-[#1a1a1a] animate-pulse" />
              <div className="p-4 space-y-2">
                <div className="h-3 bg-[#1a1a1a] animate-pulse w-2/3" />
                <div className="h-3 bg-[#1a1a1a] animate-pulse w-1/3" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="border border-red-900/50 p-6 text-center">
          <p className="text-sm font-mono text-red-400">{error}</p>
          <button
            onClick={() => fetch_(1)}
            className="mt-4 text-xs font-mono text-[#888] hover:text-[#efefef] underline"
          >
            try again
          </button>
        </div>
      )}

      {!loading && !error && moments.length === 0 && (
        <div className="border border-[#2a2a2a] p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-[#555]">{emptyMessage}</p>
        </div>
      )}

      {!loading && moments.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {moments.map((moment) => (
              <MomentCard key={`${moment.address}-${moment.token_id}`} moment={moment} />
            ))}
          </div>

          {page < totalPages && (
            <div className="mt-8 text-center">
              <button
                onClick={() => fetch_(page + 1, true)}
                disabled={refreshing}
                className="px-8 py-3 border border-[#2a2a2a] text-xs font-mono text-[#888] uppercase tracking-wider hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
              >
                {refreshing ? 'loading…' : 'load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── collections feed (paginated grid) ───────────────────────────────────────

function CollectionsFeed({ followingAddrs }: { followingAddrs?: string[] }) {
  const [items, setItems] = useState<CollectionDisplay[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchPage = useCallback(async (p = 1, append = false) => {
    try {
      if (p === 1 && !append) setLoading(true)
      else setRefreshing(true)
      const url = new URL('/api/collections', location.origin)
      url.searchParams.set('feed', '1')
      url.searchParams.set('page', String(p))
      url.searchParams.set('limit', '18')
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`Failed (${res.status})`)
      const data = await res.json()
      setItems((prev) => (append ? [...prev, ...(data.collections ?? [])] : data.collections ?? []))
      setTotalPages(data.pagination?.total_pages ?? 1)
      setPage(p)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { fetchPage(1) }, [fetchPage])

  const followingSet = followingAddrs
    ? new Set(followingAddrs.map((a) => a.toLowerCase()))
    : null
  const displayItems = followingSet
    ? items.filter((c) => {
        const admin = (c as { default_admin?: { address?: string } }).default_admin?.address?.toLowerCase()
        return admin ? followingSet.has(admin) : false
      })
    : items

  return (
    <div>
      <div className="flex items-center justify-end py-4">
        <button
          onClick={() => fetchPage(1)}
          disabled={loading || refreshing}
          className="flex items-center gap-2 text-xs font-mono text-[#555] hover:text-[#888] transition-colors disabled:opacity-40"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          refresh
        </button>
      </div>

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-[#161616] border border-[#2a2a2a]">
              <div className="aspect-square bg-[#1a1a1a] animate-pulse" />
              <div className="p-4 space-y-2">
                <div className="h-3 bg-[#1a1a1a] animate-pulse w-2/3" />
                <div className="h-3 bg-[#1a1a1a] animate-pulse w-1/3" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="border border-red-900/50 p-6 text-center">
          <p className="text-sm font-mono text-red-400">{error}</p>
          <button onClick={() => fetchPage(1)} className="mt-4 text-xs font-mono text-[#888] hover:text-[#efefef] underline">
            try again
          </button>
        </div>
      )}

      {!loading && !error && displayItems.length === 0 && (
        <div className="border border-[#2a2a2a] p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-[#555]">no collections yet</p>
        </div>
      )}

      {!loading && displayItems.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {displayItems.map((c) => (
              <CollectionCard key={c.contractAddress} collection={c} />
            ))}
          </div>
          {page < totalPages && (
            <div className="mt-8 text-center">
              <button
                onClick={() => fetchPage(page + 1, true)}
                disabled={refreshing}
                className="px-8 py-3 border border-[#2a2a2a] text-xs font-mono text-[#888] uppercase tracking-wider hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
              >
                {refreshing ? 'loading…' : 'load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── main feed with sub-tabs (mints / collections) ───────────────────────────

type MainSubTab = 'mints' | 'collections'

function MainFeed() {
  const { address } = useAccount()
  const [subTab, setSubTab] = useState<MainSubTab>('mints')
  const [followingOn, setFollowingOn] = useState(false)
  const [followingAddrs, setFollowingAddrs] = useState<string[]>([])

  useEffect(() => {
    if (!address || !followingOn) { setFollowingAddrs([]); return }
    fetch(`/api/follow/${address}?list=1`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setFollowingAddrs(Array.isArray(d.addresses) ? d.addresses : []))
      .catch(() => setFollowingAddrs([]))
  }, [address, followingOn])

  const apiUrl = followingAddrs.length
    ? `/api/timeline?following=${followingAddrs.join(',')}`
    : '/api/timeline'

  const feedKey = `main-${followingOn ? 'following' : 'all'}-${followingAddrs.join(',')}`

  // Sub-pills row: mints (default) / collections, with the optional
  // "following" filter rendered alongside on the mints sub-tab. Following
  // doesn't apply to the collective collections feed, so it disappears
  // when the user switches to collections.
  const subTabBar = (
    <div className="flex items-center gap-3">
      {(['mints', 'collections'] as MainSubTab[]).map((id) => (
        <button
          key={id}
          onClick={() => setSubTab(id)}
          className={`text-xs font-mono tracking-wider px-2.5 py-1 border transition-colors ${
            subTab === id
              ? 'border-[#555] text-[#efefef]'
              : 'border-[#2a2a2a] text-[#444] hover:text-[#888] hover:border-[#444]'
          }`}
        >
          {id}
        </button>
      ))}
      {address && (
        <button
          onClick={() => setFollowingOn((v) => !v)}
          className={`text-xs font-mono tracking-wider px-2.5 py-1 border transition-colors ${
            followingOn
              ? 'border-[#555] text-[#efefef]'
              : 'border-[#2a2a2a] text-[#444] hover:text-[#888] hover:border-[#444]'
          }`}
        >
          following
        </button>
      )}
    </div>
  )

  if (subTab === 'collections') {
    return (
      <div>
        <div className="pt-4">{subTabBar}</div>
        <CollectionsFeed followingAddrs={followingOn && followingAddrs.length > 0 ? followingAddrs : undefined} />
      </div>
    )
  }

  return (
    <MomentFeed
      feedKey={feedKey}
      apiUrl={apiUrl}
      emptyMessage="no moments yet — be the first to mint"
      header={subTabBar}
    />
  )
}

// ─── discover page ────────────────────────────────────────────────────────────

export default function DiscoverPage() {
  const { isAdmin, session, startSession, featuredKeys, featuredCollectionAddrs } = useAdmin()
  const [order, setOrder] = useState<TabId[]>(DRAGGABLE)
  const [active, setActive] = useState<TabId>(DRAGGABLE[0])

  // Hydrate from localStorage after mount; activate leftmost tab
  useEffect(() => {
    const saved = loadOrder()
    setOrder(saved)
    setActive(saved[0])
  }, [])

  function handleReorder(next: TabId[]) {
    setOrder(next)
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)) } catch {}
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <TabBar order={order} active={active} onSelect={setActive} onReorder={handleReorder} />

      <div className="mt-2">
        {active === 'featured' && (
          <>
            {isAdmin && !session && (
              <div className="flex items-center justify-between py-4 border-b border-[#2a2a2a] mb-2">
                <p className="text-xs font-mono text-[#555]">
                  admin — sign to start curating
                </p>
                <button
                  onClick={startSession}
                  className="text-xs font-mono px-3 py-1.5 border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors"
                >
                  sign in
                </button>
              </div>
            )}
            <FeaturedFeed
              // Content-derived key so swapping a feature (un-feature A,
              // feature B in the same session) still triggers a re-fetch.
              // `.size` alone wouldn't change in that case.
              key={`featured-${[...featuredCollectionAddrs].join(',')}-${[...featuredKeys].join(',')}`}
              emptyMessage={isAdmin ? 'no featured mints or collections yet — click ★ on any mint or collection to feature it' : 'no featured mints or collections yet'}
            />
          </>
        )}

        {active === 'trending' && (
          <MomentFeed
            feedKey="trending"
            apiUrl="/api/timeline?sort=trending"
            emptyMessage="no collects recorded yet — trending appears as mints are collected"
          />
        )}

        {active === 'main' && <MainFeed />}

        {active === 'market' && (
          <div className="pt-4">
            <MarketView />
          </div>
        )}
      </div>
    </div>
  )
}
