// Regression guard for the batched activity-row profile resolution
// (/api/profiles + fetchCreatorProfilesBatch), which replaced one
// /api/profile/<addr> call per comment sender.
//
// THE REGRESSIONS IT GUARDS:
//   1. Identity drift — the batch/lite path must resolve the SAME name + avatar
//      an activity row showed via the per-address /api/profile path. Both routes
//      now share pickProfileIdentity; this pins that function to the ORIGINAL
//      single-route formula across the full identity matrix, so a future edit to
//      either route can't silently change what a collector's row displays.
//   2. Client mechanics — fetchCreatorProfilesBatch must: return an entry for
//      every input, hit the LRU instead of the network on repeats, batch misses
//      into one sorted request, chunk past the route cap, fall back to
//      shortAddress on partial/error responses, NOT cache transient errors
//      (so they retry), and dedupe.
//
// Exercises the REAL production modules (not copies). fetch is stubbed because
// the client reads globalThis.fetch at call time, so no network/DOM is needed.
//
// Run: node --experimental-strip-types scripts/verify-profiles-batch.ts

import { pickProfileIdentity } from '../lib/profileIdentity.ts'
import { fetchCreatorProfilesBatch } from '../lib/profileCache.ts'
import { shortAddress } from '../lib/inprocess.ts'

let failures = 0
function check(cond: boolean, msg: string): void {
  if (cond) console.log('  PASS  ' + msg)
  else { console.error('  FAIL  ' + msg); failures += 1 }
}

// ───────────────────────── Part 1: identity equivalence ─────────────────────
// The ORIGINAL single-route projection (app/api/profile/[address]/route.ts,
// pre-refactor) + how its client (fetchCreatorProfile) collapsed the response
// to a rendered name. If pickProfileIdentity ever drifts from this, a real
// activity row would change — and this fails.
function originalRenderedName(
  profile: { username?: string; avatarUrl?: string },
  farcaster: { username: string | null; pfpUrl: string | null } | null,
  cachedEns: string | null | undefined,
): { name: string; avatarUrl: string | undefined } {
  const ensName = cachedEns || undefined
  const avatarUrl = profile.avatarUrl || farcaster?.pfpUrl || undefined
  const displayName = profile.username || farcaster?.username || ensName || null
  // fetchCreatorProfile: name = displayName || username || ensName || '', then
  // the entry stores `name || shortAddress` as the displayed string.
  const name = displayName || profile.username || ensName || ''
  return { name, avatarUrl }
}

type Shape = {
  label: string
  profile: { username?: string; avatarUrl?: string }
  farcaster: { username: string | null; pfpUrl: string | null } | null
  ens: string | null | undefined
}
const MATRIX: Shape[] = [
  { label: 'kismet username only', profile: { username: 'alice' }, farcaster: null, ens: null },
  { label: 'kismet username + avatar', profile: { username: 'alice', avatarUrl: 'a.png' }, farcaster: null, ens: null },
  { label: 'farcaster only', profile: {}, farcaster: { username: 'bob', pfpUrl: 'b.png' }, ens: null },
  { label: 'ens only', profile: {}, farcaster: null, ens: 'carol.eth' },
  { label: 'username beats fc beats ens', profile: { username: 'alice' }, farcaster: { username: 'bob', pfpUrl: 'b.png' }, ens: 'carol.eth' },
  { label: 'own avatar beats fc pfp', profile: { username: 'alice', avatarUrl: 'a.png' }, farcaster: { username: 'bob', pfpUrl: 'b.png' }, ens: null },
  { label: 'fc username, no kismet username', profile: {}, farcaster: { username: 'bob', pfpUrl: null }, ens: 'carol.eth' },
  { label: 'fc pfp only (no usernames)', profile: {}, farcaster: { username: null, pfpUrl: 'b.png' }, ens: null },
  { label: 'ens confirmed-none (null) + nothing', profile: {}, farcaster: null, ens: null },
  { label: 'all empty', profile: {}, farcaster: null, ens: undefined },
]
console.log('Part 1 — pickProfileIdentity matches the original single-route projection:')
for (const s of MATRIX) {
  const got = pickProfileIdentity(s.profile, s.farcaster, s.ens)
  const want = originalRenderedName(s.profile, s.farcaster, s.ens)
  // Compare the rendered string both paths would show (name || shortAddress).
  const fakeAddr = '0x' + '1'.repeat(40)
  const gotRendered = got.name || shortAddress(fakeAddr)
  const wantRendered = want.name || shortAddress(fakeAddr)
  check(
    gotRendered === wantRendered && got.avatarUrl === want.avatarUrl,
    `${s.label}: name "${gotRendered}" avatar ${String(got.avatarUrl)}`,
  )
}

// ───────────────────────── Part 2: client mechanics ────────────────────────
let fetchCalls: string[] = []
let fetchImpl: (url: string) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }> =
  async () => ({ ok: true, json: async () => ({ profiles: {} }) })
;(globalThis as unknown as { fetch: unknown }).fetch = async (url: unknown) => {
  fetchCalls.push(String(url))
  return fetchImpl(String(url))
}
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0')
const addrsParam = (url: string) => decodeURIComponent(new URL('http://x' + url).searchParams.get('addresses') ?? '')

console.log('Part 2 — fetchCreatorProfilesBatch mechanics:')

// (a) entry for every input; partial response → shortAddress fallback; one
//     sorted request.
{
  fetchCalls = []
  const [A, B, C] = [addr(1), addr(2), addr(3)]
  fetchImpl = async () => ({ ok: true, json: async () => ({ profiles: { [A]: { name: 'aa' }, [B]: { name: 'bb', avatarUrl: 'b.png' } } }) })
  const out = await fetchCreatorProfilesBatch([A, B, C])
  check(Object.keys(out).length === 3, 'returns an entry for every input address')
  check(out[A].name === 'aa' && out[B].name === 'bb' && out[B].avatarUrl === 'b.png', 'resolved names/avatars passed through')
  check(out[C].name === shortAddress(C) && out[C].avatarUrl === undefined, 'unresolved address falls back to shortAddress')
  check(fetchCalls.length === 1, 'misses collapse into ONE request')
  check(addrsParam(fetchCalls[0]) === [A, B, C].sort().join(','), 'request addresses are sorted (stable CDN key)')
}

// (b) cache hit: re-requesting resolved addresses makes no network call.
{
  fetchCalls = []
  const A = addr(1) // resolved+cached in (a)
  const out = await fetchCreatorProfilesBatch([A])
  check(fetchCalls.length === 0, 'cached resolved address skips the network')
  check(out[A].name === 'aa', 'cached value returned')
}

// (c) dedupe within a call.
{
  fetchCalls = []
  const D = addr(4)
  fetchImpl = async () => ({ ok: true, json: async () => ({ profiles: { [D]: { name: 'dd' } } }) })
  const out = await fetchCreatorProfilesBatch([D, D, D])
  check(Object.keys(out).length === 1, 'duplicate inputs deduped to one entry')
  check(addrsParam(fetchCalls[0]) === D, 'duplicate inputs sent once')
}

// (d) transient error (non-2xx) → shortAddress, NOT cached → retried next call.
{
  fetchCalls = []
  const E = addr(5)
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const out1 = await fetchCreatorProfilesBatch([E])
  check(out1[E].name === shortAddress(E), 'non-2xx falls back to shortAddress')
  fetchImpl = async () => ({ ok: true, json: async () => ({ profiles: { [E]: { name: 'ee' } } }) })
  const out2 = await fetchCreatorProfilesBatch([E])
  check(fetchCalls.length === 2 && out2[E].name === 'ee', 'errored address is NOT cached — retried and resolves next call')
}

// (e) network throw → same uncached fallback.
{
  fetchCalls = []
  const F = addr(6)
  fetchImpl = async () => { throw new Error('network down') }
  const out = await fetchCreatorProfilesBatch([F])
  check(out[F].name === shortAddress(F), 'thrown fetch falls back to shortAddress')
  check(fetchCalls.length === 1, 'thrown fetch was attempted once')
}

// (f) chunking past the route cap (50).
{
  fetchCalls = []
  const many = Array.from({ length: 120 }, (_, i) => addr(1000 + i))
  fetchImpl = async (url) => {
    const keys = addrsParam(url).split(',')
    return { ok: true, json: async () => ({ profiles: Object.fromEntries(keys.map((k) => [k, { name: 'n' + k.slice(-2) }])) }) }
  }
  const out = await fetchCreatorProfilesBatch(many)
  check(Object.keys(out).length === 120, '120 inputs all resolved')
  check(fetchCalls.length === 3, '120 inputs chunked into ceil(120/50)=3 requests')
  check(fetchCalls.every((u) => addrsParam(u).split(',').length <= 50), 'no chunk exceeds the cap of 50')
}

// (g) empty input → no network, empty map.
{
  fetchCalls = []
  const out = await fetchCreatorProfilesBatch([])
  check(Object.keys(out).length === 0 && fetchCalls.length === 0, 'empty input: no request, empty result')
}

if (failures > 0) {
  console.error(`\n✖ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n✓ all profiles-batch checks passed')
