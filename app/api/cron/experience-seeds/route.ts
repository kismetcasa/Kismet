import { NextRequest, NextResponse } from 'next/server'
import { refuseUnlessCron } from '@/lib/cronAuth'
import { commitMachineSeeds } from '@/lib/experience/machineJobs'

export const dynamic = 'force-dynamic'

/**
 * Seed commitment for every machine that can still draw
 * (lib/experience/machineJobs, which says why it runs apart from the read
 * path). Scheduled daily by vercel.json; on a persistent host the app also
 * runs it itself (lib/backgroundTasks), so there this route is optional.
 *
 * Auth: lib/cronAuth, the same CRON_SECRET check /api/cron/sync-stats makes.
 */
export async function GET(req: NextRequest) {
  const refused = refuseUnlessCron(req)
  if (refused) return refused
  return NextResponse.json(await commitMachineSeeds())
}
