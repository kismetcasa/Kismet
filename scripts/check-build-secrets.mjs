#!/usr/bin/env node
// Fail-closed guard: aborts `next build` if a SERVER-ONLY secret is present in
// the build environment.
//
// WHY: Coolify (and most CI/CD) expose build-time env vars to Docker as
// `--build-arg`s. Build args are printed in build logs and are recoverable
// from image layers (`docker history`) — so any secret marked build-time is
// leaked. The 2026 incident leaked exactly these via Coolify's build-arg
// injection. The app reads every one of these at RUNTIME (see lib/*, API
// routes), so the build never needs them; if one is present here, it's a
// misconfiguration that WILL leak it.
//
// Fix when this fires: in Coolify, mark the listed vars RUNTIME-only (uncheck
// "Build Variable" / remove from build args). Keep only NEXT_PUBLIC_* build-
// time — those are compiled into the client bundle and are public by design,
// so they are intentionally NOT checked here.
//
// Runs as the `prebuild` npm hook, so it gates every `next build` (Docker, CI,
// local). CI/local builds have no secrets set → it passes silently.

const SERVER_SECRETS = [
  'ARWEAVE_JWK',
  'CDP_WALLET_SECRET',
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'CDP_PAYMASTER_URL',
  'INPROCESS_API_KEY',
  'UPSTASH_REDIS_REST_TOKEN',
  'ALCHEMY_WEBHOOK_SIGNING_KEY',
]

const present = SERVER_SECRETS.filter((k) => {
  const v = process.env[k]
  return typeof v === 'string' && v.trim().length > 0
})

if (present.length > 0) {
  console.error(
    '\n✖ BUILD ABORTED — server secrets are present at build time:\n' +
      present.map((k) => `      - ${k}`).join('\n') +
      '\n\n  Build-time env vars are injected as Docker --build-arg, which leak into\n' +
      '  build logs and image layers. These are RUNTIME-only — the build does not\n' +
      '  need them.\n\n' +
      '  Fix: in Coolify, mark each var above as runtime-only (uncheck "Build\n' +
      '  Variable"). Keep only NEXT_PUBLIC_* build-time. Then rotate any secret\n' +
      '  that was previously built — it was already exposed in prior build logs.\n',
  )
  process.exit(1)
}

console.log('[check-build-secrets] OK — no server secrets in the build environment')
