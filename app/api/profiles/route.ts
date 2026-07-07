import { NextRequest, NextResponse, after } from 'next/server'
import { isAddress } from '@/lib/address'
import { getHiddenIdentityClosure, resolveCanonicalProfile } from '@/lib/addressUnion'
import { getCachedEns, resolveEnsAndCache } from '@/lib/ensCache'
import { pickProfileIdentity } from '@/lib/profileIdentity'
import { errorResponse } from '@/lib/apiResponse'

// Batch "lite" profile resolver: maps many raw addresses to { name, avatarUrl }
// in one request, for activity rows (comment senders). In-process returns only
// bare addresses, so each sender needs client-side identity resolution — doing
// that one /api/profile call at a time was the N+1. Same name/avatar precedence
// as /api/profile/[address], minus the earnings/full-profile bundle rows never read.
const MAX_ADDRESSES = 50 // bound the fan-out; the client chunks larger sets

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get('addresses')
  if (!raw) return errorResponse(400, 'addresses required')

  // Trim → lowercase (so keys match the client's lowercased senders) → dedupe →
  // drop malformed (skipped, not 400'd, so one bad entry can't blank the list) → cap.
  const addresses = Array.from(
    new Set(raw.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean)),
  ).filter(isAddress).slice(0, MAX_ADDRESSES)

  // Sibling-closure read (memoized), fetched once for the whole batch.
  // Hidden identities resolve to the empty identity — the client's
  // documented fallback is shortAddress, so rows render address-only
  // instead of leaking the name. The closure covers hide-by-sibling: any
  // wallet of a hidden identity resolves empty, not just the listed one.
  const hiddenProfiles = await getHiddenIdentityClosure()

  const profiles: Record<string, { name: string; avatarUrl?: string }> = Object.fromEntries(
    await Promise.all(
      addresses.map(async (addr): Promise<[string, { name: string; avatarUrl?: string }]> => {
        try {
          const [{ profile, farcaster, canonicalAddress }, ens] = await Promise.all([
            resolveCanonicalProfile(addr),
            getCachedEns(addr),
          ])
          // Closure membership on the queried + canonical address — the
          // closure already contains every sibling of every hidden entry,
          // so no per-row expansion is needed for full coverage.
          if (hiddenProfiles.has(addr) || hiddenProfiles.has(canonicalAddress.toLowerCase())) {
            return [addr, { name: '', avatarUrl: undefined }]
          }
          // Warm ENS in the background on a miss, like the single route, so the
          // next view resolves the .eth name from cache.
          if (!profile.username && ens === undefined) after(() => resolveEnsAndCache(addr))
          return [addr, pickProfileIdentity(profile, farcaster, ens)]
        } catch {
          // Isolate per-address failures (e.g. a transient Redis/FC blip) so one
          // sender can't blank the whole batch — as independent per-sender calls
          // did before batching. The client maps the empty name to shortAddress.
          return [addr, { name: '', avatarUrl: undefined }]
        }
      }),
    ),
  )

  // Lite, public, no viewer variance — safe to cache at the edge. Short s-maxage
  // keeps edits fresh while parallel/repeat lookups hit warm cache.
  return NextResponse.json(
    { profiles },
    { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } },
  )
}
