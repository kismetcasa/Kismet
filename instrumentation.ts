/**
 * Next.js instrumentation hook — runs once per cold start before any
 * request is served. We use it to (1) install a process-level crash net
 * and (2) surface on-chain permission invariants (see lib/healthcheck.ts)
 * so misconfigs show up in function logs immediately rather than at first
 * user mint.
 *
 * Critical: never blocks serving. Next AWAITS register() before it starts
 * listening, so anything awaited here pads every cold-start / restart dark
 * window and — if a boot dependency hangs — can keep the liveness probe
 * unservable. Everything that isn't required to serve the first request is
 * therefore kicked off fire-and-forget; register() returns immediately.
 */
let safetyNetInstalled = false

/**
 * Process-level safety net. Next.js catches errors thrown INSIDE a request
 * handler, but an unhandled rejection or uncaught exception raised OUTSIDE
 * that boundary (a background setInterval sweep, an after() callback, a
 * stream 'error' event) would otherwise terminate the single container in
 * Node 22 — a full-site outage with no peer to absorb it.
 *
 * Single-instance policy (deliberate, and the inverse of the textbook
 * "always crash on unhandledRejection" advice — that advice assumes N
 * replicas behind a load balancer; we have exactly one pod):
 *   - unhandledRejection → LOG and CONTINUE. A stray rejection in
 *     fire-and-forget background work must not dark the whole site. Logging
 *     it loudly is how it gets fixed at the source.
 *   - uncaughtException → the process is in an undefined state (Node docs),
 *     so LOG and EXIT(1) for a clean restart. This is only safe because the
 *     container is configured to auto-restart on crash (Coolify restart
 *     policy / Docker `restart: unless-stopped` — see Dockerfile deploy
 *     notes). With it, MTTR is seconds; without it, exiting would dark the
 *     site until a manual redeploy, so the restart policy is REQUIRED.
 */
function installProcessSafetyNet(): void {
  if (safetyNetInstalled) return
  safetyNetInstalled = true

  process.on('unhandledRejection', (reason) => {
    console.error(
      '[process] unhandledRejection (non-fatal — logging and continuing; fix the source):',
      reason instanceof Error ? (reason.stack ?? reason.message) : reason,
    )
  })

  process.on('uncaughtException', (err) => {
    console.error(
      '[process] uncaughtException (fatal — process is in an undefined state, exiting for a clean restart):',
      err instanceof Error ? (err.stack ?? err.message) : err,
    )
    // Exit so the orchestrator restarts a fresh process. REQUIRES a container
    // restart policy; see installProcessSafetyNet's docstring above.
    process.exit(1)
  })
}

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
  // Redis blip at boot never delays serving. NOTE: getCreatedMintsSet() is
  // deliberately NOT warmed here — it is an unbounded SMEMBERS that grows with
  // every mint ever and hard-fails past Upstash's 10MB request cap; warming it
  // would spike boot memory and add a failure surface for zero benefit (the
  // standalone Mints feed lazy-loads it on first read and already degrades
  // gracefully if the read throws — see app/api/timeline/route.ts).
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
  // zset trim) — only viable now on a long-running Node process.
  try {
    void import('@/lib/backgroundTasks').then((m) => m.startBackgroundTasks())
  } catch (err) {
    console.error('[instrumentation] background tasks failed to start (non-fatal):', err)
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Install the crash net FIRST and synchronously, before any other code can
  // schedule async work that might reject.
  installProcessSafetyNet()

  // Kick off boot tasks detached and return immediately so Next starts
  // listening without waiting on RPC/Redis. (register() is awaited before the
  // server accepts requests; keeping it instant is what keeps cold-start and
  // every restart's dark window short.)
  startBootTasks()
}
