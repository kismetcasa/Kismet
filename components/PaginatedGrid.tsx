'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { MaybeLazy } from './LazyMount'
import { trackPerf } from '@/lib/telemetry'
import {
  fetchPageJson,
  paginatedFirstPageUrl,
  paginatedQueryKey,
  type PageResponse,
} from '@/lib/paginatedGridQuery'

interface ItemHelpers {
  /** Optimistically drop this item from the rendered list (e.g. after a delete). */
  remove: () => void
  /** 0-based position; callers use this to mark above-the-fold items as priority. */
  index: number
}

type ViewMode = 'feed' | 'grid'

// Hoisted so the skeleton and the live grid use the same column
// classes — keeping them in sync was a maintenance hazard before.
const GRID_FEED = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4'
const GRID_GRID = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3'

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
   * 'feed' (default) renders the spacious vertical grid (1/2/3 cols).
   * 'grid' renders a denser vertical grid (2/3/4/6 cols) with compact
   * cards. Both modes scroll vertically with a "load more" button at
   * the bottom — only the column density changes. Callers wire this
   * to `useViewMode`; the toggle button itself is rendered separately
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
   */
  lazy?: boolean
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
  const firstPageUrl = useMemo(
    () => paginatedFirstPageUrl(apiUrl, pageLimit),
    [apiUrl, pageLimit],
  )
  const queryKey = useMemo(
    () => paginatedQueryKey(firstPageUrl),
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

  // Measure the open-feed "freeze" window: wall-clock from the first render
  // that has data to two frames later. If mounting the eager cards blocks the
  // main thread, the first rAF callback is delayed by that block, so the
  // elapsed approximates the freeze duration. Portable (performance.now +
  // rAF), so it reports on iOS WebKit where longtask/LoAF don't exist. Op-in
  // telemetry only; trackPerf is a no-op otherwise. One-shot per mount.
  const feedRenderStart = useRef<number | null>(null)
  const feedRenderLogged = useRef(false)
  if (firstPage && feedRenderStart.current === null) {
    feedRenderStart.current = performance.now()
  }
  useEffect(() => {
    if (!firstPage || feedRenderLogged.current || feedRenderStart.current === null) return
    feedRenderLogged.current = true
    const start = feedRenderStart.current
    requestAnimationFrame(() =>
      requestAnimationFrame(() => trackPerf('feed_render', performance.now() - start)),
    )
  }, [firstPage])

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

  // Eager/lazy mount decision lives in MaybeLazy (single source of the
  // EAGER_MOUNT_COUNT gate). Key goes on MaybeLazy itself per its contract.
  const gridClass = viewMode === 'grid' ? GRID_GRID : GRID_FEED
  function renderEntry(item: T, index: number): ReactElement {
    const key = getKey(item)
    const node = renderItem(item, { remove: () => removeItem(key), index })
    return (
      <MaybeLazy key={key} index={index} lazy={lazy}>
        {() => node}
      </MaybeLazy>
    )
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
        <div className={gridClass}>
          {Array.from({ length: viewMode === 'grid' ? 12 : 6 }).map((_, i) => (
            <div key={i} className="bg-[#161616] border border-line">
              <div className="aspect-square bg-raised animate-pulse" />
              <div className={viewMode === 'grid' ? 'p-2 space-y-1.5' : 'p-4 space-y-2'}>
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
          <div className={gridClass}>
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
    </div>
  )
}
