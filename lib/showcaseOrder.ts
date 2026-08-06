// Pure pinned-showcase logic shared by the client (ProfileView) and CI
// (scripts/verify-showcase-order.ts). Deliberately Redis-free: lib/showcase.ts
// owns pin/mode STORAGE; this module owns the type + ordering rules, so a
// client component can import it without dragging the server Redis client
// toward the bundle, and the verify script can exercise it with no env.

/**
 * How a profile renders for VISITORS (and for the owner/admin "public view"
 * preview): the curated pinned showcase ('curated', the default — only pinned
 * artworks show), or the full profile with the pinned items surfaced first in
 * each section ('full'). Owner-set via POST /api/profile/[address]/public-view
 * and delivered alongside the pins payload; an unset profile is 'curated'.
 */
export type PublicViewMode = 'curated' | 'full'

export function isPublicViewMode(value: unknown): value is PublicViewMode {
  return value === 'curated' || value === 'full'
}

/**
 * Reduce `items` to the pinned ones, ordered by pin recency (`order` is the
 * newest-pinned-first ref list from /api/profile/[address]/pins). Items absent
 * from `order` — a pin buried past the profile's 50-item fetch window, or a
 * listing that's since been delisted — simply fall away, which is what lets
 * the visitor's curated view degrade gracefully to the full profile.
 */
export function orderByPins<T>(items: T[], keyOf: (t: T) => string, order: string[]): T[] {
  if (order.length === 0) return []
  const rank = new Map(order.map((k, i) => [k, i] as const))
  return items
    .filter((it) => rank.has(keyOf(it)))
    .sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0))
}

/**
 * Full-profile companion to orderByPins: keep EVERY item, but float the
 * pinned ones to the front — newest-pinned first, matching the showcase —
 * with the rest left in their incoming order. A stable partition, not a
 * sort, so a profile with 10 mints and 4 pins renders the 4 pins as the
 * first 4 and the other 6 exactly as the feed ordered them. Pin refs that
 * match nothing loaded are inert; no pins (or no pinned items loaded)
 * returns `items` unchanged.
 */
export function pinsFirst<T>(items: T[], keyOf: (t: T) => string, order: string[]): T[] {
  if (order.length === 0) return items
  const rank = new Map(order.map((k, i) => [k, i] as const))
  const pinned: T[] = []
  const rest: T[] = []
  for (const it of items) (rank.has(keyOf(it)) ? pinned : rest).push(it)
  if (pinned.length === 0) return items
  pinned.sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0))
  return [...pinned, ...rest]
}
