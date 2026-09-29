import 'server-only'
import crypto from 'node:crypto'
import type { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from './apiResponse'

/**
 * The shared gate for cron routes: CRON_SECRET as `Authorization: Bearer`
 * (what Vercel cron sends) or `?secret=`, trimmed, compared in constant time
 * and length-checked first so timingSafeEqual cannot throw. Returns the
 * response to send when the request is refused, or null to proceed.
 */
export function refuseUnlessCron(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse(500, 'CRON_SECRET not configured')
  const auth = req.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const provided = Buffer.from((bearer ?? new URL(req.url).searchParams.get('secret') ?? '').trim())
  const expected = Buffer.from(secret.trim())
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return errorResponse(401, 'Unauthorized')
  }
  return null
}
