import { NextRequest, NextResponse } from 'next/server'
import { searchProfiles } from '@/lib/profile'
import { searchCollections } from '@/lib/kv'
import { searchMoments } from '@/lib/search'
import { checkRateLimit } from '@/lib/ratelimit'

export async function GET(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'

  const allowed = await checkRateLimit(`search:${ip}`, 30, 60)
  if (!allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  const q = new URL(req.url).searchParams.get('q')?.trim() ?? ''
  if (q.length < 2 || q.length > 100) {
    return NextResponse.json({ users: [], collections: [], mints: [] })
  }
  const [users, collections, mints] = await Promise.all([
    searchProfiles(q),
    searchCollections(q),
    searchMoments(q),
  ])
  return NextResponse.json({ users, collections, mints })
}
