import { createClient } from '@farcaster/quick-auth'
import { redis } from './redis'

// Quick Auth verifies JWTs **locally** via asymmetric signature check
// against Farcaster's published public key — no per-request network round
// trip. The client is a thin holder for that key plus the issuer/audience
// constraints. One module-level instance is enough.
const client = createClient()

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kismet.art'
// The JWT's `aud` claim is the bare domain (no scheme, no path). Match
// what the user signed against on the client.
const DOMAIN = new URL(SITE_URL).hostname

// FID → primary Ethereum address. Cached because:
//   - The Farcaster API (`api.farcaster.xyz`) is rate-limited
//   - The value changes very rarely (user has to explicitly update)
//   - This runs on EVERY authenticated request from a Mini App user
const PRIMARY_ADDRESS_TTL = 60 * 60          // 1h on hit
const PRIMARY_ADDRESS_FAIL_TTL = 5 * 60      // 5m on miss (lets a newly-set primary appear within minutes)
const primaryAddressKey = (fid: number) => `kismetart:fc:primary:${fid}`

export type FarcasterAuthResult = {
  fid: number
  address: string
}

/**
 * Resolve a Farcaster FID to its primary Ethereum address.
 *
 * Falls back to null when the user has never set a primary verified
 * address. Callers that need an address-always guarantee should handle
 * that null at the call site (e.g. by treating the user as unauthenticated
 * even though the JWT was valid).
 *
 * Spec: https://miniapps.farcaster.xyz/docs/sdk/quick-auth/use-jwt-server
 */
export async function getPrimaryAddress(fid: number): Promise<string | null> {
  const cacheKey = primaryAddressKey(fid)
  try {
    const cached = await redis.get<string>(cacheKey)
    if (cached !== null && cached !== undefined) {
      return cached === '' ? null : cached
    }
  } catch {
    // Redis down — fall through to live fetch.
  }

  try {
    const res = await fetch(
      `https://api.farcaster.xyz/fc/primary-address?fid=${fid}&protocol=ethereum`,
      { headers: { Accept: 'application/json' } },
    )
    if (!res.ok) {
      await redis.set(cacheKey, '', { ex: PRIMARY_ADDRESS_FAIL_TTL }).catch(() => {})
      return null
    }
    const body = (await res.json()) as {
      result?: { address?: { address?: string } }
    }
    const raw = body.result?.address?.address
    const address = raw ? raw.toLowerCase() : null
    await redis
      .set(cacheKey, address ?? '', {
        ex: address ? PRIMARY_ADDRESS_TTL : PRIMARY_ADDRESS_FAIL_TTL,
      })
      .catch(() => {})
    return address
  } catch {
    // Network failure — don't poison the cache; let the next request retry.
    return null
  }
}

/**
 * Verify a Quick Auth JWT and resolve to a Kismet session identity.
 *
 * Returns null on any failure: invalid signature, expired, wrong audience,
 * or the FID has no primary Ethereum address. Treat null as "not
 * authenticated" — the caller should fall through to the cookie path.
 *
 * Verification is local (no network call) — only the FID→address lookup
 * touches the network, and that's cached.
 */
export async function verifyFarcasterJwt(
  token: string,
): Promise<FarcasterAuthResult | null> {
  let fid: number
  try {
    const payload = await client.verifyJwt({ token, domain: DOMAIN })
    fid = payload.sub
  } catch {
    // Any verification failure (bad signature, expired, wrong audience,
    // malformed JWT) collapses to "not authenticated". Don't log: bogus
    // tokens are a routine attack-surface and would dominate logs.
    // Genuine infra failures (e.g. can't fetch the FC public key) surface
    // through `verifyJwt`'s own retry/cache layer; they're rare and not
    // actionable per-request.
    return null
  }

  const address = await getPrimaryAddress(fid)
  if (!address) return null
  return { fid, address }
}
