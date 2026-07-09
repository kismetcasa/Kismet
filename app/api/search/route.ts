import { NextRequest, NextResponse } from 'next/server'
import { searchProfiles } from '@/lib/profile'
import { searchCollections } from '@/lib/kv'
import { searchMoments } from '@/lib/search'
import { getHiddenIdentityClosure } from '@/lib/addressUnion'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`search:${ip}`, 30, 60)
  if (!allowed) {
    return errorResponse(429, 'Too many requests')
  }

  const q = new URL(req.url).searchParams.get('q')?.trim() ?? ''
  if (q.length < 2 || q.length > 100) {
    return NextResponse.json({ users: [], collections: [], mints: [] })
  }
  const [rawUsers, collections, mints, hiddenIdentities] = await Promise.all([
    searchProfiles(q),
    searchCollections(q),
    searchMoments(q),
    getHiddenIdentityClosure(),
  ])
  // Sibling-aware strip on top of searchProfiles' own direct-membership
  // filter: hiding ANY of a Farcaster user's verified wallets removes the
  // identity from search even when the profile row lives at a sibling.
  // Route-level (not in lib/profile) because the closure lives in
  // addressUnion, which lib/profile cannot import without a cycle.
  const users =
    hiddenIdentities.size === 0
      ? rawUsers
      : rawUsers.filter((u) => !hiddenIdentities.has(u.address.toLowerCase()))
  return NextResponse.json({ users, collections, mints })
}
