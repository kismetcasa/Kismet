'use client'

/**
 * Lightweight client-side rendering-perf telemetry. Off by default —
 * console stays clean for normal users.
 *
 * To enable for your session as an operator:
 *   - visit any kismet.art URL with ?telemetry=1 once (sticky across
 *     visits via localStorage), or
 *   - run `localStorage.setItem('kismet_telemetry', '1')` in DevTools.
 *
 * To disable:
 *   - visit any URL with ?telemetry=0, or
 *   - run `localStorage.removeItem('kismet_telemetry')` in DevTools.
 *
 * Once enabled, perf events stream to console.log as you interact
 * with the site. Use case: verify a deploy delivered its claimed
 * perf wins by comparing before/after values on the same surface.
 *
 * Trade-off vs a server-side aggregation pipeline: no cross-session
 * p95/p99 across many users, only the current browsing session. For
 * Kismet's scale and the realistic usage pattern (operator-driven
 * spot checks during deploys, not continuous monitoring) immediate
 * visibility in DevTools beats aggregation no one reviews.
 *
 * Privacy footprint: zero. Nothing leaves the browser. No network
 * requests, no storage beyond the opt-in toggle flag.
 */

export type EventName =
  | 'video_ttff'         // play() → first timeupdate, ms
  | 'image_lcp'          // PerformanceObserver largest-contentful-paint, ms
  | 'optimizer_400'      // Next.js /_next/image returned 400 — counter
  | 'pool_eviction'      // SharedVideoProvider idle-over-cap eviction — counter
  | 'feed_render'        // first feed page: data-present render → painted, ms
  | 'long_task'          // PerformanceObserver longtask duration (Chromium), ms

const STORAGE_KEY = 'kismet_telemetry'

// One-shot enable check at module load. Honors the URL param first so
// `?telemetry=1` works without an extra page navigation, then falls
// back to the persistent localStorage flag for sticky operator-mode.
let enabled = false
if (typeof window !== 'undefined') {
  try {
    const flag = new URL(window.location.href).searchParams.get('telemetry')
    if (flag === '1') localStorage.setItem(STORAGE_KEY, '1')
    else if (flag === '0') localStorage.removeItem(STORAGE_KEY)
    enabled = localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // SSR / private-mode storage block / disabled DOM-storage policy.
    // Telemetry stays off in those contexts — no errors, no warnings.
  }
}

function formatValue(name: EventName, value: number): string {
  if (
    name === 'video_ttff' ||
    name === 'image_lcp' ||
    name === 'feed_render' ||
    name === 'long_task'
  )
    return `${Math.round(value)}ms`
  return String(Math.round(value))
}

/**
 * Record a single perf event. Cheap when telemetry is disabled
 * (single boolean check) so call sites can stay hot-path-safe.
 */
export function trackPerf(name: EventName, value: number): void {
  if (!enabled || !Number.isFinite(value)) return
  console.log(`[telemetry] ${name}=${formatValue(name, value)}`)
}
