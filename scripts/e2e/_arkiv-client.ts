// lib/arkiv/client.ts for scripts/e2e/drops-flow.ts: the real module, except
// that the harness decides whether the writer is funded (the real check reads
// the writer's tGLM balance on Rabdi — drops-arkiv-live.ts runs that one).
// @ts-expect-error -- `?real` is resolved to lib/arkiv/client.ts by drops-flow-hooks.mjs
export * from '../../lib/arkiv/client.ts?real'

export const writerFunds = { funded: true }

export async function writerIsFunded(): Promise<boolean> {
  return writerFunds.funded
}
