import { NextRequest, NextResponse, after } from 'next/server'
import { isAddress } from '@/lib/address'
import { getHiddenIdentityClosure, resolveCanonicalProfile } from '@/lib/addressUnion'
import { getCachedEns, resolveEnsAndCache, resolveEnsWithBudget } from '@/lib/ensCache'
import { pickProfileIdentity } from '@/lib/profileIdentity'
import { errorResponse } from '@/lib/apiResponse'

// Batch "lite" profile resolver: maps many raw addresses to { name, avatarUrl }
// in one request, for activity rows (comment senders). In-process returns only
// bare addresses, so each sender needs client-side identity resolution — doing
// that one /api/profile call at a time was the N+1. Same name/avatar precedence
// as /api/profile/[address], minus the earnings/full-profile bundle rows never read.
const MAX_ADDRESSES = 50 // bound the fan-out; the client chunks larger sets

// Cold-ENS budgets. A sender with no Kismet username, no FC identity, and no
// cached ENS answer would render as a bare address, so those misses are worth
// resolving INLINE — bounded, so a cold page pays one shared sub-second wait
// instead of the old guarantee that a first view could never show a name.
// The two caps also bound the mainnet burst one request can fire (each
// resolution is 2 eth_calls; before them, one cold 50-sender page kicked up
// to 100 concurrent calls at the RPC — the exact burst that got the public
// default endpoint rate-limited and the failures cached as "no ENS"):
// at most ENS_INLINE_MAX misses resolve inline (same-tick, so viem's batch
// transport collapses them), at most ENS_WARM_MAX more warm in the
// background, and the rest stay cold for a later request or the client's
// one-shot retry (components/MomentActivity) to pick up.
const ENS_INLINE_MAX = 8
const ENS_INLINE_BUDGET_MS = 500
const ENS_WARM_MAX = 8

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

  // Inline/warm slot counters, shared across the map below. Check-and-decrement
  // happens synchronously (no await between), so the caps hold even though the
  // per-address callbacks interleave; WHICH addresses win slots follows
  // resolution-completion order, which is fine — any subset of the cold set is
  // an improvement, and the rest heal on later requests.
  let inlineSlots = ENS_INLINE_MAX
  let warmSlots = ENS_WARM_MAX

  const profiles: Record<string, { name: string; avatarUrl?: string }> = Object.fromEntries(
    await Promise.all(
      addresses.map(async (addr): Promise<[string, { name: string; avatarUrl?: string }]> => {
        try {
          const [{ profile, farcaster, canonicalAddress }, cachedEns] = await Promise.all([
            resolveCanonicalProfile(addr),
            getCachedEns(addr),
          ])
          // Closure membership on the queried + canonical address — the
          // closure already contains every sibling of every hidden entry,
          // so no per-row expansion is needed for full coverage.
          if (hiddenProfiles.has(addr) || hiddenProfiles.has(canonicalAddress.toLowerCase())) {
            return [addr, { name: '', avatarUrl: undefined }]
          }
          let ens = cachedEns
          if (ens === undefined && !profile.username) {
            if (!farcaster?.username && inlineSlots > 0) {
              // No identity at all without ENS → this row renders as a bare
              // address unless we resolve NOW. Bounded; on budget overrun the
              // resolution keeps running past the response (after() keeps the
              // request context alive for the cache write) and the next view
              // reads warm.
              inlineSlots--
              const r = await resolveEnsWithBudget(addr, ENS_INLINE_BUDGET_MS)
              ens = r.ens
              if (r.pending) {
                const pending = r.pending
                after(() => pending)
              }
            } else if (warmSlots > 0) {
              // FC-named senders display fine without ENS (pickProfileIdentity
              // prefers the FC username), and inline-capped misses still
              // deserve a warm — background only, bounded by ENS_WARM_MAX.
              warmSlots--
              after(() => resolveEnsAndCache(addr))
            }
          }
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
