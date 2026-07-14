/**
 * Next.js instrumentation hook — runs once per cold start before any
 * request is served. We use it to surface on-chain permission invariants
 * (see lib/healthcheck.ts) so misconfigs show up in function logs
 * immediately rather than at first user mint, and to warm the hot caches.
 *
 * We deliberately do NOT install process-level uncaughtException /
 * unhandledRejection handlers here. Next 15's production server already
 * installs its own (node_modules/next/dist/server/next-server.js) that
 * LOG-AND-CONTINUE — keeping the single process alive through a stray
 * uncaught error or rejection (it's even React-postpone aware so it won't
 * crash on framework-internal rejections). Adding our own uncaughtException
 * handler that called process.exit() would OVERRIDE that and crash the one
 * container Next intended to keep serving — the opposite of what we want on
 * a single instance with no peer to absorb a restart. Crash survival is the
 * framework's job; ours here is only to not BLOCK serving.
 *
 * Critical: never blocks serving. Next AWAITS register() before it starts
 * listening, so anything awaited here pads every cold-start / restart dark
 * window and — if a boot dependency hangs — can keep the liveness probe
 * unservable. Everything that isn't required to serve the first request is
 * therefore kicked off fire-and-forget; register() returns immediately.
 */

/**
 * Boot-time observability + cache warming. NONE of this is required to serve
 * the first request, so it runs fully detached from register(). Each block
 * is independently guarded — one failing dependency at boot can never delay
 * serving or take down a sibling task.
 */
function startBootTasks(): void {
  // Platform-collection permission invariant (observability only — a failure
  // means Kismet Casa mints into PLATFORM_COLLECTION may revert; the site
  // still serves). Was previously AWAITED in register(), which blocked the
  // listen on an on-chain RPC round trip on every cold start.
  void (async () => {
    try {
      const { assertPlatformCollectionAuthorized } = await import('@/lib/healthcheck')
      await assertPlatformCollectionAuthorized()
    } catch (err) {
      console.error(
        '[instrumentation] platform-collection healthcheck failed — site will continue serving but Kismet Casa mints into PLATFORM_COLLECTION may revert. Check logs and grant ADMIN on chain or update OPERATOR_SMART_WALLET / NEXT_PUBLIC_PLATFORM_COLLECTION env.',
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      )
    }
  })()

  // Drift detector for the inprocess /smartwallet lookup (the per-creator wallet
  // that executes /moment/create). Fire-and-forget so a slow upstream can't
  // delay serving — it only logs. See assertSmartWalletResolves.
  void (async () => {
    try {
      const { assertSmartWalletResolves } = await import('@/lib/healthcheck')
      await assertSmartWalletResolves()
    } catch (err) {
      console.error('[instrumentation] smart-wallet resolve healthcheck failed (non-fatal):', err)
    }
  })()

  // Warm the L1 caches every read-side route hits so the first request after
  // boot finds them hot. Fire-and-forget + per-getter try/catch so a transient
  // Redis blip at boot never delays serving. (created-mints needs no warmup:
  // the Mints-feed filter reads it via bounded per-request SMISMEMBER —
  // getCreatedMintsMembership in lib/kv.ts — with no cache layer to warm.)
  void (async () => {
    try {
      await Promise.all([
        import('@/lib/kv').then((m) => Promise.all([m.getTrackedCollections(), m.getUserCollections()])),
        import('@/lib/hiddenMoments').then((m) => m.getHiddenMomentsSet()),
        import('@/lib/hiddenCollections').then((m) => m.getHiddenCollectionsSet()),
      ])
    } catch (err) {
      console.error('[instrumentation] cache warmup failed (non-fatal):', err)
    }
  })()

  // One-time backfill for cover-mint moments deployed before the
  // /api/collections POST path started writing setMomentMeta. Gated by a Redis
  // marker so steady-state cost is a single GET. Fire-and-forget so it never
  // blocks the listen. See the module docstring for the full rationale.
  void (async () => {
    try {
      const { backfillCoverMomentMeta } = await import('@/lib/coverMomentMetaBackfill')
      await backfillCoverMomentMeta()
    } catch (err) {
      console.error('[instrumentation] cover-momentmeta backfill failed (non-fatal):', err)
    }
  })()

  // Periodic Redis cleanup (expired listings, old notifications, trending
  // zset trim) — only viable now on a long-running Node process. The .catch()
  // (not a try/catch) is what actually handles a dynamic-import rejection here,
  // since the import resolves asynchronously.
  void import('@/lib/backgroundTasks')
    .then((m) => m.startBackgroundTasks())
    .catch((err) =>
      console.error('[instrumentation] background tasks failed to start (non-fatal):', err),
    )

  // Memory telemetry. The production OOMs were diagnosed by inference because
  // nothing recorded the heap between crashes — these two lines make the next
  // incident self-evident from `docker logs` alone. The boot line answers "is
  // the heap flag live?" (heapLimitMb ≈ 4144 when --max-old-space-size=4096
  // applies; ~2000-8000 and drifting per Node version when it doesn't). The
  // periodic line tracks the climb: heapUsed for JS-heap growth, external +
  // arrayBuffers for the fetch-clone / Buffer class of leak that heapUsed
  // alone misses. unref() so the timer never holds the process open.
  void (async () => {
    try {
      const { getHeapStatistics } = await import('node:v8')
      const mb = (n: number) => Math.round(n / 1048576)
      console.log(
        '[mem] boot',
        JSON.stringify({
          node: process.version,
          heapLimitMb: mb(getHeapStatistics().heap_size_limit),
        }),
      )
      const tick = () => {
        const m = process.memoryUsage()
        console.log(
          '[mem]',
          JSON.stringify({
            rssMb: mb(m.rss),
            heapUsedMb: mb(m.heapUsed),
            heapTotalMb: mb(m.heapTotal),
            externalMb: mb(m.external),
            arrayBuffersMb: mb(m.arrayBuffers),
          }),
        )
      }
      const timer = setInterval(tick, 60_000)
      timer.unref()
    } catch (err) {
      console.error('[instrumentation] memory telemetry failed to start (non-fatal):', err)
    }
  })()
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Kick off boot tasks detached and return immediately so Next starts
  // listening without waiting on RPC/Redis. (register() is awaited before the
  // server accepts requests; keeping it instant is what keeps cold-start and
  // every restart's dark window short.) Each boot task is individually
  // try/catch-guarded; Next's own unhandledRejection handler is the backstop.
  startBootTasks()
}
