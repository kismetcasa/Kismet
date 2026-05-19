'use client'

import { useState, useEffect, useCallback, useMemo, type ReactElement, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { CardSwiper, CardSwiperItem } from './CardSwiper'
import { LazyMount } from './LazyMount'

interface ItemHelpers {
  /** Optimistically drop this item from the rendered list (e.g. after a delete). */
  remove: () => void
  /** 0-based position; callers use this to mark above-the-fold items as priority. */
  index: number
  /**
   * Active layout mode. Callers branch their render — e.g. MomentCard
   * switches to `compact showCreator` in grid mode. Always 'feed' when
   * the parent doesn't pass `viewMode`.
   */
  viewMode: ViewMode
}

type ViewMode = 'feed' | 'grid'

interface PaginatedGridProps<T> {
  /** Base URL; the component appends `?page=N&limit=…`. Changing this resets + refetches. */
  apiUrl: string
  /** Top-level key in the JSON response holding the items array (e.g. 'moments'). */
  itemsKey: string
  /** Stable identity for each item — used for the React key + remove(). */
  getKey: (item: T) => string
  /** Must include a `key` prop on the returned element. */
  renderItem: (item: T, helpers: ItemHelpers) => ReactElement
  /** JSX shown when the (filtered) list is empty. */
  empty: ReactNode
  /** Rendered to the left of the refresh button (h1, sub-tab bar, etc.). */
  header?: ReactNode
  /** Optional client-side filter applied after fetch but before render. */
  filter?: (items: T[]) => T[]
  pageLimit?: number
  /**
   * 'feed' (default) renders the existing vertical grid (1/2/3 cols).
   * 'grid' renders a horizontal snap-scroller with cards at 2/3/4/6/8
   * visible per row across breakpoints. Callers wire this to
   * `useViewMode`; the toggle button itself is rendered separately
   * (e.g. inside the `header` slot, beside other filter pills).
   */
  viewMode?: ViewMode
  /**
   * When `true`, items beyond EAGER_MOUNT_COUNT defer mount until the
   * placeholder enters the viewport (via LazyMount). Default `false`
   * preserves the original eager-everywhere behavior.
   *
   * Callers (typically a server component) decide this — usually based
   * on server-side UA detection so the decision is baked into the SSR
   * HTML and the lazy/eager render tree never changes after hydration.
   * Don't toggle this client-side per render: it would cause LazyMount
   * components to remount when the toggle flips, defeating the point.
   *
   * Applies to both view modes — the IntersectionObserver fires on
   * horizontal scroll too, so swiper cards beyond the eager window
   * still defer mount until swiped near.
   */
  lazy?: boolean
}

// Eagerly mount this many items even when `lazy` is true. Covers above-
// the-fold content; everything below scrolls in via LazyMount.
const EAGER_MOUNT_COUNT = 6

// Shape of a paginated JSON response. itemsKey is dynamic per caller,
// so we leave the items array un-typed here and narrow per-call.
interface PageResponse {
  pagination?: { total_pages?: number }
  [key: string]: unknown
}

async function fetchPageJson(url: string): Promise<PageResponse> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed (${res.status})`)
  return res.json()
}

export function PaginatedGrid<T>({
  apiUrl,
  itemsKey,
  getKey,
  renderItem,
  empty,
  header,
  filter,
  pageLimit = 18,
  viewMode = 'feed',
  lazy = false,
}: PaginatedGridProps<T>) {
  const queryClient = useQueryClient()

  // First page goes through react-query's cache → tab-switching back
  // within the staleTime window renders instantly from cache instead
  // of refetching. The QueryClient is already mounted globally by
  // WagmiProvider (wagmi requires it), so this adds no bundle weight
  // and no provider boilerplate.
  //
  // The queryKey is the EXACT URL (apiUrl + pageLimit) so two callers
  // requesting the same data dedupe automatically, and a filter
  // toggle (apiUrl changes) cleanly switches to a different cache
  // entry without invalidating the previous one — meaning toggling
  // back is also instant.
  const firstPageUrl = useMemo(() => {
    const sep = apiUrl.includes('?') ? '&' : '?'
    return `${apiUrl}${sep}page=1&limit=${pageLimit}`
  }, [apiUrl, pageLimit])
  const queryKey = useMemo(
    () => ['paginated-grid', firstPageUrl] as const,
    [firstPageUrl],
  )

  const {
    data: firstPage,
    isPending: firstPending,
    isFetching: firstFetching,
    error: firstError,
    refetch,
  } = useQuery<PageResponse, Error>({
    queryKey,
    queryFn: () => fetchPageJson(firstPageUrl),
    // 30s "fresh" window — re-renders that mount while still fresh
    // skip the network entirely. After 30s, mounts render cached data
    // immediately AND fire a background refresh in parallel.
    staleTime: 30_000,
    // Keep cached data for 5 minutes after the last consumer unmounts.
    // Tab-switching round-trips on the discover page sit well within
    // this window; navigating to a moment detail and back also stays
    // cached.
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  // Subsequent pages (load-more) stay in component-local state. Caching
  // them globally adds complexity (page state per cache entry) without
  // a clear win — most users don't scroll past page 1, and a fresh
  // mount restarting at page 1 is the expected UX.
  const [extraPages, setExtraPages] = useState<T[][]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [loadingMore, setLoadingMore] = useState(false)

  // Reset load-more state when the underlying query changes (e.g. tab
  // swap, filter toggle). The first-page cache survives in react-query;
  // only the locally-accumulated extra pages need clearing.
  useEffect(() => {
    setExtraPages([])
    setCurrentPage(1)
  }, [firstPageUrl])

  const totalPages = firstPage?.pagination?.total_pages ?? 1
  // useMemo computes firstPageItems inline so the eslint-deps rule
  // doesn't trip on a recomputed array reference (which it would
  // because Array.isArray + cast happens on every render).
  const allItems = useMemo(() => {
    const firstPageItems: T[] = Array.isArray(firstPage?.[itemsKey])
      ? (firstPage[itemsKey] as T[])
      : []
    return [...firstPageItems, ...extraPages.flat()]
  }, [firstPage, itemsKey, extraPages])
  const visible = filter ? filter(allItems) : allItems

  // Optimistic remove — used after delete/list/etc. actions. Updates
  // BOTH the cached first page (so the item stays gone after the
  // user navigates away and comes back) and the local extra pages
  // (so it disappears immediately from the rendered list).
  const removeItem = useCallback(
    (key: string) => {
      queryClient.setQueryData<PageResponse>(queryKey, (old) => {
        if (!old) return old
        const oldItems = (old[itemsKey] as T[] | undefined) ?? []
        return { ...old, [itemsKey]: oldItems.filter((it) => getKey(it) !== key) }
      })
      setExtraPages((prev) =>
        prev.map((pg) => pg.filter((it) => getKey(it) !== key)),
      )
    },
    [queryClient, queryKey, itemsKey, getKey],
  )

  const loadMore = useCallback(async () => {
    const next = currentPage + 1
    if (next > totalPages || loadingMore) return
    setLoadingMore(true)
    try {
      const url = new URL(apiUrl, location.origin)
      url.searchParams.set('page', String(next))
      url.searchParams.set('limit', String(pageLimit))
      const data = await fetchPageJson(url.toString())
      const items: T[] = Array.isArray(data[itemsKey])
        ? (data[itemsKey] as T[])
        : []
      setExtraPages((prev) => [...prev, items])
      setCurrentPage(next)
    } catch {
      // Silent — user can tap "load more" again
    } finally {
      setLoadingMore(false)
    }
  }, [apiUrl, pageLimit, itemsKey, currentPage, totalPages, loadingMore])

  // Manual refresh: clears local extras and forces a fresh first-page
  // fetch through react-query. isFetching toggles around the refetch
  // so the icon spins.
  const refresh = useCallback(() => {
    setExtraPages([])
    setCurrentPage(1)
    void refetch()
  }, [refetch])

  // Show the skeleton only on cold load — the very first mount with no
  // cache. Subsequent mounts inside the gcTime window render cached
  // data immediately (no skeleton flash) with a silent background
  // revalidation when stale.
  const loading = firstPending && !firstPage
  const refreshing = firstFetching && !!firstPage
  const error = firstError?.message ?? null

  // Single source of truth for "wrap with LazyMount or not". Used in
  // both layouts so the eager/lazy split stays consistent: items above
  // EAGER_MOUNT_COUNT (or any item when lazy=false) render directly;
  // items past the threshold defer until in-viewport.
  function renderEntry(item: T, index: number): ReactElement {
    const key = getKey(item)
    const node = renderItem(item, {
      remove: () => removeItem(key),
      index,
      viewMode,
    })
    if (!lazy || index < EAGER_MOUNT_COUNT) return node
    return <LazyMount key={key}>{() => node}</LazyMount>
  }

  return (
    <div>
      <div className="flex items-center justify-between py-4">
        <div>{header}</div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-2 text-xs font-mono text-muted hover:text-dim transition-colors disabled:opacity-40"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          refresh
        </button>
      </div>

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-[#161616] border border-line">
              <div className="aspect-square bg-raised animate-pulse" />
              <div className="p-4 space-y-2">
                <div className="h-3 bg-raised animate-pulse w-2/3" />
                <div className="h-3 bg-raised animate-pulse w-1/3" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="border border-red-900/50 p-6 text-center">
          <p className="text-sm font-mono text-red-400">{error}</p>
          <button
            onClick={() => void refetch()}
            className="mt-4 text-xs font-mono text-dim hover:text-ink underline"
          >
            try again
          </button>
        </div>
      )}

      {!loading && !error && visible.length === 0 && empty}

      {!loading && visible.length > 0 && (
        <>
          {viewMode === 'grid' ? (
            <CardSwiper>
              {visible.map((item, index) => (
                <CardSwiperItem key={getKey(item)}>
                  {renderEntry(item, index)}
                </CardSwiperItem>
              ))}
              {currentPage < totalPages && (
                // "Load more" sits at the end of the swipe path — once the
                // user scrolls to the right edge they tap to append the
                // next page, mirroring the feed mode's bottom-of-list
                // button. Matches each card's responsive width so it
                // snaps into a card-shaped slot.
                <CardSwiperItem>
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="w-full h-full border border-line text-[10px] font-mono text-dim uppercase tracking-wider hover:border-muted hover:text-ink transition-colors disabled:opacity-40"
                  >
                    {loadingMore ? 'loading…' : 'load more →'}
                  </button>
                </CardSwiperItem>
              )}
            </CardSwiper>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {visible.map((item, index) => renderEntry(item, index))}
              </div>
              {currentPage < totalPages && (
                <div className="mt-8 text-center">
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className="px-8 py-3 border border-line text-xs font-mono text-dim uppercase tracking-wider hover:border-muted hover:text-ink transition-colors disabled:opacity-40"
                  >
                    {loadingMore ? 'loading…' : 'load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
