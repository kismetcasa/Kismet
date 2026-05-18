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
}

const PROFILE_TTL = 60 * 60          // 1h on hit — pfp/name change rarely
const PROFILE_FAIL_TTL = 5 * 60      // 5m on miss — let new FC accounts appear quickly
const FID_BY_ADDRESS_TTL = 60 * 60
const FID_BY_ADDRESS_FAIL_TTL = 5 * 60

const profileKey = (fid: number) => `kismetart:fc:profile:${fid}`
// Sentinel value stored in the address→fid cache when an address has no
// FC user attached. An empty string can't be a valid FID so it's
// unambiguous. Avoids re-hitting the API for every anonymous address.
const NO_FID_SENTINEL = ''
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
export async function getFarcasterProfileByFid(
  fid: number,
): Promise<FarcasterProfile | null> {
  const cacheKey = profileKey(fid)
  const cached = await readCached<FarcasterProfile | ''>(cacheKey)
  if (cached !== undefined) return cached === '' ? null : cached

  let profile: FarcasterProfile | null = null
  try {
    // The Farcaster Hub HTTP API exposes user data through user-by-fid.
    // Response shape (best-effort — we tolerate any shape via optional chains):
    //   { result: { user: { fid, username, displayName, pfp: { url } } } }
    const res = await fetch(
      `https://api.farcaster.xyz/v2/user?fid=${fid}`,
      { headers: { Accept: 'application/json' } },
    )
    if (res.ok) {
      const body = (await res.json()) as {
        result?: {
          user?: {
            fid?: number
            username?: string
            displayName?: string
            pfp?: { url?: string }
          }
        }
      }
      const user = body.result?.user
      if (user?.fid) {
        profile = {
          fid: user.fid,
          username: user.username ?? null,
          displayName: user.displayName ?? null,
          pfpUrl: user.pfp?.url ?? null,
        }
      }
    }
  } catch {
    // Network blip — don't poison the cache.
    return null
  }

  await redis
    .set(cacheKey, profile ?? '', {
      ex: profile ? PROFILE_TTL : PROFILE_FAIL_TTL,
    })
    .catch(() => {})
  return profile
}

/**
 * Resolve an Ethereum address to a Farcaster profile via the address's
 * verified-FID record. Used to auto-propagate FC identity onto any
 * Kismet address that happens to belong to an FC user — works for any
 * visitor's profile page, not just the currently-signed-in user.
 *
 * Returns null when no FC account has verified this address.
 */
export async function getFarcasterProfileByAddress(
  address: string,
): Promise<FarcasterProfile | null> {
  const lower = address.toLowerCase()
  const cacheKey = fidByAddressKey(lower)
  const cached = await readCached<string>(cacheKey)

  let fid: number | null = null
  if (cached !== undefined) {
    if (cached === NO_FID_SENTINEL) return null
    const parsed = Number(cached)
    if (Number.isFinite(parsed)) fid = parsed
  } else {
    try {
      const res = await fetch(
        `https://api.farcaster.xyz/v2/user-by-verification?address=${lower}`,
        { headers: { Accept: 'application/json' } },
      )
      if (res.ok) {
        const body = (await res.json()) as {
          result?: { user?: { fid?: number } }
        }
        fid = body.result?.user?.fid ?? null
      }
    } catch {
      return null
    }
    await redis
      .set(cacheKey, fid ? String(fid) : NO_FID_SENTINEL, {
        ex: fid ? FID_BY_ADDRESS_TTL : FID_BY_ADDRESS_FAIL_TTL,
      })
      .catch(() => {})
  }

  return fid ? getFarcasterProfileByFid(fid) : null
}
