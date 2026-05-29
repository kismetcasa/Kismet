import type { QueryClient } from '@tanstack/react-query'

// Single source of truth for the react-query identity of a PaginatedGrid's
// first page. PaginatedGrid (the live consumer) and prefetch callers (e.g.
// DiscoverPage warming the trending/main tabs before they're clicked) MUST
// derive the URL + key from these helpers so a prefetched entry dedupes
// against the grid's own useQuery instead of firing a second request. If the
// two ever computed the key differently, the prefetch would be silently
// wasted.

// Shape of a paginated JSON response. itemsKey is dynamic per caller,
// so the items array is left un-typed here and narrowed per-call.
export interface PageResponse {
  pagination?: { total_pages?: number }
  [key: string]: unknown
}

export function paginatedFirstPageUrl(apiUrl: string, pageLimit: number): string {
  const sep = apiUrl.includes('?') ? '&' : '?'
  return `${apiUrl}${sep}page=1&limit=${pageLimit}`
}

export function paginatedQueryKey(firstPageUrl: string) {
  return ['paginated-grid', firstPageUrl] as const
}

export async function fetchPageJson(url: string): Promise<PageResponse> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed (${res.status})`)
  return res.json()
}

// Mirror PaginatedGrid's first-page query so the cache is warmed under the
// exact key the grid will read. staleTime matches the grid's 30s window, so
// a prefetch landing just before a tab click is treated as fresh and the
// grid renders from cache with no skeleton and no second network round-trip.
// Errors are swallowed (best-effort warm-up); the grid's own query surfaces
// real failures with its retry UI when the tab actually mounts.
export function prefetchPaginatedFirstPage(
  queryClient: QueryClient,
  apiUrl: string,
  pageLimit: number,
): void {
  const url = paginatedFirstPageUrl(apiUrl, pageLimit)
  void queryClient.prefetchQuery({
    queryKey: paginatedQueryKey(url),
    queryFn: () => fetchPageJson(url),
    staleTime: 30_000,
  })
}
