#!/usr/bin/env node
// Bundle-size regression guard. Computes total JS bytes per CLIENT
// route from the Next.js app-build-manifest and compares each against
// a baseline checked into git. Fails CI on growth past GROWTH_THRESHOLD.
//
// Above industry standard in a few specific ways:
//  - PER-ROUTE tracking, not just shared-chunk total. A page-specific
//    regression in one route shouldn't be hidden by a stable shared
//    total.
//  - PERCENT growth, not absolute byte limits. Absolute caps age badly
//    as legitimate dependencies grow; percent thresholds keep flagging
//    actual regressions for the life of the codebase.
//  - Baseline checked into git as JSON. PR diffs make the size change
//    explicit — reviewers see "this PR bumped /mint from 372KB to
//    410KB (10.2%)" right alongside the .ts changes that caused it.
//  - API routes filtered out: they ship no client JS that matters for
//    bundle size; including them just adds noise.
//
// Run: node scripts/check-bundle-size.mjs           # compare vs baseline
//      node scripts/check-bundle-size.mjs --update  # write new baseline
//      node scripts/check-bundle-size.mjs --report  # print sizes only

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(import.meta.dirname, '..')
const MANIFEST_PATH = path.join(ROOT, '.next', 'app-build-manifest.json')
const BASELINE_PATH = path.join(ROOT, 'bundle-baseline.json')
const STATIC_DIR = path.join(ROOT, '.next')

// Default threshold: 10% growth on any route fails. Override via
// GROWTH_THRESHOLD env if a legit dep bump pushes a route over.
const GROWTH_THRESHOLD = Number(process.env.GROWTH_THRESHOLD ?? 0.10)

// Skip API routes (no client JS payload matters) and Next internal
// pages (/_not-found, /_error, etc.) — they don't reflect the surface
// users actually load.
function isUserFacingRoute(route) {
  if (route.startsWith('/api/')) return false
  if (route.startsWith('/_')) return false
  // Layout/@modal aren't navigated to directly but compose into user
  // routes; keep them as their growth affects all pages.
  return true
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`bundle-size: manifest not found at ${MANIFEST_PATH}`)
    console.error('Run `npm run build` first, then re-run this check.')
    process.exit(2)
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
}

function fileSize(relPath) {
  const full = path.join(STATIC_DIR, relPath)
  try {
    return fs.statSync(full).size
  } catch {
    return 0
  }
}

function computeRouteSizes() {
  const manifest = loadManifest()
  const sizes = {}
  for (const [route, chunks] of Object.entries(manifest.pages ?? {})) {
    if (!isUserFacingRoute(route)) continue
    // Sum every chunk this route references. Some chunks are shared
    // across multiple routes — that's intentional: a regression in
    // the shared bundle affects every route's first-load JS, so each
    // route's score should reflect the full payload.
    let total = 0
    for (const chunk of chunks) {
      if (chunk.endsWith('.js')) total += fileSize(chunk)
    }
    sizes[route] = total
  }
  return sizes
}

function formatKB(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`
}

function pct(ratio) {
  return `${(ratio * 100).toFixed(1)}%`
}

const args = new Set(process.argv.slice(2))

const sizes = computeRouteSizes()

if (args.has('--report')) {
  console.log('Per-route bundle sizes:')
  for (const [route, size] of Object.entries(sizes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${formatKB(size).padStart(8)}  ${route}`)
  }
  process.exit(0)
}

if (args.has('--update')) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({
    note: 'Per-route JS bundle baseline. Regenerate with: npm run check:bundle -- --update. Bump intentionally when adding dependencies; reviewers see the diff alongside code changes.',
    threshold: GROWTH_THRESHOLD,
    routes: sizes,
  }, null, 2) + '\n')
  console.log(`bundle-size: baseline updated → ${path.relative(ROOT, BASELINE_PATH)}`)
  for (const [route, size] of Object.entries(sizes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${formatKB(size).padStart(8)}  ${route}`)
  }
  process.exit(0)
}

// Default: compare vs baseline
if (!fs.existsSync(BASELINE_PATH)) {
  console.error('bundle-size: no baseline. Run with --update to create one:')
  console.error('  npm run check:bundle -- --update')
  process.exit(2)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
const baselineRoutes = baseline.routes ?? {}
const threshold = baseline.threshold ?? GROWTH_THRESHOLD

const offenders = []
const newRoutes = []
for (const [route, size] of Object.entries(sizes)) {
  const prev = baselineRoutes[route]
  if (prev === undefined) {
    newRoutes.push({ route, size })
    continue
  }
  if (prev === 0) continue
  const ratio = (size - prev) / prev
  if (ratio > threshold) {
    offenders.push({ route, before: prev, after: size, ratio })
  }
}

if (newRoutes.length > 0) {
  console.log('\nbundle-size: new routes (not in baseline yet):')
  for (const { route, size } of newRoutes) {
    console.log(`  + ${formatKB(size).padStart(8)}  ${route}`)
  }
  console.log('Run `npm run check:bundle -- --update` to add them to the baseline.\n')
}

if (offenders.length === 0) {
  console.log('bundle-size: OK (no route grew past the threshold)')
  process.exit(0)
}

console.error(`\nbundle-size: ${offenders.length} route(s) grew past the +${pct(threshold)} threshold:\n`)
for (const { route, before, after, ratio } of offenders.sort((a, b) => b.ratio - a.ratio)) {
  const delta = after - before
  console.error(`  ${route}`)
  console.error(`    ${formatKB(before)} → ${formatKB(after)}  (+${formatKB(delta)}, +${pct(ratio)})`)
}
console.error('')
console.error('If the growth is intentional (new feature, dep bump, etc.), regenerate the baseline:')
console.error('  npm run check:bundle -- --update')
console.error('Reviewers will see the baseline diff in the PR alongside the source change.\n')
process.exit(1)
