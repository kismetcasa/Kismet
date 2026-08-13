// Pure pinned-showcase logic shared by the client (ProfileView) and CI
// (scripts/verify-showcase-order.ts). Deliberately Redis-free: lib/showcase.ts
// owns pin/mode STORAGE; this module owns the type + ordering rules, so a
// client component can import it without dragging the server Redis client
// toward the bundle, and the verify script can exercise it with no env.

/**
 * How a profile renders for VISITORS (and for the owner/admin "public view"
 * preview): the full profile with the pinned items surfaced first in each
 * section ('full', the default), or the curated pinned showcase ('curated' —
 * only pinned artworks show). Owner-set via
 * POST /api/profile/[address]/public-view and delivered alongside the pins
 * payload. A profile that never chose is resolved server-side via
 * derivePublicViewMode below.
 */
export type PublicViewMode = 'curated' | 'full'

/**
 * Per-category pin cap. A showcase is a tight highlight reel, not a second
 * feed — small by design (GitHub pins 6 repos; IG 3 posts) and the cap also
 * bounds every pins read. 6 fills the curated showcase's lg+ three-column
 * grid with exactly two full rows (the old cap of 4 left a 3+1 orphan), and
 * is exactly one full row of the lg+ six-column dense grid where the full
 * profile floats pins first. Lives HERE (not lib/showcase) so the client can
 * import it without touching the Redis module; the server re-exports it and
 * enforces it in addPin. Raising it is purely permissive for existing pin
 * sets; lowering it would need a trim migration.
 */
export const MAX_PINS_PER_CATEGORY = 6

export function isPublicViewMode(value: unknown): value is PublicViewMode {
  return value === 'curated' || value === 'full'
}

/**
 * Default-mode policy for a profile with no stored choice: 'full' — complete,
 * browsable profiles out of the box — EXCEPT when the profile already has
 * pins. Pinners built their public page under the original showcase-only
 * model, where pinning was the act of choosing what visitors see; resolving
 * them to 'full' would silently republish everything they'd deliberately left
 * out. They stay 'curated' until they switch by hand. (lib/showcase.ts
 * materializes this verdict and locks 'full' in before a first-ever pin, so
 * post-rollout pinning reorders the full profile rather than flipping it.)
 */
export function derivePublicViewMode(hasPins: boolean): PublicViewMode {
  return hasPins ? 'curated' : 'full'
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

/**
 * Public-view source filter: drop rows the server flagged `hidden`. Owner-
 * scoped payloads deliberately include the owner's own hidden content so
 * the dashboard can badge it and offer unhide — the timeline flags hidden
 * mints on the creator's own feed, and the seller-scope listings GET flags
 * content-hidden rows the same way — but a VISITOR's fetch drops those rows
 * server-side. Every public-view render (including the owner/admin preview,
 * which re-renders the owner's arrays in place) must therefore pass its
 * source through this, or the preview shows artworks visitors never see.
 * Admin author-level shadow-hides (hidden-users) arrive UNflagged by
 * design — the preview deliberately doesn't reveal those. Returns `items`
 * unchanged when nothing is flagged (the visitor case: payloads arrive
 * pre-filtered, so this is one scan and no copy), mirroring pinsFirst.
 */
export function visibleToPublic<T extends { hidden?: boolean }>(items: T[]): T[] {
  return items.some((it) => it.hidden) ? items.filter((it) => !it.hidden) : items
}
