'use client'

import { useEffect, useState } from 'react'
import { trackPerf, onPerf, isTelemetryEnabled, type EventName } from '@/lib/telemetry'

/**
 * Mount once at app root to hook the page-level LCP signal that
 * isn't tied to a component lifecycle. PerformanceObserver is the
 * spec-mandated entry point — no polyfill, no SDK.
 *
 * The trackPerf call here is a no-op for normal users (telemetry
 * is off by default); when an operator has enabled the toggle, the
 * LCP value lands in DevTools console alongside the other events.
 *
 * When enabled it also renders a small on-screen perf badge (bottom-left)
 * so values are readable on a phone — including inside the Farcaster iOS
 * WebView, which has no console. Normal users never see it (the badge only
 * mounts when the operator toggle is on).
 */
export function TelemetryProvider() {
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return
    let lastLcp = 0
    try {
      const observer = new PerformanceObserver((entries) => {
        // LCP can update multiple times before page becomes idle; only
        // the LAST entry before user interaction or page-hide is the
        // final value (per Web Vitals guidance). Track the running max
        // here and flush via the pagehide listener below.
        for (const entry of entries.getEntries()) {
          const ts = (entry as PerformanceEntry & { renderTime?: number; loadTime?: number })
            .renderTime ?? (entry as PerformanceEntry & { loadTime?: number }).loadTime ?? 0
          if (ts > lastLcp) lastLcp = ts
        }
      })
      // buffered: true catches LCP entries that fired before this
      // observer attached (the LCP candidate often paints before
      // hydration completes).
      observer.observe({ type: 'largest-contentful-paint', buffered: true })

      // Long tasks (>50ms) are exactly the main-thread blocks that read as
      // a "freeze" on feed open. NOTE: WebKit/iOS doesn't support the
      // 'longtask' entry type — observe() throws there and the catch below
      // swallows it — so this reports only on Chromium Mini App webviews;
      // the feed_render timer in PaginatedGrid covers the iOS case.
      let longTaskObserver: PerformanceObserver | null = null
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) trackPerf('long_task', entry.duration)
        })
        longTaskObserver.observe({ type: 'longtask', buffered: true })
      } catch {
        longTaskObserver = null
      }

      // Flush the running max on pagehide so the value at navigation
      // time is what we record. Per Web Vitals guidance.
      const onPageHide = () => {
        if (lastLcp > 0) trackPerf('image_lcp', lastLcp)
        observer.disconnect()
        longTaskObserver?.disconnect()
      }
      addEventListener('pagehide', onPageHide, { once: true })
      return () => {
        observer.disconnect()
        longTaskObserver?.disconnect()
        removeEventListener('pagehide', onPageHide)
      }
    } catch {
      // PerformanceObserver may throw on older browsers; telemetry is
      // best-effort by design.
    }
  }, [])

  return <PerfBadge />
}

// Bottom-left readout of the latest perf values, shown only when the operator
// telemetry toggle is on. `mounted` gates the first render so SSR (always
// off) and the first client render match — the badge appears post-mount,
// avoiding a hydration mismatch.
function PerfBadge() {
  const [mounted, setMounted] = useState(false)
  const [perf, setPerf] = useState<Partial<Record<EventName, number>>>({})

  useEffect(() => {
    setMounted(true)
    if (!isTelemetryEnabled()) return
    return onPerf((name, value) => setPerf((p) => ({ ...p, [name]: value })))
  }, [])

  if (!mounted || !isTelemetryEnabled()) return null

  // feed_render is the headline "freeze" number: green <50ms, amber <150ms,
  // red beyond. The others are shown for context when present.
  const feed = perf.feed_render
  const feedColor =
    feed === undefined ? '#888' : feed < 50 ? '#6ee7b7' : feed < 150 ? '#fbbf24' : '#f87171'

  const rows: Array<[string, string, string?]> = []
  if (feed !== undefined) rows.push(['feed', `${Math.round(feed)}ms`, feedColor])
  if (perf.long_task !== undefined) rows.push(['task', `${Math.round(perf.long_task)}ms`])
  if (perf.image_lcp !== undefined) rows.push(['lcp', `${Math.round(perf.image_lcp)}ms`])

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        left: 8,
        bottom: 'calc(8px + var(--safe-bottom, 0px))',
        zIndex: 2147483647,
        pointerEvents: 'none',
        background: 'rgba(0,0,0,0.78)',
        border: '1px solid #2a2a2a',
        borderRadius: 4,
        padding: '4px 6px',
        font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#efefef',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      {rows.length === 0 ? (
        <span style={{ color: '#888' }}>perf: waiting…</span>
      ) : (
        rows.map(([label, val, color]) => (
          <span key={label}>
            <span style={{ color: '#888' }}>{label} </span>
            <span style={{ color: color ?? '#efefef' }}>{val}</span>
          </span>
        ))
      )}
    </div>
  )
}
