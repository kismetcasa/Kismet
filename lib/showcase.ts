import { redis } from './redis'
import { bestEffort } from './bestEffort'
import { derivePublicViewMode, type PublicViewMode } from './showcaseOrder'

// Per-owner "pinned showcase" ZSETs — one per profile section a user can
// curate. Mirrors lib/collected.ts: members are "<collection>:<tokenId>"
// tuples, score is pin time so reads come back newest-pinned first. Kept
// as three category-scoped keys (rather than one tagged set) so each maps
// 1:1 to the section it renders and the per-category cap is a plain ZCARD.
//
// Keyed by the profile's CANONICAL address (the API resolves it before
// writing) so an FC user's pins live alongside the same identity their
// mints/collected already resolve to.
export type PinCategory = 'mints' | 'collected' | 'listings'

const CATEGORIES: readonly PinCategory[] = ['mints', 'collected', 'listings']

// One curated row of the profile's grid per section — a showcase is a tight
// highlight reel, not a second feed. Small by design (and in line with how
// other products cap pins: IG 3, GitHub 6); the cap also bounds the read.
export const MAX_PINS_PER_CATEGORY = 4

export function isPinCategory(value: unknown): value is PinCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

const key = (category: PinCategory, address: string) =>
  `kismetart:pins:${category}:${address.toLowerCase()}`

/** Delete every pinned-showcase key for an address: the three category ZSETs
 *  plus the public-view mode. Admin profile-erase only. */
export async function clearAllPins(address: string): Promise<void> {
  await Promise.all([
    ...CATEGORIES.map((c) => redis.del(key(c, address))),
    redis.del(viewKey(address)),
  ])
}

const member = (collection: string, tokenId: string) =>
  `${collection.toLowerCase()}:${tokenId}`

/**
 * Pin a moment into a category. Returns false when the category is already
 * at MAX_PINS_PER_CATEGORY and this would be a NEW member — the caller
 * surfaces that as a 409. Re-pinning an existing member just refreshes its
 * score (idempotent), so it's allowed even at the cap.
 */
export async function addPin(
  category: PinCategory,
  address: string,
  collection: string,
  tokenId: string,
): Promise<boolean> {
  const k = key(category, address)
  const m = member(collection, tokenId)

  const count = await redis.zcard(k)
  if (count >= MAX_PINS_PER_CATEGORY) {
    const existing = await redis.zscore(k, m)
    if (existing === null || existing === undefined) return false
  }

  await redis.zadd(k, { score: Date.now(), member: m })
  return true
}

export async function removePin(
  category: PinCategory,
  address: string,
  collection: string,
  tokenId: string,
): Promise<void> {
  await redis.zrem(key(category, address), member(collection, tokenId))
}

// ── public-view mode ─────────────────────────────────────────────────────────
// What VISITORS see on this profile: the full profile with the pinned items
// surfaced first in each section ('full', the default) or the curated pinned
// showcase ('curated'). Keyed by the canonical address like the pin ZSETs
// above (it configures the same surface, and the admin erase clears them
// together).
//
// An ABSENT key means "never chose", and resolves via derivePublicViewMode:
// pins present → 'curated' (pinners from the showcase-only era built their
// public page by pinning; the default flip must not republish what they left
// out — they switch by hand), no pins → 'full'. Two rules keep that verdict
// from drifting as pins churn:
//   • the read path MATERIALIZES a derived-'curated' verdict (background
//     SET), so a grandfathered profile stays curated even after the owner
//     later unpins everything;
//   • pin writes call ensureViewModeForPinChange FIRST, so a first-ever pin
//     locks 'full' in (post-rollout pinning REORDERS the full profile rather
//     than flipping it to showcase-only) and a legacy profile's next pin
//     action locks 'curated' even if nothing ever read it.
// Only pre-rollout profiles can sit in the ambiguous pins-and-no-key state,
// so the grandfather rule needs no migration script and no cutoff timestamp.
//
// FAILURE POLICY: every unknown resolves to 'curated' — fail-private. A
// transient Redis error must never expose a full profile the owner may not
// have chosen; the degraded curated view (with pins also unavailable → the
// recent-mints fallback) is the pre-feature rendering. Materialization only
// happens on a SUCCESSFUL read of both the mode and the pins.

const viewKey = (address: string) =>
  `kismetart:profile-public-view:${address.toLowerCase()}`

/**
 * Resolve the mode a viewer should get. Takes the IN-FLIGHT pins read
 * (never-rejecting; `null` = that read failed) rather than its value so this
 * function's own GET issues in the same tick — auto-pipelining folds all
 * four commands into the one round trip the route always cost. Stored choice
 * wins; otherwise derive from the pins — and persist a derived 'curated' so
 * the grandfathered state survives future unpinning. Derived 'full' is NOT
 * persisted here: the pinless long tail would turn every profile view into a
 * write, and ensureViewModeForPinChange pins the verdict down at the only
 * moment it could change (a pin write).
 */
export async function resolvePublicViewMode(
  address: string,
  pinsRead: Promise<Record<PinCategory, string[]> | null>,
): Promise<PublicViewMode> {
  let stored: unknown
  try {
    stored = await redis.get<string>(viewKey(address))
  } catch {
    return 'curated'
  }
  if (stored === 'full' || stored === 'curated') return stored
  const pins = await pinsRead
  if (pins === null) return 'curated'
  const mode = derivePublicViewMode(
    pins.mints.length + pins.collected.length + pins.listings.length > 0,
  )
  if (mode === 'curated') {
    redis.set(viewKey(address), 'curated').catch(bestEffort('showcase.materializeViewMode'))
  }
  return mode
}

/**
 * Pin-write prelude: if the profile has no stored mode, persist the one its
 * CURRENT pins derive to, before the pin mutation changes that basis. First
 * pin ever → 'full' (so pinning under the new default means "float these
 * first", not "hide the rest"); existing pins (a legacy profile acting before
 * any read materialized it) → 'curated'. Best-effort: on any failure the
 * profile just stays unset and the read path resolves it later.
 */
export async function ensureViewModeForPinChange(address: string): Promise<void> {
  try {
    // Nested Promise.all keeps the tuple types exact; all four commands still
    // issue in the same tick, so auto-pipelining folds them into one trip.
    const [stored, counts] = await Promise.all([
      redis.get<string>(viewKey(address)),
      Promise.all(CATEGORIES.map((c) => redis.zcard(key(c, address)))),
    ])
    if (stored === 'full' || stored === 'curated') return
    await redis.set(viewKey(address), derivePublicViewMode(counts.some((n) => n > 0)))
  } catch (err) {
    bestEffort('showcase.ensureViewMode')(err)
  }
}

/** Owner's explicit choice — both values persist (absence means "derive"). */
export async function setPublicViewMode(address: string, mode: PublicViewMode): Promise<void> {
  await redis.set(viewKey(address), mode)
}

/**
 * All three pin sets for a profile, each newest-pinned first. Returns null on
 * any error ("checked" contract, like the FC lookups): the route serves empty
 * arrays either way, but resolvePublicViewMode must be able to tell truly-
 * pinless (may derive 'full') from pins-unknown (must fail private to
 * 'curated', and must NOT materialize a verdict off a failed read).
 */
export async function getAllPinsChecked(
  address: string,
): Promise<Record<PinCategory, string[]> | null> {
  try {
    const [mints, collected, listings] = await Promise.all([
      redis.zrange(key('mints', address), 0, -1, { rev: true }) as Promise<string[]>,
      redis.zrange(key('collected', address), 0, -1, { rev: true }) as Promise<string[]>,
      redis.zrange(key('listings', address), 0, -1, { rev: true }) as Promise<string[]>,
    ])
    return { mints, collected, listings }
  } catch {
    return null
  }
}
