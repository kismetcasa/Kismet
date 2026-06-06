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

/** Pure UA test — the one regex both surfaces share. */
export function isMobileUaString(ua: string): boolean {
  return /Mobile|Android|iPhone|iPad|iPod/i.test(ua)
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
