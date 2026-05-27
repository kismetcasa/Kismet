import { type NextRequest, NextResponse } from 'next/server'
import { isPlatformPaused } from '@/lib/gate'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Public read of the platform-pause flag. Unlike /api/admin/gate (which
// returns the full gate config and is admin-only), this exposes nothing
// but `paused` so client UI can disable mutating affordances (e.g. the
// create-collection button) while paused. Admin exemption is applied
// client-side — this endpoint reports the raw flag.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`platform-status:${ip}`, 120, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const paused = await isPlatformPaused()
  return NextResponse.json({ paused })
}
