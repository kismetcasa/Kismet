import type { QueryClient } from '@tanstack/react-query'
import { isInIframe } from '@/lib/media/gateway'
import { isReactNativeWebView } from '@/lib/miniAppEnv'

// Single source of truth for the react-query identity of a PaginatedGrid's
// first page. PaginatedGrid (the live consumer) and prefetch callers (e.g.
// DiscoverPage warming the trending/main tabs before they're clicked) MUST
// derive the URL + key from these helpers so a prefetched entry dedupes
// against the grid's own useQuery instead of firing a second request. If the
// two ever computed the key differently, the prefetch would be silently
// wasted.

/**
 * Page size for the paginated feeds — the third leg of the shared identity
 * above (the limit is baked into the URL, so grid + prefetch must agree).
 *
 * Constrained surfaces get 10 items before "load more", desktop 18.
 * "Constrained" = the SSR-baked mobile UA signal OR any iframe context
 * (the Farcaster/Base Mini App on DESKTOP runs with a desktop UA the
 * server can't distinguish, but shares the mobile constraints: an embedded
 * connection pool and a host page contending for it). isInIframe() is
 * synchronous and stable from the first client render, and the limit only
 * shapes the fetch URL + react-query key — never SSR markup (PaginatedGrid
 * renders a skeleton until its client query resolves) — so the SSR/client
 * divergence (the server always computes false for iframes) cannot cause a
 * hydration mismatch or a duplicate fetch. That is NOT true of `lazy`
 * (LazyMount), which shapes the SSR tree and must stay server-decided.
 */
export function feedPageLimit(serverConstrained: boolean): number {
  return serverConstrained || isInIframe() || isReactNativeWebView() ? 10 : 18
}

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

// `fresh` is the manual-refresh path: append `fresh=1` so the feed route
// bypasses its upstream revalidate window (returning genuinely new mints, not
// the ≤30s-cached copy the auto-load path is happy with) and set the browser
// fetch to `no-store` so a private HTTP cache can't shortcut it either. The
// param rides the URL so it's also the react-query key of the refetch — it
// never pollutes the normal cached feed's entry.
export async function fetchPageJson(url: string, fresh = false): Promise<PageResponse> {
  const target = fresh ? `${url}${url.includes('?') ? '&' : '?'}fresh=1` : url
  const res = await fetch(target, fresh ? { cache: 'no-store' } : undefined)
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
