// Resolution hooks for scripts/e2e/drops-flow.ts, chained in front of
// scripts/ts-alias-hooks.mjs (the `@/` alias, `.ts` resolution, `server-only`).
//
// The flow harness drives the REAL route handlers in-process, so two things
// the verify loader deliberately leaves out are needed here:
//
//   1. `next/server` → _next-server.mjs: Next's real NextRequest and
//      NextResponse (they load on bare Node), with `after` on the microtask
//      queue as the verify loader has it. The verify loader stops at `after`
//      because a verifier should drive libraries, not routes.
//   2. Two modules swapped for in-memory doubles, at the boundary where the
//      app leaves this process for a service the sandbox can't use:
//        lib/arkiv/drops.ts        → _arkiv-memory.ts   (Arkiv writes need a
//                                    funded testnet key; the real queries are
//                                    checked against Rabdi by drops-arkiv-live.ts)
//        lib/arweave/uploadServer  → _arweave-memory.ts (Turbo needs a funded
//                                    platform wallet)
//      and lib/arkiv/client.ts → _arkiv-client.ts, which re-exports the real
//      module but lets the harness decide whether the writer is funded.
//
// A double imports the module it replaces with `?real`, which resolves to the
// real file untouched.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const here = import.meta.dirname
const root = path.resolve(here, '../..')
const swaps = new Map([
  [pathToFileURL(path.join(root, 'lib/arkiv/drops.ts')).href, pathToFileURL(path.join(here, '_arkiv-memory.ts')).href],
  [pathToFileURL(path.join(root, 'lib/arkiv/client.ts')).href, pathToFileURL(path.join(here, '_arkiv-client.ts')).href],
  [pathToFileURL(path.join(root, 'lib/arweave/uploadServer.ts')).href, pathToFileURL(path.join(here, '_arweave-memory.ts')).href],
])

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return { url: pathToFileURL(path.join(here, '_next-server.mjs')).href, shortCircuit: true }
  if (specifier.endsWith('?real')) return nextResolve(specifier.slice(0, -'?real'.length), context)
  const resolved = await nextResolve(specifier, context)
  const swap = swaps.get(resolved.url)
  return swap ? { ...resolved, url: swap, shortCircuit: true } : resolved
}
