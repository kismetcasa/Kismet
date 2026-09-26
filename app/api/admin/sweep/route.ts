import { NextRequest, NextResponse } from 'next/server'
import { verifyAdminSession } from '@/lib/curator'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'
import { getSweepIndex, isSweepEnabled, setSweepEnabled } from '@/lib/sweepIndex'

export const runtime = 'nodejs'

/**
 * Admin front door for the sweep feature flag (kismetart:sweep-enabled) — the
 * same operable, authenticated, audited shape as /api/admin/scout-killswitch.
 * GET also reports the index snapshot (age, eligible count, pool size) so an
 * operator can confirm the hourly build has run before flipping the flag on.
 * The index rebuilds whether or not the flag is set, so enabling is instant.
 */
export async function GET(req: NextRequest) {
  if (!(await checkRateLimit(`admin-sweep-get:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const [enabled, index] = await Promise.all([isSweepEnabled().catch(() => false), getSweepIndex()])
  return NextResponse.json(
    {
      enabled,
      index: index
        ? { updatedAt: index.updatedAt, eligible: index.eligible, pool: index.items.length }
        : null,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`admin-sweep:${getClientIp(req)}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  let body: { enabled?: boolean }
  try {
    body = (await req.json()) as { enabled?: boolean }
  } catch {
    return errorResponse(400, 'Invalid JSON')
  }
  if (typeof body.enabled !== 'boolean') return errorResponse(400, 'enabled must be a boolean')

  await setSweepEnabled(body.enabled)
  await recordAdminAction('sweep.set', {
    actor: auth.signer,
    meta: { enabled: body.enabled },
  })
  return NextResponse.json({ enabled: body.enabled }, { headers: { 'Cache-Control': 'private, no-store' } })
}
