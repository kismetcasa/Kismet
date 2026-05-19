'use client'

import { useState, useEffect, useMemo } from 'react'
import { gatewayUrls } from '@/lib/arweave/gateways'

/**
 * Walk the AR.IO / IPFS gateway pool for `uri` on render error. Resets when
 * `uri` changes; calls `onAllError` once every gateway is exhausted.
 *
 * Shared by MomentImage, MomentImg, MomentVideo — every on-chain media
 * render path uses this same walker for consistent fallback semantics.
 */
export function useFallbackUrl(uri: string, onAllError?: () => void) {
  const urls = useMemo(() => gatewayUrls(uri), [uri])
  const [index, setIndex] = useState(0)
  useEffect(() => { setIndex(0) }, [uri])
  return {
    url: index < urls.length ? urls[index] : null,
    onError: () => {
      const next = index + 1
      if (next >= urls.length) onAllError?.()
      setIndex(next)
    },
  }
}

export function isProxiable(uri: string): boolean {
  return uri.startsWith('ar://') || uri.startsWith('ipfs://')
}

export function proxyUrl(uri: string): string {
  return `/api/img?u=${encodeURIComponent(uri)}`
}

/**
 * True on Safari (desktop + iOS) and any other WebKit-only context — Chrome
 * iOS (CriOS), Mini App iOS WKWebView, etc. False on Chromium-based browsers
 * (Chrome, Edge, Brave, Opera) which all include "Chrome" in their UA.
 *
 * Used to short-circuit the 'direct' gateway-walk fallback in MomentImage /
 * MomentImg: on WebKit, a stalled-but-not-yet-failed gateway request holds a
 * connection in the per-host pool for the browser's full ~30s timeout, and
 * stacked-up timeouts across a feed of cards can starve the entire UI (the
 * symptom: nav unresponsive, Safari "can barely inspect element" reports).
 * Chromium handles the same scenario gracefully — it parallelises + cancels
 * stalled fetches more aggressively — so we leave its path unchanged.
 *
 * The proxy already races every gateway server-side; if it failed there's
 * almost no chance the client-side walk through the same gateways succeeds.
 * Skipping the walk on WebKit trades a near-zero-yield resilience layer for
 * not melting the UI.
 *
 * UA-sniffing is a last-resort tactic — used here because there's no clean
 * feature test for "stalls hard on a saturated HTTP/2 host pool".
 */
export function isWebKitOnly(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return ua.includes('AppleWebKit') && !ua.includes('Chrome') && !ua.includes('Chromium')
}

/**
 * True when our page is running inside an iframe (the Mini App context
 * on Farcaster web, Base App web, any other host that embeds us). False
 * for top-level browsing.
 *
 * Used together with isWebKitOnly() to skip the direct-gateway-walk
 * fallback: an iframe shares the parent page's HTTP/2 connection pool
 * (Farcaster.xyz makes its own analytics/wallet/CDN calls in parallel
 * with ours). Stalled gateway requests pile up in that shared pool
 * even on Chromium, producing the same symptom as Safari standalone —
 * permagate.io timeouts visible in the iframe's console.
 *
 * Top-level Chrome browsing kismet.art directly does NOT match this
 * check (self === top) and keeps the original direct-walk fallback.
 *
 * Cross-origin `window.top` access throws — caught and treated as
 * "definitely in an iframe" because a same-origin frame wouldn't throw.
 */
export function isInIframe(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}
