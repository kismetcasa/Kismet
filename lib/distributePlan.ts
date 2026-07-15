// Pure selection logic for "distribute all": given every split an artist is a
// payee on (with the split's live ETH/USDC balance and the artist's allocation),
// pick the CAP most-valuable ones to distribute this invocation. Deterministic
// and IMPORT-FREE so it unit-verifies under `node --experimental-strip-types`
// without redis/rpc — the on-chain resolution and the fan-out live in the route.
//
// Why a cap + value-ordering: distribution is a platform-sponsored on-chain tx
// per split, so an unbounded fan-out over an artist with dozens of moments is a
// burst on the single relay/box. Capping each invocation at CAP and taking the
// artist's HIGHEST-$ splits first means one click settles the money that matters
// most; the next click naturally picks up the following CAP (the just-distributed
// splits are now empty, so they drop out of the balance>0 filter). See
// DISTRIBUTE_ALL_CAP.

export const DISTRIBUTE_ALL_CAP = 20

export interface SplitJob {
  collection: string
  tokenId: string
  splitAddress: string
  /** The artist's allocation on this split, a whole percent 1–100. */
  pct: number
  /** Live ETH balance sitting on the split contract (wei). */
  ethWei: bigint
  /** Live USDC balance sitting on the split contract (6-dp base units). */
  usdcBase: bigint
}

/**
 * The artist's own share of a split's balance, valued in USD for ordering.
 * ETH is priced at `ethUsd` (null → the ETH leg contributes 0 to the ordering
 * key, a rare price-outage edge that only reshuffles order, never drops a job).
 * Number() is fine here: this is a sort key, not a ledger figure.
 */
export function jobArtistUsd(job: SplitJob, ethUsd: number | null): number {
  const share = job.pct / 100
  const ethShare = (Number(job.ethWei) / 1e18) * share
  const usdcShare = (Number(job.usdcBase) / 1e6) * share
  return (ethUsd != null ? ethShare * ethUsd : 0) + usdcShare
}

/**
 * Select the CAP jobs to distribute this invocation: only those with a live
 * balance, ordered by the artist's own $ share descending, tie-broken by
 * splitAddress so repeat runs are stable (and a second click deterministically
 * advances to the next CAP once the top ones are drained). Pure.
 */
export function planDistributeAll(
  jobs: SplitJob[],
  ethUsd: number | null,
  cap: number = DISTRIBUTE_ALL_CAP,
): SplitJob[] {
  return jobs
    .filter((j) => j.ethWei > 0n || j.usdcBase > 0n)
    .map((j) => ({ j, v: jobArtistUsd(j, ethUsd) }))
    .sort((a, b) => b.v - a.v || (a.j.splitAddress < b.j.splitAddress ? -1 : 1))
    .slice(0, Math.max(0, cap))
    .map((x) => x.j)
}

/** The (split, currency) units a selected job expands into — one distribute
 *  call each, only for currencies that actually hold a balance. */
export function jobCurrencies(job: SplitJob): ('eth' | 'usdc')[] {
  const out: ('eth' | 'usdc')[] = []
  if (job.ethWei > 0n) out.push('eth')
  if (job.usdcBase > 0n) out.push('usdc')
  return out
}
