import { NextRequest, NextResponse, after } from 'next/server'
import crypto from 'node:crypto'
import { rebuildStats, reconcilePendingCredits } from '@/lib/stats'
import { rebuildCatalogCensus } from '@/lib/catalogCensus'
import { recordStatsRun } from '@/lib/statsHealth'
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
  const provided = (bearer ?? new URL(req.url).searchParams.get('secret') ?? '').trim()
  // Constant-time compare, length-checked so timingSafeEqual can't throw on a
  // size mismatch (mirrors the Alchemy webhook route, which this one didn't).
  const providedBuf = Buffer.from(provided)
  const secretBuf = Buffer.from(secret.trim())
  if (providedBuf.length !== secretBuf.length || !crypto.timingSafeEqual(providedBuf, secretBuf)) {
    return errorResponse(401, 'Unauthorized')
  }

  // Respond immediately; run the rebuild in the background. The rebuild is
  // idempotent + self-healing, so an interrupted run is corrected on the next
  // pass. The result (artist/transfer counts) goes to the server logs, since the
  // HTTP response returns before it finishes.
  after(async () => {
    const started = Date.now()
    let rebuildSkipped = false
    try {
      const result = await rebuildStats()
      if (result.skipped) {
        // Another run held the single-flight lock — a benign no-op, not a
        // failure; logged distinctly so it doesn't read as a missed rebuild.
        rebuildSkipped = true
        console.log('[sync-stats] rebuild skipped (already running)')
        await recordStatsRun('rebuild', 'skipped')
      } else {
        console.log('[sync-stats] rebuild ok', { ...result, ms: Date.now() - started })
        await recordStatsRun('rebuild', 'ok')
      }
    } catch (err) {
      console.error('[sync-stats] rebuild failed', err)
      // Surface the abort to /api/admin/stats-health so a wedged rebuild (e.g.
      // a tripped integrity guard) is visible instead of a silent stale-serve.
      await recordStatsRun('rebuild', 'error', err instanceof Error ? err.message : String(err))
    }
    // Catalog census (platform artworks/artists) — sequential so the two
    // scans never hit the single upstream at once, and skipped when the
    // rebuild lock was held so an overlapping manual trigger doesn't double
    // the fan-out. Own try/catch: a census abort must not read as a rebuild
    // failure in the logs, and a failed rebuild (whose data source is the
    // transfers feed, not the timeline) doesn't block the census either.
    if (!rebuildSkipped) {
      const censusStarted = Date.now()
      try {
        const census = await rebuildCatalogCensus()
        if ('skipped' in census) {
          console.log('[sync-stats] census skipped (already running)')
          await recordStatsRun('census', 'skipped')
        } else {
          console.log('[sync-stats] census ok', { ...census, ms: Date.now() - censusStarted })
          await recordStatsRun('census', 'ok')
        }
      } catch (err) {
        console.error('[sync-stats] census failed', err)
        await recordStatsRun('census', 'error', err instanceof Error ? err.message : String(err))
      }

      // Replay any event-driven credits/volume whose fill-time eval blipped
      // (see enqueuePendingCredit). The durable backstop for the "no webhook
      // replay" gap on royalty + resale-volume stats; usually an empty queue,
      // idempotent, and never throws. Gated on !rebuildSkipped so two
      // overlapping cron hits don't both drain it at once.
      try {
        const rec = await reconcilePendingCredits()
        if (rec.processed > 0 || rec.pending > 0) console.log('[sync-stats] reconcile', rec)
      } catch (err) {
        console.error('[sync-stats] reconcile failed', err)
      }
    }
  })

  return NextResponse.json({ ok: true, started: true })
}
