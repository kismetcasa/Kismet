// Zero-dependency Node ESM resolution hooks so the agent calldata verifiers can
// import the REAL production builders (lib/agent/collect.ts et al.) instead of
// re-deriving the expected bytes by hand. Two things the bundler does in prod
// but Node's ESM resolver does not, and which this hook adds:
//
//   1. The `@/*` tsconfig path alias  →  <repo-root>/*   (tsconfig.json paths).
//   2. Extensionless specifiers (`./calldata`, and the aliased files) → `.ts`.
//
// Resolve-only: type stripping is left to Node's built-in `.ts` loader
// (unflagged-default since Node 22.18; the verify scripts also pass
// --experimental-strip-types explicitly). Kept dependency-free on purpose —
// the whole verify suite runs on bare `node`, with no tsx/ts-node/esbuild, and
// the repo's CI gates on a lean, audited dependency tree.
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

export async function resolve(specifier, context, nextResolve) {
  // Map the `@/` alias to an absolute file URL under the repo root.
  const mapped = specifier.startsWith('@/')
    ? pathToFileURL(path.join(root, specifier.slice(2))).href
    : specifier

  // Already carries a JS/TS extension → resolve as-is. Otherwise try the bare
  // specifier first (bare packages like `viem`, `node:` builtins resolve here),
  // then the `.ts` file and `.ts` index forms for our own source.
  const candidates = /\.[mc]?[jt]sx?$/.test(mapped)
    ? [mapped]
    : [mapped, `${mapped}.ts`, `${mapped}/index.ts`]

  let firstErr
  for (const candidate of candidates) {
    try {
      return await nextResolve(candidate, context)
    } catch (err) {
      if (firstErr === undefined) firstErr = err
    }
  }
  throw firstErr
}
