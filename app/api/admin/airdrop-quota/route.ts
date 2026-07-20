import { NextRequest, NextResponse } from 'next/server'
import { getLimits, setLimits } from '@/lib/airdrop-quota'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'

async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-airdrop-quota:${ip}`, 20, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const limits = await getLimits()
  return NextResponse.json(limits)
}

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { day?: unknown; week?: unknown } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const day = typeof body.day === 'number' ? body.day : NaN
  const week = typeof body.week === 'number' ? body.week : NaN

  // Generous upper bound to allow Season-2-style high-volume cohorts while
  // still blocking obvious typos (e.g. `1000000` in the day field).
  if (!Number.isFinite(day) || day < 0 || day > 100_000) {
    return errorResponse(400, 'Invalid day (must be 0-100000)')
  }
  if (!Number.isFinite(week) || week < 0 || week > 1_000_000) {
    return errorResponse(400, 'Invalid week (must be 0-1000000)')
  }

  try {
    const saved = await setLimits({ day, week })
    await recordAdminAction('airdrop-quota.set', { actor: auth.signer, meta: { day, week } })
    return NextResponse.json({ ok: true, ...saved })
  } catch (e) {
    return errorResponse(400, e instanceof Error ? e.message : 'Save failed')
  }
}
