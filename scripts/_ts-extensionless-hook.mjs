// The resolve hook itself (loaded off-thread by register() in the sibling
// loader). Rewrites a relative specifier that omits its extension to the `.ts`
// file when one exists; everything else falls through to Node's default
// resolver untouched. Only `resolve` is overridden, so `--experimental-strip-types`
// still applies in the default load step.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.[cm]?[jt]s$/.test(specifier) &&
    context.parentURL
  ) {
    try {
      const candidate = new URL(specifier + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(specifier + '.ts', context)
      }
    } catch {
      // fall through to default resolution
    }
  }
  return nextResolve(specifier, context)
}
