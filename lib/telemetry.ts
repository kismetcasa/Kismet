'use client'

/**
 * Privacy-first real-user telemetry for Kismet rendering performance.
 *
 * Design goals:
 *   - Zero PII collected. No IPs, no user IDs, no cookies attached.
 *   - Respect saveData + doNotTrack signals — opt-out is honored.
 *   - Lightweight: no SDK, no third-party network. Direct sendBeacon.
 *   - Histogram-bucketed on the server (Redis HINCRBY) so no per-event
 *     row exists in storage — aggregation is the only retrievable form.
 *   - Domain-specific events that off-the-shelf analytics miss: Arweave
 *     gateway race winners, Next.js Image optimizer 400 rate, video
 *     pool eviction events, Mini App platform breakdown.
 *
 * Why not Vercel Analytics / GA4 / Cloudflare Web Analytics:
 *   - All three send per-event records to third-party origins.
 *   - None of them know what a "gateway race winner" or "Arweave
 *     propagation lag" is — we'd have to instrument these regardless.
 *   - Web Vitals (LCP/INP/CLS) is the only overlap; we capture that
 *     locally via PerformanceObserver alongside the domain-specific
 *     dimensions instead of duplicating across two systems.
 */

export type EventName =
  | 'video_ttff'         // play() → first timeupdate, ms
  | 'image_lcp'          // PerformanceObserver LCP entry, ms
  | 'gateway_winner'     // which gateway index won (0=arweave.net, 1=permagate.io, …)
  | 'optimizer_400'      // /_next/image returned 400 on a moment image
  | 'pool_eviction'      // SharedVideoProvider's idle-over-cap eviction fired

interface Dimensions {
  /** Page surface — feed/moment/profile/etc. Read from location.pathname. */
  surface: string
  /** Mini App engine vs desktop vs mobile-web. Distinguishes iOS WKWebView,
   *  Android WebView, Chromium, Safari — invisible to most analytics. */
  platform: string
  /** navigator.connection.effectiveType when available. */
  effectiveType?: string
}

interface PendingEvent {
  name: EventName
  value: number
  dims: Dimensions
}

const buffer: PendingEvent[] = []
let flushScheduled = false
let optOut: boolean | null = null

/**
 * One-shot opt-out check. Honors:
 *   - navigator.doNotTrack === '1'
 *   - navigator.connection.saveData (avoid taxing constrained networks)
 * Result is memoized for the page lifetime.
 */
function isOptedOut(): boolean {
  if (optOut !== null) return optOut
  if (typeof navigator === 'undefined') return (optOut = true)
  const dnt = navigator.doNotTrack === '1'
  const saveData = !!(navigator as unknown as { connection?: { saveData?: boolean } })
    .connection?.saveData
  return (optOut = dnt || saveData)
}

function detectSurface(): string {
  if (typeof location === 'undefined') return 'ssr'
  const p = location.pathname
  if (p === '/' || p.startsWith('/?')) return 'feed'
  if (p.startsWith('/moment/')) return 'moment'
  if (p.startsWith('/collection/')) return 'collection'
  if (p.startsWith('/profile/')) return 'profile'
  if (p.startsWith('/market')) return 'market'
  if (p.startsWith('/mint')) return 'mint'
  if (p.startsWith('/admin')) return 'admin'
  return 'other'
}

function detectPlatform(): string {
  if (typeof navigator === 'undefined') return 'ssr'
  const ua = navigator.userAgent || ''
  // Farcaster Mini App injects a recognizable token via FarcasterProvider;
  // fall back to UA sniffing for context detection without coupling to
  // the SDK's runtime presence.
  const inIframe = (() => {
    try { return window.self !== window.top } catch { return true }
  })()
  if (inIframe) {
    // Mini App = iframe + the host's UA hints; keep granular enough that
    // iOS WKWebView (smaller decoder budget) shows up distinctly.
    if (/iPhone|iPad|iPod/.test(ua)) return 'miniapp-ios'
    if (/Android/.test(ua)) return 'miniapp-android'
    return 'miniapp-other'
  }
  if (/iPhone|iPad|iPod/.test(ua)) return 'mobile-ios'
  if (/Android/.test(ua)) return 'mobile-android'
  return 'desktop'
}

function getEffectiveType(): string | undefined {
  return (navigator as unknown as { connection?: { effectiveType?: string } })
    .connection?.effectiveType
}

function defaultDims(): Dimensions {
  return {
    surface: detectSurface(),
    platform: detectPlatform(),
    effectiveType: getEffectiveType(),
  }
}

function flush() {
  flushScheduled = false
  if (buffer.length === 0) return
  // Snapshot + clear synchronously so a flush triggered by pagehide
  // doesn't race with an interleaved trackPerf call.
  const batch = buffer.splice(0)
  const body = JSON.stringify({ events: batch })
  // sendBeacon survives page unload; keepalive fetch is the fallback
  // for browsers that don't expose it (very old Safari).
  const sent = typeof navigator !== 'undefined' && navigator.sendBeacon
    ? navigator.sendBeacon('/api/telemetry', body)
    : false
  if (!sent) {
    fetch('/api/telemetry', {
      method: 'POST',
      body,
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => { /* silent — telemetry never affects user UX */ })
  }
}

function scheduleFlush() {
  if (flushScheduled) return
  flushScheduled = true
  // requestIdleCallback so we never compete with paint/interaction work.
  // setTimeout fallback bounded at 5s so events don't queue indefinitely
  // on the long tail of always-busy pages.
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => void
  }).requestIdleCallback
  if (ric) ric(flush, { timeout: 5000 })
  else setTimeout(flush, 1000)
}

let pagehideRegistered = false
function ensurePagehideFlush() {
  if (pagehideRegistered) return
  pagehideRegistered = true
  // pagehide fires on tab close, navigation, and bfcache freeze — catches
  // all the cases where unflushed events would otherwise be lost.
  // Using once=false intentionally: bfcache restore can fire pagehide
  // multiple times across a single page lifetime.
  addEventListener('pagehide', flush)
}

/**
 * Record a perf event. Cheap when opted-out (single boolean check).
 * Buffered + batched — calling this 100 times produces ~1 network request.
 */
export function trackPerf(
  name: EventName,
  value: number,
  dims: Partial<Dimensions> = {},
): void {
  if (isOptedOut()) return
  if (!Number.isFinite(value)) return
  buffer.push({ name, value, dims: { ...defaultDims(), ...dims } })
  scheduleFlush()
  ensurePagehideFlush()
}
