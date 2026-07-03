/**
 * Registers Next's SECOND tee'd fetch clone with the FinalizationRegistry in
 * next/dist/{server,esm/server}/lib/clone-response.js — the upstream fix
 * (vercel/next.js PR #88577) that shipped only in the 16.x line and was never
 * backported to any 15.x release (verified against the published 15.5.19
 * tarball).
 *
 * Why this matters here: Next patches globalThis.fetch through a dedupe layer
 * (dedupe-fetch.js) that tees every signal-less server-side GET and parks the
 * second branch (`cloned2`) unread. In the unpatched file only `cloned1` is
 * registered for GC-time cancellation, so each such fetch strands one
 * full-response tee buffer — the ArrayBuffer/WriteWrap retention documented in
 * vercel/next.js #85914 and the class of growth behind our production
 * "JavaScript heap out of memory" crashes. Registering cloned2 makes GC cancel
 * the stranded branch, exactly as the 16.x fix does.
 *
 * Runs from postinstall, so both local installs and the Docker deps stage get
 * it, and the patched file is what `next build` traces into the standalone
 * output. Idempotent (marker check). Version-guarded: on next >= 16 the
 * upstream fix is present and this becomes a no-op. On any unexpected file
 * shape it WARNS LOUDLY and exits 0 rather than failing the install — an
 * unpatched dev install must not hard-block unrelated work; the [mem]
 * telemetry (instrumentation.ts) is the backstop that shows whether the leak
 * is live.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

let nextPkgPath
try {
  nextPkgPath = require.resolve('next/package.json')
} catch {
  console.log('[patch-next] next not installed — skipping')
  process.exit(0)
}
const nextRoot = path.dirname(nextPkgPath)
let nextVersion
try {
  nextVersion = JSON.parse(readFileSync(nextPkgPath, 'utf8')).version
} catch (err) {
  console.warn('[patch-next] WARNING: could not read next/package.json — skipping:', err)
  process.exit(0)
}

const major = Number(nextVersion.split('.')[0])
if (major >= 16) {
  console.log(`[patch-next] next@${nextVersion} carries the upstream clone-response fix — skipping`)
  process.exit(0)
}

const TARGETS = [
  path.join(nextRoot, 'dist/server/lib/clone-response.js'),
  path.join(nextRoot, 'dist/esm/server/lib/clone-response.js'),
]

// The fix: mirror the cloned1 registration for cloned2, inserted just before
// the final `return [cloned1, cloned2]`.
const MARKER = 'registry.register(cloned2'
const INSERTION = `    // [kismet patch] Upstream fix from vercel/next.js #88577: the cached/parked
    // second clone must also be cancelled when GC'd, or its tee buffer strands
    // the full response body (see scripts/patch-next-clone-response.mjs).
    if (registry && cloned2.body) {
        registry.register(cloned2, new WeakRef(cloned2.body));
    }
`
const RETURN_ANCHOR = /(\n)([ \t]*)return \[\s*\n?\s*cloned1,\s*\n?\s*cloned2\s*\n?\s*\];/

for (const target of TARGETS) {
  // Every failure mode inside the loop warns and continues — this script must
  // NEVER exit non-zero (it runs under `postinstall … && …`, so a throw here
  // would hard-fail npm ci / the Docker deps stage; e.g. a read-only
  // node_modules under pnpm or a cached layer makes writeFileSync throw).
  try {
    if (!existsSync(target)) {
      console.warn(`[patch-next] WARNING: ${target} not found — file layout changed?`)
      continue
    }
    const src = readFileSync(target, 'utf8')
    if (src.includes(MARKER)) {
      console.log(`[patch-next] already patched: ${path.relative(nextRoot, target)}`)
      continue
    }
    if (!src.includes('registry.register(cloned1') || !RETURN_ANCHOR.test(src)) {
      console.warn(
        `[patch-next] WARNING: ${path.relative(nextRoot, target)} does not match the expected ` +
          `next@15.x shape — NOT patched. The fetch-clone leak (vercel/next.js #85914) may be ` +
          `live; watch the [mem] arrayBuffersMb telemetry and update this script for next@${nextVersion}.`,
      )
      continue
    }
    const out = src.replace(RETURN_ANCHOR, `$1${INSERTION}$2return [\n$2    cloned1,\n$2    cloned2\n$2];`)
    writeFileSync(target, out)
    console.log(`[patch-next] patched ${path.relative(nextRoot, target)} (next@${nextVersion})`)
  } catch (err) {
    console.warn(`[patch-next] WARNING: failed to patch ${target} — continuing:`, err)
  }
}
process.exit(0)
