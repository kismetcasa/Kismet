import { headers } from 'next/headers'
import { isMobileUaString, isWebKitOnlyUaString } from './deviceUA'

/**
 * Server-side mobile detection from the request's User-Agent header.
 *
 * Used to pass an `isMobile` prop into client view components so they
 * can pick render strategies (lazy-mount cards beyond the fold, render
 * fewer eager grids, etc.) BEFORE the SSR HTML goes out. The decision
 * is baked into both the server-rendered HTML and the prop the client
 * hydrates with — no useEffect-based client detection, no hydration
 * window where desktop briefly sees a mobile tree.
 *
 * Regex covers the dominant mobile UAs:
 *   - iPhone / iPad / iPod (iOS Safari, iOS Mini App webview)
 *   - Android / Mobile     (Android Chrome, Firefox, Samsung)
 *
 * Anything else (desktop Chrome, desktop Safari, desktop Edge) returns
 * false — those callers render the eager/full-mount path unchanged.
 *
 * Caveat: iPads in "request desktop site" mode report as Mac and slip
 * through as desktop. Accepted: iPad in desktop mode has plenty of CPU.
 */
export async function isMobileUA(): Promise<boolean> {
  const h = await headers()
  // Shares the UA test with the client (isMobileDevice) via lib/deviceUA so the
  // SSR-baked `isMobile` prop and runtime decisions can never disagree.
  return isMobileUaString(h.get('user-agent') ?? '')
}

/**
 * Server-side twin of the client's isWebKitOnly() (lib/media/gateway) —
 * same shared UA test via lib/deviceUA. Used where the server must predict
 * which video URL the client will play (videoGatewayUrls puts the /api/img
 * proxy first for WebKit-only viewers), e.g. the detail page's
 * <link rel="preload" as="video"> target. Iframe embedding — the other
 * proxy-first trigger — is not knowable server-side; accepted, since the
 * canonical page (the only preload emitter) is overwhelmingly top-level.
 */
export async function isWebKitOnlyUA(): Promise<boolean> {
  const h = await headers()
  return isWebKitOnlyUaString(h.get('user-agent') ?? '')
}
