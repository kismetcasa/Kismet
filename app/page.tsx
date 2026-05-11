'use client'

import { useState, useEffect, useRef } from 'react'
import { useAccount } from 'wagmi'
import { MomentCard } from '@/components/MomentCard'
import { CollectionCard, type CollectionDisplay } from '@/components/CollectionCard'
import { FeaturedFeed } from '@/components/FeaturedFeed'
import { MarketView } from '@/components/MarketView'
import { PaginatedGrid } from '@/components/PaginatedGrid'
import type { Moment } from '@/lib/inprocess'
import { useAdmin } from '@/contexts/AdminContext'

// ─── types ───────────────────────────────────────────────────────────────────

type TabId = 'featured' | 'trending' | 'main' | 'roster' | 'market'

const DRAGGABLE: TabId[] = ['main', 'featured', 'trending', 'roster']
const LABEL: Record<TabId, string> = {
  featured: 'featured',
  trending: 'trending',
  main: 'main',
  roster: 'artists',
  market: 'market',
}

const ORDER_KEY = 'kismetart:tab-order'

// Reconcile a stored tab order with the current DRAGGABLE list: keep
// recognized entries in their saved positions, drop unknowns, and append
// any newly-added tabs at the end. Without the reconcile, adding a new
// draggable tab (like 'roster') would invalidate every existing user's
// stored order and reset them all to defaults.
function loadOrder(): TabId[] {
  if (typeof window === 'undefined') return DRAGGABLE
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return DRAGGABLE
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DRAGGABLE
    const valid = parsed.filter(
      (t): t is TabId => typeof t === 'string' && DRAGGABLE.includes(t as TabId),
    )
    const missing = DRAGGABLE.filter((t) => !valid.includes(t))
    return [...valid, ...missing]
  } catch {
    return DRAGGABLE
  }
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

  // Market is pinned to the right and not draggable; everything in `order`
  // (whose length tracks DRAGGABLE) is. Computing the cutoff from order
  // length keeps this honest if more draggable tabs are added later.
  const all: TabId[] = [...order, 'market']

  return (
    <div className="flex items-end gap-0 border-b border-[#2a2a2a]">
      {all.map((tab, idx) => {
        const draggable = idx < order.length
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
              relative px-4 py-2.5 text-xs font-mono tracking-wider uppercase
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
  apiUrl,
  emptyMessage = 'nothing here yet',
  header,
}: {
  apiUrl: string
  emptyMessage?: string
  header?: React.ReactNode
}) {
  return (
    <PaginatedGrid<Moment>
      apiUrl={apiUrl}
      itemsKey="moments"
      getKey={(m) => `${m.address}-${m.token_id}`}
      renderItem={(m, { index }) => (
        // First row at lg+ is 3 cards; prioritize those so their hero image
        // skips lazy-loading and gets fetchpriority=high on the gateway round-trip.
        <MomentCard key={`${m.address}-${m.token_id}`} moment={m} priority={index < 3} />
      )}
      empty={
        <div className="border border-[#2a2a2a] p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-[#555]">{emptyMessage}</p>
        </div>
      }
      header={header}
    />
  )
}

// ─── collections feed (paginated grid) ───────────────────────────────────────

function CollectionsFeed({ followingAddrs }: { followingAddrs?: string[] }) {
  const followingSet = followingAddrs
    ? new Set(followingAddrs.map((a) => a.toLowerCase()))
    : null
  const filter = followingSet
    ? (items: CollectionDisplay[]) =>
        items.filter((c) => {
          const admin = (c as { default_admin?: { address?: string } }).default_admin?.address?.toLowerCase()
          return admin ? followingSet.has(admin) : false
        })
    : undefined
  return (
    <PaginatedGrid<CollectionDisplay>
      apiUrl="/api/collections?feed=1"
      itemsKey="collections"
      getKey={(c) => c.contractAddress}
      renderItem={(c, { index }) => (
        <CollectionCard key={c.contractAddress} collection={c} priority={index < 3} />
      )}
      filter={filter}
      empty={
        <div className="border border-[#2a2a2a] p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-[#555]">no collections yet</p>
        </div>
      }
    />
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

  // scope=standalone keeps collection moments out of the mints sub-tab —
  // they surface inside their collection card instead of appearing twice.
  const apiUrl = followingAddrs.length
    ? `/api/timeline?scope=standalone&following=${followingAddrs.join(',')}`
    : '/api/timeline?scope=standalone'

  const subTabBar = (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setSubTab('mints')}
          className={`text-xs font-mono tracking-wider transition-colors ${
            subTab === 'mints' ? 'text-[#efefef]' : 'text-[#444] hover:text-[#888]'
          }`}
        >
          mints
        </button>
        <span className="text-xs font-mono text-[#2a2a2a] select-none">/</span>
        <button
          onClick={() => setSubTab('collections')}
          className={`text-xs font-mono tracking-wider transition-colors ${
            subTab === 'collections' ? 'text-[#efefef]' : 'text-[#444] hover:text-[#888]'
          }`}
        >
          collections
        </button>
      </div>
      {address && (
        <button
          onClick={() => setFollowingOn((v) => !v)}
          className={`text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 border transition-colors ${
            followingOn
              ? 'border-[#8B5CF6] text-[#8B5CF6]'
              : 'border-[#2a2a2a] text-[#555] hover:border-[#444] hover:text-[#888]'
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
      apiUrl={apiUrl}
      emptyMessage="no moments yet — be the first to mint"
      header={subTabBar}
    />
  )
}

// ─── discover page ────────────────────────────────────────────────────────────

export default function DiscoverPage() {
  const { isAdmin, hasSession, startSession, featuredKeys, featuredCollectionAddrs } = useAdmin()
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
            {isAdmin && !hasSession && (
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
            apiUrl="/api/timeline?sort=trending&scope=standalone"
            emptyMessage="no collects recorded yet — trending appears as mints are collected"
          />
        )}

        {active === 'main' && <MainFeed />}

        {active === 'roster' && <RosterFeed />}

        {active === 'market' && (
          <div className="pt-4">
            <MarketView />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── roster feed ─────────────────────────────────────────────────────────────

interface CreatorListLite {
  slug: string
  name: string
  addresses: string[]
}

function RosterFeed() {
  const [lists, setLists] = useState<CreatorListLite[]>([])
  const [activeSlug, setActiveSlug] = useState<string | null>(null)
  const [listsLoaded, setListsLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/creator-lists')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { lists?: CreatorListLite[] }) => {
        const next = Array.isArray(d.lists) ? d.lists : []
        setLists(next)
        setActiveSlug(next[0]?.slug ?? null)
      })
      .catch(() => {})
      .finally(() => setListsLoaded(true))
  }, [])

  const activeList = lists.find((l) => l.slug === activeSlug) ?? null

  // No lists at all → empty state with curator hint. Don't render
  // MomentFeed since there's nothing to query.
  if (listsLoaded && lists.length === 0) {
    return (
      <div className="border border-[#2a2a2a] p-8 sm:p-16 text-center mt-4">
        <p className="text-sm font-mono text-[#555]">
          no creator rosters yet
        </p>
        <p className="text-xs font-mono text-[#444] mt-2">
          a curator can create one from their profile
        </p>
      </div>
    )
  }

  // Empty list selected → don't fire the API call (?creators= would be
  // empty → match-nothing); show empty state inline.
  const apiUrl =
    activeList && activeList.addresses.length > 0
      ? `/api/timeline?creators=${activeList.addresses.join(',')}`
      : null

  const header = lists.length > 0 ? (
    <div className="flex items-center gap-2 flex-wrap">
      {lists.map((l) => (
        <button
          key={l.slug}
          onClick={() => setActiveSlug(l.slug)}
          className={`text-[10px] font-mono px-2.5 py-1 border transition-colors ${
            l.slug === activeSlug
              ? 'border-[#efefef] text-[#efefef]'
              : 'border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#888]'
          }`}
        >
          {l.name}
          <span className="ml-1.5 text-[#444]">{l.addresses.length}</span>
        </button>
      ))}
    </div>
  ) : null

  if (!apiUrl) {
    return (
      <div>
        <div className="py-4">{header}</div>
        <div className="border border-[#2a2a2a] p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-[#555]">
            {activeList ? 'this list has no creators yet' : 'select a roster'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <MomentFeed
      apiUrl={apiUrl}
      header={header}
      emptyMessage="no moments yet from this roster"
    />
  )
}
