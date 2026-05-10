'use client'

import { useState, useEffect, useCallback, type ReactElement, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'

interface ItemHelpers {
  /** Optimistically drop this item from the rendered list (e.g. after a delete). */
  remove: () => void
}

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
}: PaginatedGridProps<T>) {
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [refreshing, setRefreshing] = useState(false)

  const fetchPage = useCallback(
    async (p = 1, append = false) => {
      try {
        if (p === 1 && !append) setLoading(true)
        else setRefreshing(true)
        const url = new URL(apiUrl, location.origin)
        url.searchParams.set('page', String(p))
        url.searchParams.set('limit', String(pageLimit))
        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`Failed (${res.status})`)
        const data = await res.json()
        const next: T[] = Array.isArray(data[itemsKey]) ? data[itemsKey] : []
        setItems((prev) => (append ? [...prev, ...next] : next))
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
    [apiUrl, itemsKey, pageLimit],
  )

  // apiUrl change (tab switch, following toggle, etc.) resets + refetches.
  useEffect(() => {
    setItems([])
    setPage(1)
    fetchPage(1)
  }, [fetchPage])

  const visible = filter ? filter(items) : items

  return (
    <div>
      <div className="flex items-center justify-between py-4">
        <div>{header}</div>
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
          <button
            onClick={() => fetchPage(1)}
            className="mt-4 text-xs font-mono text-[#888] hover:text-[#efefef] underline"
          >
            try again
          </button>
        </div>
      )}

      {!loading && !error && visible.length === 0 && empty}

      {!loading && visible.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((item) => {
              const key = getKey(item)
              return renderItem(item, {
                remove: () => setItems((prev) => prev.filter((it) => getKey(it) !== key)),
              })
            })}
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
