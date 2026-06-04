'use client'

import { useQuery } from '@tanstack/react-query'
import type { MomentSaleConfig } from '@/lib/inprocess'

// ── DataLoader-style coalescer ───────────────────────────────────────────────
// Per-card sale-config requests (dwell-gated, so only cards the user settles
// near enqueue) that land within one flush window collapse into a single
// /api/moments call. This is what composes Tier 1 (per-card react-query cache
// + cancellation) with Tier 2 (one batched request per visible page): each
// card keeps its own cache entry and key, but N concurrent network requests
// become one.

type Waiter = {
  resolve: (sc: MomentSaleConfig | null) => void
  reject: (err: unknown) => void
}

// key (`address:tokenId`, lowercased) → the queries waiting on it. An array
// because two distinct query instances can request the same moment before a
// flush (react-query dedupes same-key queries, so this is the rare cross-
// surface case, not the common one).
const queue = new Map<string, Waiter[]>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

// One frame's worth of coalescing. The above-fold cards' dwell timers fire
// together, so this gathers a page into one request with no perceptible delay.
const FLUSH_MS = 16
// Mirror the endpoint's ceiling so a flush never asks for more than the server
// will service in one call; the overflow rides the next flush.
const MAX_BATCH = 50

function scheduleFlush(): void {
  if (flushTimer !== null || typeof window === 'undefined') return
  flushTimer = setTimeout(flush, FLUSH_MS)
}

async function flush(): Promise<void> {
  flushTimer = null
  const keys = [...queue.keys()].slice(0, MAX_BATCH)
  if (keys.length === 0) return

  // Detach this flush's waiters before awaiting so requests arriving mid-flight
  // queue cleanly for the next one.
  const batch = new Map<string, Waiter[]>()
  for (const k of keys) {
    batch.set(k, queue.get(k)!)
    queue.delete(k)
  }
  if (queue.size > 0) scheduleFlush()

  try {
    const res = await fetch(`/api/moments?ids=${encodeURIComponent(keys.join(','))}`)
    if (!res.ok) throw new Error(`moments batch failed: ${res.status}`)
    const { sales } = (await res.json()) as {
      sales: Record<string, MomentSaleConfig | null>
    }
    for (const [key, waiters] of batch) {
      const sc = sales[key] ?? null
      for (const w of waiters) w.resolve(sc)
    }
  } catch (err) {
    for (const waiters of batch.values()) {
      for (const w of waiters) w.reject(err)
    }
  }
}

function loadMomentSale(key: string): Promise<MomentSaleConfig | null> {
  return new Promise((resolve, reject) => {
    const waiters = queue.get(key)
    if (waiters) waiters.push({ resolve, reject })
    else queue.set(key, [{ resolve, reject }])
    scheduleFlush()
  })
}

// ── Hook ─────────────────────────────────────────────────────────────────────
/**
 * Sale config (price + currency) for one moment, fetched lazily through the
 * batch loader and cached by react-query. `enabled` is driven by the caller's
 * in-view dwell gate, so a fast scroll never enqueues a request for a card the
 * user flies past; `staleTime` keeps a scroll-back from re-fetching.
 *
 * The query intentionally does not consume react-query's AbortSignal: the
 * underlying request is shared across a batch, so one card unmounting must not
 * cancel it for the others — and the result is keyed + cached, so a late
 * resolve simply warms the cache for the next mount.
 */
export function useMomentSale(address: string, tokenId: string, enabled: boolean) {
  const key = `${address.toLowerCase()}:${tokenId}`
  return useQuery({
    queryKey: ['moment-sale', key],
    queryFn: () => loadMomentSale(key),
    enabled,
    // Scroll-back within a minute reads cache rather than re-fetching;
    // react-query's default 5-min gcTime is comfortably longer, so the entry
    // is still cached for that scroll-back.
    staleTime: 60_000,
  })
}
