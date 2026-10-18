import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Copies pdf.js's runtime assets to public/pdfjs/ so the browser fetches them
// same-origin (ZINE_READER_DESIGN.md §6; lib/pdfjs.ts reads them from
// PDFJS_ASSET_ROOT). Same shape as copy-ffmpeg-core.mjs, and for the same
// reasons — no third-party origin at runtime, CSP-clean — plus one that is
// specific to pdf.js: the API REFUSES a worker of a different version, so the
// worker must come from the exact package that was installed, never from a
// committed copy that can drift from package.json.
//
//   pdf.worker.min.mjs   the parser/renderer worker (legacy build, ~390 KB gz)
//   wasm/                JPEG 2000 (OpenJPEG), JBIG2 and ICC (qcms) decoders
//                        plus the JS fallbacks pdf.js loads from the same URL
//   standard_fonts/      the 14 base fonts, for PDFs that reference them
//                        without embedding
//   cmaps/               CJK encodings, fetched only when a PDF needs one
//   iccs/                a compatibility ICC profile
//
// ~4.5 MB on disk, nothing on the critical path: only the worker is fetched
// on a first open, the rest on demand.
const src = resolve(ROOT, 'node_modules/pdfjs-dist')
const dst = resolve(ROOT, 'public/pdfjs')

if (!existsSync(src)) {
  // Don't fail the install — see copy-ffmpeg-core.mjs for why. The build
  // fails loudly if the files are still missing (scripts/check-public-assets
  // .mjs, run as prebuild).
  console.warn(`[copy-pdfjs-assets] ${src} not found — skipping`)
  process.exit(0)
}

// Start clean so a version bump never leaves stale files beside new ones.
rmSync(dst, { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
cpSync(resolve(src, 'legacy/build/pdf.worker.min.mjs'), resolve(dst, 'pdf.worker.min.mjs'))
for (const dir of ['wasm', 'standard_fonts', 'cmaps', 'iccs']) {
  cpSync(resolve(src, dir), resolve(dst, dir), { recursive: true })
}
cpSync(resolve(src, 'LICENSE'), resolve(dst, 'LICENSE'))
const count = readdirSync(dst, { recursive: true }).length
console.log(`[copy-pdfjs-assets] copied ${count} entries to public/pdfjs/`)
