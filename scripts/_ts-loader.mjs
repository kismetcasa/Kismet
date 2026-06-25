import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Minimal resolve hook so verify scripts can import REAL lib modules under
// `node --experimental-strip-types`. The repo imports siblings extensionlessly
// ('./inprocess') and via the '@/' alias ('@/lib/x'), neither of which Node's
// ESM resolver understands — map both to the on-disk .ts file. Packages,
// node: builtins, and explicit extensions fall through to the default resolver.
//
// Usage: node --experimental-strip-types --import ./scripts/_ts-loader.mjs <script>.ts

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')

registerHooks({
  resolve(specifier, context, nextResolve) {
    let target = null
    if (specifier.startsWith('@/')) {
      target = resolvePath(ROOT, specifier.slice(2))
    } else if (specifier.startsWith('.') && !/\.([mc]?[jt]s|json)$/.test(specifier)) {
      target = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier)
    }
    if (target && existsSync(target + '.ts')) {
      return nextResolve(pathToFileURL(target + '.ts').href, context)
    }
    return nextResolve(specifier, context)
  },
})
