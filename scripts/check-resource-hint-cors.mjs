#!/usr/bin/env node
// Catch the specific bug pattern fixed in commits 00ba5c5 and d1145a9:
// a <link rel="preconnect"> or <link rel="preload"> whose CORS mode
// doesn't match what consumes it. The hint then feeds a different
// connection-pool entry / cache partition than the actual fetch reads
// from — silently wasting the preconnect.
//
// Why a custom script vs an ESLint rule:
//   - ESLint runs per-file. The <link> tag lives in one file, its
//     consumer (a <video>/<img>/fetch call) lives in another. A standard
//     rule can't correlate across files.
//   - This is a single, well-known bug pattern in this codebase — we
//     don't need a generic plugin, just a targeted scan.
//
// Heuristic, not perfect. Uses regex over .ts/.tsx to extract:
//   - <link rel="preconnect|preload" href="<origin>" [crossorigin]>
//   - <video> / <img> elements with explicit src or that reference
//     the same origin
//   - fetch('https://...') calls (always cors-mode for cross-origin)
//
// Then warns when:
//   - A link uses crossorigin but no consumer for the same origin uses
//     crossorigin (the link's pool entry sits unused).
//   - A link omits crossorigin and the origin is consumed by fetch()
//     (cors by default) — same issue inverted.
//
// Run: node scripts/check-resource-hint-cors.mjs
// Wired into npm run check via package.json.

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'public'])

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

function originOf(url) {
  try {
    if (!url || url.startsWith('${') || url.startsWith('${`')) return null
    if (!url.startsWith('http')) return null
    return new URL(url).origin
  } catch { return null }
}

// Hint: <link rel="preconnect|preload" href={...} crossOrigin={...}>
// Attribute order is flexible; we use a loose match per attribute.
const LINK_RE = /<link\b([^>]+?)\/?>/g
const REL_ATTR = /\brel\s*=\s*['"](\w[\w\-]*)['"]/i
const HREF_ATTR = /\bhref\s*=\s*['"]([^'"]+)['"]/i
const CROSSORIGIN_ATTR = /\bcross[Oo]rigin\s*=\s*['"]?([^\s/'">]*)['"]?/i

// Video: <video> with explicit src — only catches static src strings, not
// InlineVideo's dynamic gateway src. InlineVideo's <video> is no-cors by
// default (no crossOrigin), matching the non-crossorigin arweave preconnect;
// audited manually. This script catches NEW link/video pairs added later.
const VIDEO_TAG_RE = /<video\b([^>]+?)(?:\/?>|>)/g
const IMG_TAG_RE = /<img\b([^>]+?)(?:\/?>|>)/g
const SRC_ATTR = /\bsrc\s*=\s*['"]([^'"]+)['"]/i

// fetch('http...') call — cors-mode by default for cross-origin URLs.
// Multiline-resilient via a permissive pattern.
const FETCH_RE = /\bfetch\s*\(\s*['"`](https?:\/\/[^'"`]+)['"`]/g

const links = []      // { file, line, rel, href, origin, crossorigin }
const consumers = []  // { file, line, kind, origin, crossorigin }

for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8')
  const rel = path.relative(ROOT, file)
  const lines = src.split('\n')

  // Lookup of line number from byte offset — cheap because lint runs
  // once per CI invocation, not at edit time.
  const offsetToLine = (offset) => {
    let count = 0
    for (let i = 0; i < lines.length; i++) {
      count += lines[i].length + 1
      if (offset < count) return i + 1
    }
    return lines.length
  }

  // Links
  for (const m of src.matchAll(LINK_RE)) {
    const attrs = m[1]
    const relMatch = attrs.match(REL_ATTR)
    const r = relMatch?.[1]?.toLowerCase()
    if (r !== 'preconnect' && r !== 'preload') continue
    const href = attrs.match(HREF_ATTR)?.[1]
    const origin = originOf(href ?? '')
    if (!origin) continue
    const co = attrs.match(CROSSORIGIN_ATTR)
    // crossorigin without a value defaults to "anonymous" — treat both as cors
    const crossorigin = co ? (co[1] || 'anonymous') : null
    links.push({ file: rel, line: offsetToLine(m.index), rel: r, href, origin, crossorigin })
  }

  // Video tags with explicit string src
  for (const m of src.matchAll(VIDEO_TAG_RE)) {
    const attrs = m[1]
    const href = attrs.match(SRC_ATTR)?.[1]
    const origin = originOf(href ?? '')
    if (!origin) continue
    const co = attrs.match(CROSSORIGIN_ATTR)
    const crossorigin = co ? (co[1] || 'anonymous') : null
    consumers.push({ file: rel, line: offsetToLine(m.index), kind: 'video', origin, crossorigin })
  }

  // Img tags with explicit string src
  for (const m of src.matchAll(IMG_TAG_RE)) {
    const attrs = m[1]
    const href = attrs.match(SRC_ATTR)?.[1]
    const origin = originOf(href ?? '')
    if (!origin) continue
    const co = attrs.match(CROSSORIGIN_ATTR)
    const crossorigin = co ? (co[1] || 'anonymous') : null
    consumers.push({ file: rel, line: offsetToLine(m.index), kind: 'img', origin, crossorigin })
  }

  // fetch() calls — default cors mode
  for (const m of src.matchAll(FETCH_RE)) {
    const origin = originOf(m[1])
    if (!origin) continue
    consumers.push({
      file: rel,
      line: offsetToLine(m.index),
      kind: 'fetch',
      origin,
      crossorigin: 'anonymous',  // fetch() defaults to cors for cross-origin
    })
  }
}

// Match links to consumers by origin. Report mismatches.
const issues = []
const consumersByOrigin = new Map()
for (const c of consumers) {
  const list = consumersByOrigin.get(c.origin) ?? []
  list.push(c)
  consumersByOrigin.set(c.origin, list)
}

for (const link of links) {
  const sameOriginConsumers = consumersByOrigin.get(link.origin) ?? []
  if (sameOriginConsumers.length === 0) {
    // No detectable consumer — could be SDK-internal (e.g., Quick Auth
    // fetching auth.farcaster.xyz; the fetch() call is inside the
    // bundled @farcaster/quick-auth code, not our source). Skip; we
    // can't verify in either direction.
    continue
  }
  // Are any same-origin consumers' crossorigin modes different from the link's?
  for (const c of sameOriginConsumers) {
    if (c.crossorigin !== link.crossorigin) {
      issues.push({ link, consumer: c })
    }
  }
}

if (issues.length === 0) {
  console.log('check-resource-hint-cors: OK (no detectable CORS-mode mismatches)')
  process.exit(0)
}

console.error('\ncheck-resource-hint-cors: CORS mode mismatch — the resource hint and its consumer use different request modes.')
console.error('The browser keys connection-pool entries + HTTP cache entries by CORS mode, so the hint feeds a partition the consumer never reads from.\n')
for (const { link, consumer } of issues) {
  console.error(`  HINT     ${link.file}:${link.line}  rel="${link.rel}" href="${link.href}" crossorigin=${link.crossorigin ?? '(none)'}`)
  console.error(`  CONSUMER ${consumer.file}:${consumer.line}  <${consumer.kind}> at the same origin uses crossorigin=${consumer.crossorigin ?? '(none)'}`)
  console.error('')
}
console.error('Fix one of:')
console.error('  - Drop the crossorigin attribute from the link (match no-cors consumer)')
console.error('  - Add crossorigin="anonymous" to the link (match cors consumer)')
console.error('  - Or document the deliberate mismatch with a comment + // hint-cors-ok pragma\n')
process.exit(1)
