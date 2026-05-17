import { NextRequest, NextResponse } from 'next/server'
import { searchProfiles } from '@/lib/profile'
import { searchCollections } from '@/lib/kv'
import { searchMoments } from '@/lib/search'
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
  const [users, collections, mints] = await Promise.all([
    searchProfiles(q),
    searchCollections(q),
    searchMoments(q),
  ])
  return NextResponse.json({ users, collections, mints })
}
