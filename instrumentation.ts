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
}
