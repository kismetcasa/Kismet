// First-party funnel counters — the app deliberately has no analytics service
// (lib/clientError.ts), which meant every funnel question ("where do new
// users drop off?", "does anyone see the connect modal and bail?") was
// unanswerable. This is the smallest honest instrument: seven named events,
// fire-and-forget beacons to /api/funnel, which day-buckets them in Redis.
// No identifiers, no payload beyond the event name — counts only.
//
// Read side: kismetart:funnel:<event>:<YYYY-MM-DD> in Redis (90-day TTL).

export type FunnelEvent =
  | 'landing'
  | 'connect_modal'
  | 'connect_success'
  | 'collect_attempt'
  | 'collect_success'
  | 'mint_attempt'
  | 'mint_success'

// De-dupe key for once-per-session events (currently just 'landing' — a
// back-nav to the feed isn't a new visit).
const SESSION_ONCE: ReadonlySet<FunnelEvent> = new Set(['landing'])

export function trackFunnel(event: FunnelEvent): void {
  try {
    if (typeof window === 'undefined') return
    if (SESSION_ONCE.has(event)) {
      const key = `kismetart:funnel-sent:${event}`
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, '1')
    }
    const body = JSON.stringify({ event })
    // sendBeacon survives page unload and never blocks; fall back to a
    // keepalive fetch where it's unavailable. Both fire-and-forget.
    if (navigator.sendBeacon?.('/api/funnel', body)) return
    void fetch('/api/funnel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Instrumentation must never become an error path.
  }
}
