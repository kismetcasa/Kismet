import { NextRequest, NextResponse, after } from 'next/server'
import { rebuildStats } from '@/lib/stats'
import { errorResponse } from '@/lib/apiResponse'

export const dynamic = 'force-dynamic'
// A full /transfers scan can run long. We kick it off AFTER the response so a
// reverse proxy (Vercel, or Coolify/Traefik) can't time the request out and
// return 502 mid-scan. maxDuration is a Vercel-only hint; on a persistent server
// (Coolify) the after() callback runs to completion regardless.
export const maxDuration = 300

// Rebuilds artist stats from the In•Process /transfers feed. Scheduled via a cron
// (Vercel `crons` in vercel.json, OR — on Coolify — a Scheduled Task / external
// scheduler hitting this URL). Also callable manually. Protected by CRON_SECRET,
// sent as `Authorization: Bearer <secret>` (Vercel cron does this automatically)
// or `?secret=`. The compare is trimmed so a stray newline/space in the stored
// env var can't cause a spurious 401.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse(500, 'CRON_SECRET not configured')

  const auth = req.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
  const provided = bearer ?? new URL(req.url).searchParams.get('secret')
  if ((provided ?? '').trim() !== secret.trim()) return errorResponse(401, 'Unauthorized')

  // Respond immediately; run the rebuild in the background. The rebuild is
  // idempotent + self-healing, so an interrupted run is corrected on the next
  // pass. The result (artist/transfer counts) goes to the server logs, since the
  // HTTP response returns before it finishes.
  after(async () => {
    const started = Date.now()
    try {
      const result = await rebuildStats()
      if (result.skipped) {
        // Another run held the single-flight lock — a benign no-op, not a
        // failure; logged distinctly so it doesn't read as a missed rebuild.
        console.log('[sync-stats] rebuild skipped (already running)')
      } else {
        console.log('[sync-stats] rebuild ok', { ...result, ms: Date.now() - started })
      }
    } catch (err) {
      console.error('[sync-stats] rebuild failed', err)
    }
  })

  return NextResponse.json({ ok: true, started: true })
}
