import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { errorResponse } from '@/lib/apiResponse'
import { epochFor } from '@/lib/experience/fairness'
import { listMachines, openEpochSeeds } from '@/lib/experience/store'

export const dynamic = 'force-dynamic'

/**
 * Daily seed commitment for every machine that can still draw.
 *
 * ── Why a cron and not only the read path ──
 *
 * openEpochSeeds runs on every machine read and commits today's AND tomorrow's
 * seed, so any machine anyone looks at is always committed a full epoch ahead.
 * The one case that leaves open is a machine nobody has loaded for two days:
 * its next play would create the seed at freeze time — after the player's
 * transaction exists, which is the ordering commit–reveal is supposed to rule
 * out. Traffic-independent publication is the industry norm for exactly this
 * reason (a daily commitment that does not depend on anyone showing up), and
 * it costs one bounded pass over the live list.
 *
 * Idempotent: every write underneath is SET NX, so running it twice — or
 * racing a read — cannot rotate a seed that already exists.
 *
 * Auth mirrors /api/cron/sync-stats: CRON_SECRET as `Authorization: Bearer`
 * or `?secret=`, constant-time compared.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse(500, 'CRON_SECRET not configured')

  const auth = req.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const provided = (bearer ?? new URL(req.url).searchParams.get('secret') ?? '').trim()
  const providedBuf = Buffer.from(provided)
  const secretBuf = Buffer.from(secret.trim())
  if (providedBuf.length !== secretBuf.length || !crypto.timingSafeEqual(providedBuf, secretBuf)) {
    return errorResponse(401, 'Unauthorized')
  }

  const epoch = epochFor(Date.now())
  // Every machine that can still DRAW, not only the ones on sale. An ended or
  // delisted machine sells nothing, but a stalled claim on it is discharged by
  // a fresh draw through the resume path, and that draw needs a seed that was
  // committed before the resume was requested — the same property this cron
  // exists to give live machines.
  const machines = await listMachines(['live', 'ended', 'delisted'])
  const results = await Promise.all(
    machines.map((m) =>
      openEpochSeeds(m.id, epoch)
        .then((r) => ({ id: m.id, ok: true, next: r.next.epoch }))
        .catch(() => ({ id: m.id, ok: false, next: null })),
    ),
  )

  return NextResponse.json({
    epoch,
    machines: results.length,
    committed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).map((r) => r.id),
  })
}
