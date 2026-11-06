import { NextRequest, NextResponse } from 'next/server'
import { verifyAdminSession } from '@/lib/curator'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'
import { arkivWriterAddress, isArkivWritable } from '@/lib/arkiv/client'
import { readDropsFlag, setDropsFlag } from '@/lib/dropsStore'
import { getStampStatus, isSwarmUploadConfigured, swarmPublicInfo } from '@/lib/swarm'

export const runtime = 'nodejs'

/**
 * Admin front door for the claim-drops flag (kismetart:drops-enabled) — same
 * authenticated, audited shape as /api/admin/sweep. GET also reports whether
 * the pieces drops need are wired: the Arkiv writer (address only, never the
 * key) and the Swarm batch's health, so an operator can see a drained batch
 * before artists hit failed uploads.
 */
export async function GET(req: NextRequest) {
  if (!(await checkRateLimit(`admin-drops-get:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  let flag: boolean
  try {
    flag = await readDropsFlag()
  } catch {
    return errorResponse(503, 'Drops flag unreadable (Redis)')
  }
  return NextResponse.json(
    {
      flag,
      envOverride: process.env.DROPS_ENABLED?.trim() === '1',
      arkiv: { writer: arkivWriterAddress(), writable: isArkivWritable() },
      swarm: { uploads: isSwarmUploadConfigured(), ...swarmPublicInfo(), stamp: await getStampStatus() },
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`admin-drops:${getClientIp(req)}`, 20, 60))) {
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

  await setDropsFlag(body.enabled)
  await recordAdminAction('drops.set', { actor: auth.signer, meta: { enabled: body.enabled } })
  return NextResponse.json({ enabled: body.enabled }, { headers: { 'Cache-Control': 'private, no-store' } })
}
