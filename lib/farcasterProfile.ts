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
  // X/Twitter handle the FID has PROVEN it owns via a Farcaster connected
  // account — the only social Farcaster verifies today. Surfaced as a verified
  // link on the Kismet profile (outranks a manually-claimed `x` handle).
  // Optional: entries cached before this field existed simply omit it (they
  // refresh within PROFILE_TTL); read it as `?? null`.
  verifiedTwitter?: string | null
}

const PROFILE_TTL = 60 * 60          // 1h on hit — pfp/name change rarely
const PROFILE_FAIL_TTL = 5 * 60      // 5m on miss — let new FC accounts appear quickly
const FID_BY_ADDRESS_TTL = 60 * 60
const FID_BY_ADDRESS_FAIL_TTL = 5 * 60
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
            // Verified off-platform accounts on the Warpcast/Farcaster user
            // object. `platform` is a lowercase enum ("x" for Twitter/X),
            // `username` the handle, `expired` set once a link is revoked.
            // Best-effort: if the field is absent we just don't inherit an X link.
            connectedAccounts?: { platform?: string; username?: string; expired?: boolean }[]
          }
        }
      }
      const user = body.result?.user
      if (user?.fid) {
        const x = (user.connectedAccounts ?? []).find(
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
          verifiedTwitter: x?.username ? x.username.trim().replace(/^@+/, '') : null,
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
 * Verifications lookup with an honest three-way answer, mirroring
 * getFidByAddress:
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
 * identity question, with an honest three-way answer:
 *
 *   { fid: number }  — FC-verified address
 *   { fid: null }    — definitively NOT an FC address (404 / empty result)
 *   null             — UNKNOWN right now (network throw, 429/5xx, or the
 *                      short transient negative cache)
 *
 * Callers that mutate identity-keyed state (earnings visibility) MUST treat
 * null as "fail closed / retry", never as "non-FC" — conflating the two
 * writes to the wrong member form. Read-only callers may treat null like
 * { fid: null } (degrade gracefully).
 */
export type FidLookup = { fid: number | null } | null

export async function getFidByAddress(
  address: string,
  opts: { skipCache?: boolean } = {},
): Promise<FidLookup> {
  const lower = address.toLowerCase()
  const cacheKey = fidByAddressKey(lower)
  const cached = opts.skipCache ? undefined : await readCached<string>(cacheKey)
  if (cached !== undefined) {
    if (cached === NO_FID_SENTINEL) return { fid: null }
    if (cached === TRANSIENT_SENTINEL) return null
    const parsed = Number(cached)
    return Number.isFinite(parsed) ? { fid: parsed } : null
  }

  let fid: number | null = null
  let transient = false
  try {
    // 8s bound (main's downtime hardening, carried into this moved fetch): a
    // hung upstream must not pin the caller; the timeout fires as a throw →
    // the catch below returns null (unknown, uncached) — the honest answer.
    const res = await fetch(
      `https://api.farcaster.xyz/v2/user-by-verification?address=${lower}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    )
    if (res.ok) {
      const body = (await res.json()) as {
        result?: { user?: { fid?: number } }
      }
      fid = body.result?.user?.fid ?? null
    } else if (res.status !== 404) {
      // 429/5xx: caching the definitive no-FID sentinel for the full fail TTL
      // would strip the user's FC identity — and the earnings sibling union —
      // for minutes; caching nothing turns a sustained rate-limit into an
      // unthrottled storm. The distinct transient sentinel with a short TTL
      // bounds both costs while staying distinguishable from a real no-FID.
      transient = true
    }
  } catch {
    // Network blip — unknown, uncached.
    return null
  }
  await redis
    .set(cacheKey, fid ? String(fid) : transient ? TRANSIENT_SENTINEL : NO_FID_SENTINEL, {
      ex: fid
        ? FID_BY_ADDRESS_TTL
        : transient
          ? TRANSIENT_FAIL_TTL
          : FID_BY_ADDRESS_FAIL_TTL,
    })
    .catch(() => {})
  return transient ? null : { fid }
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
