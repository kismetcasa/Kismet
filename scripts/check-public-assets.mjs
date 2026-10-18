import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Fails the build, loudly, when pdf.js's runtime files are not in public/
// (ZINE_READER_DESIGN.md §26). They are copied there by npm's postinstall
// (scripts/copy-pdfjs-assets.mjs), so a deploy path that builds in a tree it
// did not install in — a Docker stage that carries only node_modules across —
// ships a site whose zine reader cannot load its worker, and nothing else
// notices until a reader taps "read". Runs as `prebuild`.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = 'run `node scripts/copy-pdfjs-assets.mjs`'
const problems = []

for (const rel of ['public/pdfjs/pdf.worker.min.mjs', 'public/pdfjs/wasm', 'public/pdfjs/standard_fonts', 'public/pdfjs/cmaps', 'public/pdfjs/iccs']) {
  if (!existsSync(resolve(ROOT, rel))) problems.push(`${rel} is missing — ${FIX}`)
}

// pdf.js refuses a worker of any version but the API's own, so a stale copy
// is as broken as a missing one.
const worker = resolve(ROOT, 'public/pdfjs/pdf.worker.min.mjs')
if (existsSync(worker)) {
  const { version } = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/pdfjs-dist/package.json'), 'utf8'))
  if (!readFileSync(worker, 'utf8').includes(`"${version}"`)) {
    problems.push(`public/pdfjs/pdf.worker.min.mjs is not pdfjs-dist ${version}'s worker — ${FIX}`)
  }
}

if (problems.length) {
  console.error(`check-public-assets: the build would ship a zine reader that cannot start:\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('check-public-assets: OK (pdf.js worker and assets present, version matches)')
