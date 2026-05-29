'use client'

import { useEffect } from 'react'
import { trackPerf } from '@/lib/telemetry'

/**
 * Mount once at app root to hook the page-level LCP signal that
 * isn't tied to a component lifecycle. PerformanceObserver is the
 * spec-mandated entry point — no polyfill, no SDK.
 *
 * The trackPerf call here is a no-op for normal users (telemetry
 * is off by default); when an operator has enabled the toggle, the
 * LCP value lands in DevTools console alongside the other events.
 *
 * Renders nothing.
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

      // Flush the running max on pagehide so the value at navigation
      // time is what we record. Per Web Vitals guidance.
      const onPageHide = () => {
        if (lastLcp > 0) trackPerf('image_lcp', lastLcp)
        observer.disconnect()
      }
      addEventListener('pagehide', onPageHide, { once: true })
      return () => {
        observer.disconnect()
        removeEventListener('pagehide', onPageHide)
      }
    } catch {
      // PerformanceObserver may throw on older browsers; telemetry is
      // best-effort by design.
    }
  }, [])

  return null
}
