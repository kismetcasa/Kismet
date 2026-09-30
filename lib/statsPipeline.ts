import { rebuildStats, reconcilePendingCredits } from './stats'
import { rebuildCatalogCensus } from './catalogCensus'
import { rebuildSweepIndex } from './sweepIndex'
import { recordStatsRun } from './statsHealth'

/**
 * The hourly stats pipeline: stats rebuild → catalog census → sweep index →
 * pending-credit reconcile, each phase in its own try/catch and recorded
 * through recordStatsRun. Driven by /api/cron/sync-stats (Vercel's cron, or an
 * external scheduler on a persistent host) and, when nothing has driven it for
 * an hour, by the in-process fallback in lib/backgroundTasks — one function for
 * both, so the two cannot drift. Idempotent and self-healing: every phase holds
 * its own single-flight lock, so an overlapping run is a benign skip, and an
 * interrupted run is corrected on the next pass. Never throws; the results go
 * to the server logs and to /api/admin/stats-health.
 */
export async function runStatsPipeline(): Promise<void> {
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
  // transfers feed, not the timeline) doesn't block the census either. The
  // sweep index rides inside the census branch (it needs the walk's output).
  if (rebuildSkipped) return
  const censusStarted = Date.now()
  try {
    const result = await rebuildCatalogCensus()
    if ('skipped' in result) {
      console.log('[sync-stats] census skipped (already running)')
      await recordStatsRun('census', 'skipped')
    } else {
      console.log('[sync-stats] census ok', { ...result.census, ms: Date.now() - censusStarted })
      await recordStatsRun('census', 'ok')

      // Sweep index (lib/sweepIndex.ts) — built from the SAME resolved
      // catalog the census just walked, so the catalog is never walked
      // twice and a census abort (unreadable collection, implausible
      // shrink) means no index rebuild either: the last good pool stays.
      // Own try/catch + own health phase: an RPC blip here must read as a
      // sweep-index failure, not a census failure. Runs whether or not the
      // sweep flag is on, so enabling the feature is instant.
      const sweepStarted = Date.now()
      try {
        const index = await rebuildSweepIndex(result.catalog)
        console.log('[sync-stats] sweep-index ok', {
          eligible: index.eligible,
          pool: index.items.length,
          ms: Date.now() - sweepStarted,
        })
        await recordStatsRun('sweep-index', 'ok')
      } catch (err) {
        console.error('[sync-stats] sweep-index failed', err)
        await recordStatsRun('sweep-index', 'error', err instanceof Error ? err.message : String(err))
      }
    }
  } catch (err) {
    console.error('[sync-stats] census failed', err)
    await recordStatsRun('census', 'error', err instanceof Error ? err.message : String(err))
  }

  // Replay any event-driven credits/volume whose fill-time eval blipped
  // (see enqueuePendingCredit). The durable backstop for the "no webhook
  // replay" gap on royalty + resale-volume stats; usually an empty queue,
  // idempotent, and never throws. Reached only when the rebuild lock was
  // ours, so two overlapping runs don't both drain it at once.
  try {
    const rec = await reconcilePendingCredits()
    if (rec.processed > 0 || rec.pending > 0) console.log('[sync-stats] reconcile', rec)
  } catch (err) {
    console.error('[sync-stats] reconcile failed', err)
  }
}
