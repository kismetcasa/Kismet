import { redis, zpairsToMap } from './redis'
import { bestEffort } from './bestEffort'
import { getFidByAddress } from './farcasterProfile'
import {
  derivePublicViewMode,
  MAX_PINS_PER_CATEGORY,
  type PublicViewMode,
} from './showcaseOrder'

// Per-owner "pinned showcase" ZSETs — one per profile section a user can
// curate. Mirrors lib/collected.ts: members are "<collection>:<tokenId>"
// tuples, score is pin time so reads come back newest-pinned first. Kept
// as three category-scoped keys (rather than one tagged set) so each maps
// 1:1 to the section it renders and the per-category cap is a plain read.
export type PinCategory = 'mints' | 'collected' | 'listings'

const CATEGORIES: readonly PinCategory[] = ['mints', 'collected', 'listings']

// Per-category cap — defined in lib/showcaseOrder (client-safe home, with
// the sizing rationale); re-exported here so server callers keep one import.
export { MAX_PINS_PER_CATEGORY } from './showcaseOrder'

export function isPinCategory(value: unknown): value is PinCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

// ── identity scope ───────────────────────────────────────────────────────────
// KEYED BY IDENTITY, NOT BY TODAY'S ADDRESS. A pin set used to be keyed by the
// profile's CANONICAL address, and that address is not stable: it is
// FidProfile.currentAddress for an FC user, which moves on an identity switch
// (/api/me/identity), on the profile PUT's upsertFidProfile path, and on
// web-first anchor drift. Every such move silently re-pointed the whole
// feature at a fresh, empty key — the owner's pins vanished from their profile
// and, worse, an UNPIN wrote its ZREM to the new key while the read served the
// old one, so the removal no-op'd and the pin came back on the next load.
//
// lib/earningsVisibility.ts had already diagnosed exactly this for the
// "earnings public" pin and fixed it by keying on `fid:<n>`; /api/me/identity
// even documents the invariant ("the pin follows the identity across every
// canonical-address change"). This module is that fix applied to the showcase.
//
// Two forms, and BOTH are always read:
//   • `fid:<n>`  — the home for an FC user, stable across every address change.
//   • `<address>` — the home for a non-FC user (their address IS their
//     identity), and the LEGACY home of every pin written before this change.
//
// A ZSET can be merged member-by-member on score, which a SET cannot, so this
// needs none of earningsVisibility's lazy-migration bookkeeping: the UNION of
// both forms is the answer, writes home to the identity form, and an unpin
// sweeps both. That makes the result independent of which form wrote a pin and
// of what order things happened in — including the one hazard left in the
// identity lookup, where a Redis blip makes getFidByAddress read `{ fid: null }`
// (it is index-only and two-way — see its note) and a write lands on the
// address form. Under a union read plus a sweeping unpin that costs nothing:
// neither form can shadow the other, and no pin becomes unreachable. There is
// therefore no fail-closed throw here and no migration to run.
//
// The union DELIBERATELY stops at the queried address and does not expand to
// the FID's other verified wallets. A set written under a canonical that has
// since drifted away is left inert — invisible to the owner and to visitors,
// and counting toward no cap — rather than resurfaced. Reading siblings would
// cost a second dependent lookup on a hot public path to republish pins the
// owner has not seen since the drift, onto their public profile, unasked; inert
// is both cheaper and the safer default. Admin erase still reaches those keys
// because /api/admin/erase-profile already loops clearAllPins over the FID's
// whole wallet set.
const fidScope = (fid: number) => `fid:${fid}`

/**
 * The key forms this profile's pins may live under, identity home FIRST:
 * `[fid:<n>, address]` for an FC user, `[address]` for everyone else (their
 * address IS their identity, so their keys are byte-identical to the
 * pre-change ones). The address form doubles as the LEGACY home of every pin
 * written before identity keying shipped.
 *
 * Resolved ONCE per request and threaded through, so a route pays one
 * index-only lookup rather than one per showcase call it makes.
 */
export async function resolveShowcaseScopes(address: string): Promise<string[]> {
  const lower = address.toLowerCase()
  const fid = (await getFidByAddress(lower))?.fid ?? null
  return fid == null ? [lower] : [fidScope(fid), lower]
}

/**
 * Every exported call below takes an optional pre-resolved `scopes` — the same
 * dedupe contract lib/earningsVisibility's `fid`/`siblings` hints use: a caller
 * that already resolved the identity for this request passes it so the second
 * and third call don't re-pay the lookup. Omitted, each resolves its own.
 */
const scopesFor = (address: string, scopes?: string[]): Promise<string[]> =>
  scopes ? Promise.resolve(scopes) : resolveShowcaseScopes(address)

const key = (category: PinCategory, scope: string) => `kismetart:pins:${category}:${scope}`

const member = (collection: string, tokenId: string) =>
  `${collection.toLowerCase()}:${tokenId}`

/**
 * Merged newest-pinned-first refs for one category across every scope.
 * Duplicates (the same ref pinned under two forms) collapse to their most
 * recent score, and the result is capped, so every consumer can rely on the
 * cap the way orderByPins and the showcase skeleton already assume. A set that
 * is somehow over-cap (a racing double-pin; a future cap reduction) therefore
 * serves its newest MAX_PINS_PER_CATEGORY and holds the older refs back rather
 * than over-filling a section — and holds them back only until a slot frees,
 * since the next unpin brings the next one into range. Nothing is stranded.
 */
function mergePins(reads: (string | number)[][]): string[] {
  const newest = new Map<string, number>()
  for (const raw of reads) {
    for (const [ref, score] of zpairsToMap(raw)) {
      const seen = newest.get(ref)
      if (seen === undefined || score > seen) newest.set(ref, score)
    }
  }
  return [...newest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PINS_PER_CATEGORY)
    .map(([ref]) => ref)
}

/** One category's refs across `scopes`, newest-pinned first. */
async function readCategory(category: PinCategory, scopes: string[]): Promise<string[]> {
  return mergePins(
    await Promise.all(
      scopes.map(
        (s) =>
          redis.zrange(key(category, s), 0, -1, { rev: true, withScores: true }) as Promise<
            (string | number)[]
          >,
      ),
    ),
  )
}

/** Delete every pinned-showcase key for an identity: the three category ZSETs
 *  and the public-view mode, under every scope. Admin profile-erase only. */
export async function clearAllPins(address: string, scopes?: string[]): Promise<void> {
  const resolved = await scopesFor(address, scopes)
  await Promise.all(
    resolved.flatMap((s) => [...CATEGORIES.map((c) => redis.del(key(c, s))), redis.del(viewKey(s))]),
  )
}

/**
 * Pin a moment into a category. Returns false when the category is already
 * at MAX_PINS_PER_CATEGORY and this would be a NEW member — the caller
 * surfaces that as a 409. Re-pinning an existing member just refreshes its
 * score (idempotent), so it's allowed even at the cap.
 *
 * The cap is checked against the MERGED set (the same thing the profile reads),
 * not one key's ZCARD: with two key forms in play a per-key count could admit
 * a seventh pin, and the owner would then see a section it is impossible to
 * get back under the cap. Writing to the identity home and dropping the member
 * from the legacy forms also gives every ref exactly one home, so the merge
 * has nothing to collapse after an owner's first pin action.
 */
export async function addPin(
  category: PinCategory,
  address: string,
  collection: string,
  tokenId: string,
  scopes?: string[],
): Promise<boolean> {
  const resolved = await scopesFor(address, scopes)
  const m = member(collection, tokenId)

  const current = await readCategory(category, resolved)
  if (current.length >= MAX_PINS_PER_CATEGORY && !current.includes(m)) return false

  const [home, ...legacy] = resolved
  await Promise.all([
    redis.zadd(key(category, home), { score: Date.now(), member: m }),
    ...legacy.map((s) => redis.zrem(key(category, s), m)),
  ])
  return true
}

/**
 * Unpin. Sweeps EVERY scope, so the removal is complete whichever form holds
 * the ref — this is the fix for the silently-no-op'd unpin described above.
 * Returns whether anything was actually removed: the route reports it, so a
 * miss is observable instead of being answered as a success. False is not an
 * error (re-sending a DELETE for an already-unpinned ref is idempotent); it
 * means the ref was pinned under no form this identity can reach.
 */
export async function removePin(
  category: PinCategory,
  address: string,
  collection: string,
  tokenId: string,
  scopes?: string[],
): Promise<boolean> {
  const resolved = await scopesFor(address, scopes)
  const m = member(collection, tokenId)
  const removed = await Promise.all(resolved.map((s) => redis.zrem(key(category, s), m)))
  return removed.some((n) => Number(n) > 0)
}

// ── public-view mode ─────────────────────────────────────────────────────────
// What VISITORS see on this profile: the full profile with the pinned items
// surfaced first in each section ('full', the default) or the curated pinned
// showcase ('curated'). Scoped exactly like the pin ZSETs above — it is the
// same identity's setting, it is cleared with them, and address keying would
// drift it the same way (an identity switch silently re-deriving a
// deliberately-curated profile back to 'full').
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

const viewKey = (scope: string) => `kismetart:profile-public-view:${scope}`

/** The stored choice under any scope, identity home winning. Absent = "never
 *  chose"; a legacy address-scoped choice still counts, so this change can't
 *  re-open a decision an owner already made. */
async function readViewMode(scopes: string[]): Promise<PublicViewMode | null> {
  const stored = await Promise.all(scopes.map((s) => redis.get<string>(viewKey(s))))
  for (const v of stored) {
    if (v === 'full' || v === 'curated') return v
  }
  return null
}

/**
 * Resolve the mode a viewer should get. Takes the IN-FLIGHT pins read
 * (never-rejecting; `null` = that read failed) rather than its value so this
 * function's own GETs issue in the same tick — auto-pipelining keeps the
 * route at the one round trip it always cost. Stored choice wins; otherwise
 * derive from the pins — and persist a derived 'curated' so the grandfathered
 * state survives future unpinning. Derived 'full' is NOT persisted here: the
 * pinless long tail would turn every profile view into a write, and
 * ensureViewModeForPinChange pins the verdict down at the only moment it could
 * change (a pin write).
 */
export async function resolvePublicViewMode(
  address: string,
  pinsRead: Promise<Record<PinCategory, string[]> | null>,
  scopes?: string[],
): Promise<PublicViewMode> {
  let resolved: string[]
  let stored: PublicViewMode | null
  try {
    resolved = await scopesFor(address, scopes)
    stored = await readViewMode(resolved)
  } catch {
    return 'curated'
  }
  if (stored) return stored
  const pins = await pinsRead
  if (pins === null) return 'curated'
  const mode = derivePublicViewMode(
    pins.mints.length + pins.collected.length + pins.listings.length > 0,
  )
  if (mode === 'curated') {
    redis.set(viewKey(resolved[0]), 'curated').catch(bestEffort('showcase.materializeViewMode'))
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
export async function ensureViewModeForPinChange(address: string, scopes?: string[]): Promise<void> {
  try {
    const resolved = await scopesFor(address, scopes)
    // Nested Promise.all keeps the tuple types exact; every command still
    // issues in the same tick, so auto-pipelining folds them into one trip.
    const [stored, counts] = await Promise.all([
      readViewMode(resolved),
      Promise.all(CATEGORIES.map((c) => readCategory(c, resolved))),
    ])
    if (stored) return
    await redis.set(viewKey(resolved[0]), derivePublicViewMode(counts.some((refs) => refs.length > 0)))
  } catch (err) {
    bestEffort('showcase.ensureViewMode')(err)
  }
}

/** Owner's explicit choice — both values persist (absence means "derive").
 *  Written to the identity home; a stale legacy-scoped value can't win because
 *  readViewMode reads the home first. */
export async function setPublicViewMode(
  address: string,
  mode: PublicViewMode,
  scopes?: string[],
): Promise<void> {
  const resolved = await scopesFor(address, scopes)
  await redis.set(viewKey(resolved[0]), mode)
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
  scopes?: string[],
): Promise<Record<PinCategory, string[]> | null> {
  try {
    const resolved = await scopesFor(address, scopes)
    const [mints, collected, listings] = await Promise.all(
      CATEGORIES.map((c) => readCategory(c, resolved)),
    )
    return { mints, collected, listings }
  } catch {
    return null
  }
}
