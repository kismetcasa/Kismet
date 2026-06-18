import { NextRequest, NextResponse } from 'next/server'
import { rebuildStats } from '@/lib/stats'
import { errorResponse } from '@/lib/apiResponse'

export const dynamic = 'force-dynamic'
// A full /transfers scan can run long on a large feed; matches transcode-gif.
export const maxDuration = 300

// Rebuilds artist stats from the In•Process /transfers feed. Scheduled via the
// vercel.json cron; also callable manually for the initial backfill. Protected
// by CRON_SECRET — Vercel cron sends it as `Authorization: Bearer <secret>`
// automatically; manual calls can pass `?secret=`.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse(500, 'CRON_SECRET not configured')

  const auth = req.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const provided = bearer ?? new URL(req.url).searchParams.get('secret')
  if (provided !== secret) return errorResponse(401, 'Unauthorized')

  const started = Date.now()
  try {
    const result = await rebuildStats()
    return NextResponse.json({ ok: true, ...result, ms: Date.now() - started })
  } catch (err) {
    console.error('[sync-stats] rebuild failed', err)
    return errorResponse(502, 'Stats rebuild failed')
  }
}
