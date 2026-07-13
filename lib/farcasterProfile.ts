import { redis } from './redis'

// Resolves a Farcaster FID's public profile (username, display name, pfp).
// Two cache lookups support both lookup directions:
//
//   FID     → profile   (keyed by fid)
//   address → profile   (keyed by address, points at the FID's profile)
//
// Used by:
//   - /api/me to enrich the auth response with avatar/name on first paint
//   - /api/profile/[address] to merge FC identity into any address-keyed
//     profile, so Kismet renders @username + pfp even for users who've
//     never set a Kismet profile
//
// All Farcaster API calls go through api.farcaster.xyz directly (no
// third-party indexer). Public, no auth required, no API key needed.

export type FarcasterProfile = {
  fid: number
  username: string | null
  displayName: string | null
  pfpUrl: string | null
  // X/Twitter handle from the legacy `connectedAccounts` OAuth surface on the
  // /v2/user response (parsed for free — we already fetch that response). Used
  // as a FALLBACK to the documented /fc/account-verifications endpoint
  // (getVerifiedTwitterByFid): same underlying X OAuth, but the two surfaces can
  // drift, so merging catches links the beta verifications endpoint misses.
  connectedTwitter?: string | null
}

const PROFILE_TTL = 60 * 60          // 1h on hit — pfp/name change rarely
const PROFILE_FAIL_TTL = 5 * 60      // 5m on miss — let new FC accounts appear quickly
// address→FID reverse index (see getFidByAddress). Long TTL: the mapping
// changes only when a user unverifies a wallet (rare), and a durable entry
// keeps a wallet resolvable between its owner's visits AND keeps identity-
// keyed writes (earnings) on a stable keying. Refreshed on every verifications
// fetch, so an active user's mapping never actually ages out.
const FID_INDEX_TTL = 30 * 24 * 60 * 60 // 30d
// Non-OK non-404 upstream answers (429/5xx) are TRANSIENT, not definitive
// absence. Caching them as absence for the full fail TTL wrongly stripped FC
// identity — and the earnings sibling union — for 5 minutes; caching nothing
// at all turns a sustained FC rate-limit into an unthrottled request storm
// (every profile view re-fires the fetch, perpetuating the 429). A short
// negative cache throttles upstream traffic to one attempt per address per
// window while keeping the blast radius of a blip to seconds, not minutes.
const TRANSIENT_FAIL_TTL = 30

const profileKey = (fid: number) => `kismetart:fc:profile:${fid}`
const verificationsKey = (fid: number) => `kismetart:fc:verifications:${fid}`
const VERIFICATIONS_TTL = 60 * 60          // 1h on hit
const VERIFICATIONS_FAIL_TTL = 5 * 60      // 5m on miss
const verifiedXKey = (fid: number) => `kismetart:fc:verified-x:${fid}`
const VERIFIED_X_TTL = 60 * 60             // 1h on hit — X verification is rare-write
const VERIFIED_X_FAIL_TTL = 5 * 60         // 5m on miss / beta-endpoint error (throttles retry)
// Sentinel value stored in the address→fid cache when an address has no
// FC user attached. An empty string can't be a valid FID so it's
// unambiguous. Avoids re-hitting the API for every anonymous address.
const NO_FID_SENTINEL = ''
// Distinct sentinel for a TRANSIENT lookup failure (429/5xx), cached only for
// TRANSIENT_FAIL_TTL — used by BOTH the fid-by-address and verifications
// caches. Kept separate from the definitive negative sentinels so identity-
// sensitive WRITES (earnings visibility) can tell "definitively not an FC
// user / genuinely zero verifications" from "couldn't find out right now"
// and fail closed on the latter — treating a blip as a definitive negative
// once wrote an FC user's unpin to the wrong member form, leaving their
// earnings publicly pinned. Lenient READS treat all sentinels as "nothing".
const TRANSIENT_SENTINEL = '!transient'
const fidByAddressKey = (address: string) =>
  `kismetart:fc:fid-by-addr:${address.toLowerCase()}`

async function readCached<T>(key: string): Promise<T | undefined> {
  try {
    const v = await redis.get<T>(key)
    return v === null || v === undefined ? undefined : v
  } catch {
    return undefined
  }
}

/** Fetch + cache a Farcaster user by FID. Returns null if FID doesn't exist. */
async function getFarcasterProfileByFid(
  fid: number,
  opts: { skipCache?: boolean } = {},
): Promise<FarcasterProfile | null> {
  const cacheKey = profileKey(fid)
  if (!opts.skipCache) {
    const cached = await readCached<FarcasterProfile | ''>(cacheKey)
    if (cached !== undefined) return cached === '' ? null : cached
  }

  let profile: FarcasterProfile | null = null
  let transient = false
  try {
    // The Farcaster Hub HTTP API exposes user data through user-by-fid.
    // Response shape (best-effort — we tolerate any shape via optional chains):
    //   { result: { user: { fid, username, displayName, pfp: { url } } } }
    const res = await fetch(
      `https://api.farcaster.xyz/v2/user?fid=${fid}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    )
    if (res.ok) {
      const body = (await res.json()) as {
        result?: {
          user?: {
            fid?: number
            username?: string
            displayName?: string
            pfp?: { url?: string }
            // Legacy OAuth "connected accounts" surface (undocumented but
            // public). Same X OAuth as /fc/account-verifications, exposed here
            // too; parsed as a fallback. `expired` = the OAuth token is stale/
            // revoked, so skip those (the handle may be outdated).
            connectedAccounts?: { platform?: string; username?: string; expired?: boolean }[]
          }
        }
      }
      const user = body.result?.user
      if (user?.fid) {
        const connX = (user.connectedAccounts ?? []).find(
          (a) =>
            (a?.platform ?? '').toLowerCase() === 'x' &&
            a?.expired !== true &&
            typeof a?.username === 'string' &&
            a.username.trim().length > 0,
        )
        profile = {
          fid: user.fid,
          username: user.username ?? null,
          displayName: user.displayName ?? null,
          pfpUrl: user.pfp?.url ?? null,
          connectedTwitter: connX?.username ? connX.username.trim().replace(/^@+/, '') : null,
        }
      }
    } else if (res.status !== 404) {
      // 429/5xx: cache the miss only for TRANSIENT_FAIL_TTL — long enough to
      // throttle a retry storm, short enough that a real user's identity
      // (and earnings sibling union) isn't stripped for minutes.
      transient = true
    }
  } catch {
    // Network blip — don't poison the cache.
    return null
  }

  await redis
    .set(cacheKey, profile ?? '', {
      ex: profile ? PROFILE_TTL : transient ? TRANSIENT_FAIL_TTL : PROFILE_FAIL_TTL,
    })
    .catch(() => {})
  return profile
}

/**
 * A user's PROVEN X/Twitter handle, from Farcaster's documented
 * account-verifications endpoint — the only officially-supported source for
 * off-platform verifications (the `connectedAccounts` field on the legacy
 * `/v2/user` surface is undocumented). Returns null when the FID has no
 * verified X, or on any lookup/parse failure, so callers degrade to the
 * user's manually-claimed handle.
 *
 * The endpoint is officially flagged beta ("likely to have breaking changes
 * or get deprecated"), so this fails closed to null on any non-OK response or
 * unexpected shape, and there is no `expired` filter — listed entries are the
 * current attested verifications. Cached 1h on hit / 5m on miss to throttle
 * retries against a beta endpoint; the badge is cosmetic so brief staleness is
 * benign. Empty-string sentinel distinguishes "known: none" from a cache miss.
 */
export async function getVerifiedTwitterByFid(
  fid: number,
  opts: { skipCache?: boolean } = {},
): Promise<string | null> {
  const cacheKey = verifiedXKey(fid)
  if (!opts.skipCache) {
    const cached = await readCached<string>(cacheKey)
    if (cached !== undefined) return cached === '' ? null : cached
  }

  let handle: string | null = null
  try {
    const res = await fetch(
      `https://api.farcaster.xyz/fc/account-verifications?fid=${fid}&platform=x`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    )
    if (res.ok) {
      // Tolerate envelope drift: verifications may sit under `result` (per the
      // docs example) or at the top level; the handle may be `platformUsername`
      // (documented) or `username` (the legacy connected-accounts field name).
      // Can't hit the live beta endpoint from CI, so accept both shapes.
      type VItem = { platform?: string; platformUsername?: string; username?: string }
      const body = (await res.json()) as {
        result?: { verifications?: VItem[] }
        verifications?: VItem[]
      }
      const list = body.result?.verifications ?? body.verifications ?? []
      const x = list.find(
        (v) =>
          (v?.platform ?? '').toLowerCase() === 'x' &&
          (v?.platformUsername ?? v?.username ?? '').trim().length > 0,
      )
      const raw = x?.platformUsername ?? x?.username
      handle = raw ? raw.trim().replace(/^@+/, '') : null
    }
    // Non-OK (incl. a beta-endpoint 4xx/5xx): leave handle null; the short
    // FAIL TTL below throttles retries without hiding the badge for long.
  } catch {
    // Network blip / timeout — unknown; don't poison the cache.
    return null
  }

  await redis
    .set(cacheKey, handle ?? '', { ex: handle ? VERIFIED_X_TTL : VERIFIED_X_FAIL_TTL })
    .catch(() => {})
  return handle
}

/**
 * Verifications lookup with an honest three-way answer (getFidByAddress is now
 * index-only and two-way — see its note; this one still distinguishes transient
 * failure because it does a live fetch):
 *
 *   { addresses: [...] } — fetched/cached successfully (POSSIBLY EMPTY: an
 *                          FID genuinely holds zero verifications after a
 *                          user unverifies their wallets)
 *   null                 — UNKNOWN right now (network throw, 429/5xx, or the
 *                          short transient negative cache)
 *
 * Identity-sensitive writes (earnings visibility) branch on the difference —
 * conflating "definitively empty" with "couldn't find out" either bricked
 * toggles for genuinely-unverified users or let an unpin sweep partially.
 * Lenient readers use getVerifiedAddressesByFid below.
 */
export async function getVerifiedAddressesByFidChecked(
  fid: number,
  opts: { skipCache?: boolean } = {},
): Promise<{ addresses: string[] } | null> {
  const cacheKey = verificationsKey(fid)
  if (!opts.skipCache) {
    const cached = await readCached<string[] | string>(cacheKey)
    if (cached !== undefined) {
      if (cached === TRANSIENT_SENTINEL) return null
      if (cached === '') return { addresses: [] }
      if (Array.isArray(cached)) return { addresses: cached }
      return null // unrecognized cache shape — treat as unknown
    }
  }

  let addresses: string[] = []
  let transient = false
  try {
    // Public Farcaster API; no key required. Response shape (defensive
    // against minor variations across the v1 → v2 transition):
    //   { result: { verifications: [{ fid, address, timestamp, version }] } }
    const res = await fetch(
      `https://api.farcaster.xyz/v2/verifications?fid=${fid}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    )
    if (res.ok) {
      const body = (await res.json()) as {
        result?: { verifications?: { address?: string }[] }
      }
      addresses = (body.result?.verifications ?? [])
        .map((v) => v.address)
        .filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))
        .map((a) => a.toLowerCase())
    } else if (res.status !== 404) {
      // 429/5xx: an empty answer cached for the full fail TTL would collapse
      // the sibling union to [self] — a multi-wallet artist's mints and
      // earnings visibly under-report for those minutes. Cache the distinct
      // transient sentinel for TRANSIENT_FAIL_TTL to throttle a retry storm
      // without that cost, and without masquerading as a definitive empty.
      transient = true
    }
  } catch {
    // Network failure — unknown, uncached.
    return null
  }

  // Use sentinel '' for "no verifications" so cache differentiates from
  // a genuine miss (undefined → re-fetch). Otherwise a user with zero
  // verifications would hit the network on every request.
  await redis
    .set(cacheKey, addresses.length ? addresses : transient ? TRANSIENT_SENTINEL : '', {
      ex: addresses.length
        ? VERIFICATIONS_TTL
        : transient
          ? TRANSIENT_FAIL_TTL
          : VERIFICATIONS_FAIL_TTL,
    })
    .catch(() => {})
  // Back-populate the address→FID reverse index that getFidByAddress reads.
  // Farcaster gated the old address→FID endpoint (/v2/user-by-verification now
  // requires app-key auth), so we build the index ourselves: every time the app
  // resolves a FID's verifications — which happens on every FC login (via
  // getKismetIdentityAddress) and profile/earnings/sibling read — we learn
  // "these wallets belong to this FID" and seed each one. Keyless: uses only
  // this public fid-keyed endpoint. Best-effort.
  if (addresses.length) {
    await Promise.all(
      addresses.map((a) =>
        redis.set(fidByAddressKey(a), String(fid), { ex: FID_INDEX_TTL }).catch(() => {}),
      ),
    )
  }
  return transient ? null : { addresses }
}

/**
 * Return every Ethereum address verified to a given FID — the FC user's
 * full wallet set. Used by lib/addressUnion to unify activity across all
 * of a user's wallets so e.g. a mint signed from one verified address
 * appears on the profile page of any other verified address.
 *
 * Returns an empty array on lookup failure or for FIDs with no
 * verifications (the lenient projection of the checked variant above).
 * Cached in Redis with a 1h TTL — verifications are rare-write (user has
 * to sign a verifyAddress claim on-chain for each one) so staleness within
 * an hour is benign.
 */
export async function getVerifiedAddressesByFid(
  fid: number,
  opts: { skipCache?: boolean } = {},
): Promise<string[]> {
  return (await getVerifiedAddressesByFidChecked(fid, opts))?.addresses ?? []
}

/**
 * Resolve an address to its FID WITHOUT hydrating the profile — the leanest
 * identity question:
 *
 *   { fid: number }  — a wallet we've linked to a FID (in the reverse index)
 *   { fid: null }    — not a wallet we know a FID for
 *
 * Farcaster gated the live address→FID endpoint (`/v2/user-by-verification`
 * now requires app-key auth), so this reads a SELF-BUILT reverse index instead:
 * getVerifiedAddressesByFidChecked seeds `address → fid` for every wallet it
 * sees whenever the app resolves any FID's verifications (FC logins, profile /
 * earnings / sibling reads). Coverage is therefore "FC users who've been active
 * on Kismet" — the common case — with a cold-start gap for accounts we've never
 * resolved a FID for (they read as { fid: null } until first seeded).
 *
 * Because a miss can no longer be a transient network failure, this never
 * returns the old bare-`null` "unknown" state — the reverse index read is a
 * cheap local Redis lookup. Identity-sensitive writes (earnings) that treated
 * `null` as fail-closed simply never hit that branch here now; a genuinely
 * non-FC wallet resolves to { fid: null } and pins address-keyed as before. The
 * long FID_INDEX_TTL (refreshed on every verifications fetch) keeps an active
 * FC user's mapping stable so pin/unpin can't straddle two keyings.
 *
 * `skipCache` is retained for signature compatibility but is now a no-op: the
 * reverse index IS the source of truth, so there is nothing upstream to bypass.
 */
export type FidLookup = { fid: number | null } | null

export async function getFidByAddress(
  address: string,
  _opts: { skipCache?: boolean } = {},
): Promise<FidLookup> {
  const lower = address.toLowerCase()
  const cached = await readCached<string>(fidByAddressKey(lower))
  if (cached !== undefined && cached !== NO_FID_SENTINEL && cached !== TRANSIENT_SENTINEL) {
    const parsed = Number(cached)
    if (Number.isFinite(parsed) && parsed > 0) return { fid: parsed }
  }
  return { fid: null }
}

/**
 * Resolve an Ethereum address to a Farcaster profile via the address's
 * verified-FID record. Used to auto-propagate FC identity onto any
 * Kismet address that happens to belong to an FC user — works for any
 * visitor's profile page, not just the currently-signed-in user.
 *
 * Returns null when no FC account has verified this address (or the
 * lookup/hydration is transiently unavailable — read-only callers degrade;
 * identity-sensitive writes should use getFidByAddress directly).
 */
export async function getFarcasterProfileByAddress(
  address: string,
  opts: { skipCache?: boolean } = {},
): Promise<FarcasterProfile | null> {
  const fid = (await getFidByAddress(address, opts))?.fid ?? null
  return fid ? getFarcasterProfileByFid(fid, opts) : null
}
