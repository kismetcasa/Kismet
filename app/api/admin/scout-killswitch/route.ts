import { NextRequest, NextResponse } from 'next/server'
import { redis } from '@/lib/redis'
import { verifyAdminSession } from '@/lib/curator'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

export const runtime = 'nodejs'

/**
 * Admin kill switch for the autonomous agent. When engaged, `runScoutServer` and
 * `runDropCoordination` both halt at the top — stopping ALL autonomous spending
 * instantly without a deploy. Admin-only (HttpOnly session cookie, like every
 * other /api/admin/* route); the flag itself is the bare Redis key the agent
 * checks, so this is just an operable, authenticated, audit-able front door for it.
 */
const KEY = 'kismetart:scout-killswitch'

export async function GET(req: NextRequest) {
  if (!(await checkRateLimit(`scout-kill-get:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const engaged = !!(await redis.get(KEY))
  return NextResponse.json({ engaged })
}

export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`scout-kill:${getClientIp(req)}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  let body: { engaged?: boolean }
  try {
    body = (await req.json()) as { engaged?: boolean }
  } catch {
    return errorResponse(400, 'Invalid JSON')
  }
  if (typeof body.engaged !== 'boolean') return errorResponse(400, 'engaged must be a boolean')

  if (body.engaged) await redis.set(KEY, '1')
  else await redis.del(KEY)
  return NextResponse.json({ engaged: body.engaged })
}
