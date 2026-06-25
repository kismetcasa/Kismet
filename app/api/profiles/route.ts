import { NextRequest, NextResponse, after } from 'next/server'
import { isAddress } from '@/lib/address'
import { resolveCanonicalProfile } from '@/lib/addressUnion'
import { getCachedEns, resolveEnsAndCache } from '@/lib/ensCache'
import { errorResponse } from '@/lib/apiResponse'

// Batch "lite" profile resolver: maps many raw addresses to { name, avatarUrl }
// in ONE request. Built for activity rows (collector comment senders), where
// in-process returns only bare addresses ({ sender, comment, timestamp }) so
// each sender must be resolved to a display name + avatar client-side.
//
// Replaces the previous N parallel /api/profile/<addr> round-trips (one per
// unique sender) with a single call, and deliberately omits the earnings +
// full-profile bundle the single route returns — an activity row reads only
// name + avatar, so resolving earnings/canonical/farcaster-object per sender
// was pure waste.

// Bound the fan-out so one request can't spin up an unbounded number of
// Redis + Farcaster lookups. The client chunks larger sets to this size.
const MAX_ADDRESSES = 50

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const raw = searchParams.get('addresses')
  if (!raw) return errorResponse(400, 'addresses required')

  // Parse → trim → lowercase → dedupe. Lowercase here so the cache key and
  // the response map line up with the client's lowercased sender set.
  const requested = Array.from(
    new Set(raw.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean)),
  )
  if (requested.length === 0) return errorResponse(400, 'addresses required')
  if (requested.length > MAX_ADDRESSES) {
    return errorResponse(400, `Too many addresses (max ${MAX_ADDRESSES})`)
  }

  // Skip malformed addresses rather than failing the whole batch — one bad
  // entry shouldn't blank an entire activity list. Omitted addresses simply
  // don't appear in the map and the client falls back to shortAddress.
  const valid = requested.filter(isAddress)

  // Resolve every address' name + avatar in parallel. Same precedence as
  // /api/profile/[address] (username → farcaster → ens; own avatar → fc pfp),
  // reusing resolveCanonicalProfile (which already returns the farcaster
  // profile, so there's no separate getFarcasterProfileByAddress call) plus
  // the shared ENS cache.
  const entries = await Promise.all(
    valid.map(async (addr) => {
      const [canonical, cachedEns] = await Promise.all([
        resolveCanonicalProfile(addr),
        getCachedEns(addr),
      ])
      const { profile, farcaster } = canonical
      // Warm the ENS cache in the background on a miss, exactly like the
      // single route — so the next view resolves the .eth name from cache.
      if (!profile.username && cachedEns === undefined) {
        after(() => resolveEnsAndCache(addr))
      }
      const ensName = cachedEns || undefined
      const name = profile.username || farcaster?.username || ensName || ''
      const avatarUrl = profile.avatarUrl || farcaster?.pfpUrl || undefined
      return [addr, { name, avatarUrl }] as const
    }),
  )

  const profiles: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const [addr, p] of entries) profiles[addr] = p

  return NextResponse.json(
    { profiles },
    {
      headers: {
        // Lite, public, per-address identity — no viewer variance, safe to
        // cache at the edge. Short s-maxage keeps profile edits fresh within
        // a cycle while parallel/repeat activity lookups hit warm cache.
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
      },
    },
  )
}
