import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Copies @ffmpeg/core's single-threaded UMD bundle to public/ffmpeg-core/ so
// the browser can fetch it same-origin. Self-hosting avoids the CSP/CORS
// constraints of pulling from unpkg/jsdelivr at runtime, and the ~30MB is
// only paid by users who actually pick a GIF (the loader is dynamic-imported).
const src = resolve(ROOT, 'node_modules/@ffmpeg/core/dist/umd')
const dst = resolve(ROOT, 'public/ffmpeg-core')

if (!existsSync(src)) {
  // Don't fail the install — `npm ci` runs scripts before all deps are
  // resolvable in some edge cases, and `npm install` for a fresh checkout
  // hits this path before @ffmpeg/core is unpacked. The build itself will
  // fail loudly if the files are still missing then.
  console.warn(`[copy-ffmpeg-core] ${src} not found — skipping`)
  process.exit(0)
}

mkdirSync(dst, { recursive: true })
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  cpSync(resolve(src, f), resolve(dst, f))
}
console.log('[copy-ffmpeg-core] copied to public/ffmpeg-core/')
