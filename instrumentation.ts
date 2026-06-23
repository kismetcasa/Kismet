/**
 * Next.js instrumentation hook — runs once per cold start before any
 * request is served. We use it to surface on-chain permission
 * invariants (see lib/healthcheck.ts) so misconfigs show up in
 * function logs immediately rather than at first user mint.
 *
 * Critical: never throws to userspace. An unhandled throw during
 * cold-start `register()` can leave the runtime in a hard-fail loop;
 * the healthcheck is observability, not a deploy gate. To enforce
 * fail-closed semantics, wire a build-time CI check or a deploy-
 * pipeline smoke test instead.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { assertPlatformCollectionAuthorized } = await import('@/lib/healthcheck')
    await assertPlatformCollectionAuthorized()
  } catch (err) {
    console.error(
      '[instrumentation] platform-collection healthcheck failed — site will continue serving but Kismet Casa mints into PLATFORM_COLLECTION may revert. Check logs and grant ADMIN on chain or update OPERATOR_SMART_WALLET / NEXT_PUBLIC_PLATFORM_COLLECTION env.',
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    )
  }

  // Drift detector for the inprocess /smartwallet lookup (the per-creator wallet
  // that executes /moment/create). Fire-and-forget so a slow upstream can't
  // delay cold-start serving — it only logs. See assertSmartWalletResolves.
  void (async () => {
    try {
      const { assertSmartWalletResolves } = await import('@/lib/healthcheck')
      await assertSmartWalletResolves()
    } catch (err) {
      console.error('[instrumentation] smart-wallet resolve healthcheck failed (non-fatal):', err)
    }
  })()

  // Warm the L1 caches every read-side route hits so the first request
  // after boot finds them hot. Non-fatal — per-getter try/catch returns
  // safe defaults if Redis is transiently down.
  try {
    await Promise.all([
      import('@/lib/kv').then((m) =>
        Promise.all([m.getTrackedCollections(), m.getUserCollections(), m.getCreatedMintsSet()]),
      ),
      import('@/lib/hiddenMoments').then((m) => m.getHiddenMomentsSet()),
      import('@/lib/hiddenCollections').then((m) => m.getHiddenCollectionsSet()),
    ])
  } catch (err) {
    console.error('[instrumentation] cache warmup failed (non-fatal):', err)
  }

  // One-time backfill for cover-mint moments deployed before the
  // /api/collections POST path started writing setMomentMeta. Gated by
  // a Redis marker so steady-state cost is a single GET. Safe to leave
  // here even after every existing record is filled — once the marker is
  // set the function short-circuits before doing any other work. See the
  // module docstring for the full rationale.
  try {
    const { backfillCoverMomentMeta } = await import('@/lib/coverMomentMetaBackfill')
    await backfillCoverMomentMeta()
  } catch (err) {
    console.error('[instrumentation] cover-momentmeta backfill failed (non-fatal):', err)
  }

  // Periodic Redis cleanup (expired listings, old notifications, trending
  // zset trim) — only viable now on a long-running Node process.
  try {
    const { startBackgroundTasks } = await import('@/lib/backgroundTasks')
    startBackgroundTasks()
  } catch (err) {
    console.error('[instrumentation] background tasks failed to start (non-fatal):', err)
  }
}
