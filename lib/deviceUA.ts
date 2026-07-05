// Single source of truth for "is this a resource-constrained (mobile) device?".
// The same UA test runs on both surfaces so they can never disagree:
//   - server: isMobileUA() (lib/serverDevice) reads the request header and
//     bakes the result into the SSR HTML via the `isMobile` prop — used for
//     decisions that must be in the first paint (lazy-mount, layout).
//   - client: isMobileDevice() reads navigator for decisions made AFTER mount,
//     where no prop is threaded — currently the video decoder cap/release in
//     lib/media/feedPlayback.
//
// Mobile = iOS WebKit's small simultaneous-<video>-decoder budget + tighter
// memory. Desktop browsers (incl. desktop Safari) have neither limit, so they
// opt out of those mitigations.

// Known phone-app webview shells whose custom UA carries NONE of the
// standard tokens. Captured from production (Redis debug:ua-seen): the
// Farcaster mobile Mini App host sends literally "warpcast" — no Mozilla,
// no AppleWebKit, no iPhone/Android — so it fell through every UA test and
// SSR rendered it the desktop tree (eager-mount, desktop image policy)
// while the client-side RN-WebView leg could only fix runtime decisions.
// These shells are phones by definition; extend the list as new hosts
// appear, and pin each addition in scripts/verify-surfaces.ts.
const MOBILE_APP_SHELL_RE = /warpcast/i

/** Pure UA test — the one regex both surfaces share. */
export function isMobileUaString(ua: string): boolean {
  return /Mobile|Android|iPhone|iPad|iPod/i.test(ua) || MOBILE_APP_SHELL_RE.test(ua)
}

/**
 * Pure UA test for "WebKit-only" — Safari (desktop + iOS) and every iOS
 * webview/browser shell (CriOS, Mini App WKWebView), i.e. the AVFoundation
 * media stack. Chromium-based browsers all include "Chrome" and test false.
 * Shared by the client (lib/media/gateway isWebKitOnly — proxy-first video
 * sourcing) and the server (lib/serverDevice isWebKitOnlyUA — the detail
 * page's video preload target) so the two can never disagree about which
 * URL a WebKit viewer will actually play.
 */
export function isWebKitOnlyUaString(ua: string): boolean {
  // App-shell UAs (see MOBILE_APP_SHELL_RE) are included deliberately: the
  // decisions this test drives — proxy-first media sourcing and the video
  // preload target — are the correct ones inside those webviews on BOTH
  // OSes (the constrained-pool failure mode is the embed, not the engine),
  // and the client-side equivalents already route them via the RN-WebView
  // leg. Server and client must agree or the detail preload warms a URL
  // the player never requests.
  if (MOBILE_APP_SHELL_RE.test(ua)) return true
  return ua.includes('AppleWebKit') && !ua.includes('Chrome') && !ua.includes('Chromium')
}

/**
 * Client-side device class. SSR-safe: returns false when navigator is absent
 * (the server path uses isMobileUA() on the request header instead). Safe to
 * call after mount (effects, imperative coordinators); calling it during render
 * is fine too as long as the result doesn't drive the FIRST paint, since SSR
 * would compute false and the client could compute true.
 */
export function isMobileDevice(): boolean {
  return typeof navigator !== 'undefined' && isMobileUaString(navigator.userAgent)
}
