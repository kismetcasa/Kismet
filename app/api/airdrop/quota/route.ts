import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getQuotaStatus } from '@/lib/airdrop-quota'
import { getGateConfig } from '@/lib/gate'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Pre-flight quota probe for the airdrop UI. Returns current limits +
 * how much the artist has used today / this week + how much remains +
 * the configured Pass collection (so the client can tell whether the
 * caller's currently-selected moment is subject to the quota). Read-
 * only; safe to poll on every recipient-list change.
 *
 * Scoping: the quota only applies to airdrops in the configured Pass
 * collection. Both this probe (for UX gating) and /api/airdrop/notify
 * (for actual enforcement) read gate config per request so the scope
 * tracks live admin changes. When passCollection is null, no airdrop
 * ever debits — the response still carries the per-artist counters for
 * symmetry, but the client should treat them as advisory.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`airdrop-quota:${ip}`, 60, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const artist = req.nextUrl.searchParams.get('artist')?.toLowerCase()
  if (!artist || !isAddress(artist)) {
    return errorResponse(400, 'Invalid artist')
  }

  const [status, config] = await Promise.all([
    getQuotaStatus(artist),
    getGateConfig(),
  ])
  return NextResponse.json({ ...status, passCollection: config.passCollection })
}
