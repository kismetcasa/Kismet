import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { refuseUnlessCron } from '@/lib/cronAuth'
import { payReferralRewards } from '@/lib/experience/machineJobs'

export const dynamic = 'force-dynamic'
// Up to MAX_PAYOUTS_PER_RUN sequential simulate-and-broadcast rounds, each a
// few CDP round trips — far past a default function timeout. Same ceiling the
// stats cron takes.
export const maxDuration = 300

/**
 * Push escrowed referral rewards to their owners, so nobody claims
 * (lib/experience/machineJobs). Scheduled daily by vercel.json; on a
 * persistent host the app also runs it itself (lib/backgroundTasks), so there
 * this route is optional.
 */
export async function GET(req: NextRequest) {
  const refused = refuseUnlessCron(req)
  if (refused) return refused
  const run = await payReferralRewards()
  if ('unavailable' in run) return errorResponse(503, 'The sponsoring account is unavailable')
  return NextResponse.json(run)
}
