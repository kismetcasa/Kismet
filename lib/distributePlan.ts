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
  /** Representative moment for this split — the FIRST-SEEN of possibly many
   *  moments paying into the same contract (see dedupeBySplitAddress). */
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
 * Collapse per-moment split entries onto UNIQUE split contracts. 0xSplits
 * addresses are deterministic — identical recipients + allocations deploy to
 * the same contract — so a collab minting several pieces with one split config
 * produces many moments (even across collections) whose creator-reward
 * recipient is one shared pot. Counting per moment then counts that pot once
 * PER MOMENT: the pending roll-up showed N× the artist's real share and
 * distribute-all fired N duplicate calls at one contract (confirmed in
 * production 2026-07-17: five moments → one split → a $2.50 share displayed
 * as $12.49).
 *
 * First-seen entry wins (order and identity fields preserved); the address key
 * is case-insensitive. Same address ⇒ same on-chain allocation, so the pcts
 * should agree — on a corrupt disagreement the group MINIMUM is kept, failing
 * toward under-report (the house rule for money figures). Generic so the
 * pre-balance-read entries in lib/pending.ts dedupe with this exact logic.
 */
export function dedupeBySplitAddress<T extends { splitAddress: string; pct: number }>(
  entries: T[],
): T[] {
  const byAddr = new Map<string, T>()
  for (const e of entries) {
    const k = e.splitAddress.toLowerCase()
    const existing = byAddr.get(k)
    if (!existing) byAddr.set(k, e)
    else if (e.pct < existing.pct) byAddr.set(k, { ...existing, pct: e.pct })
  }
  return [...byAddr.values()]
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

// ── on-chain payout targets ──────────────────────────────────────────────────
// A Zora 1155 moment has TWO INDEPENDENT on-chain payout pointers, and a split
// can sit behind either one:
//
//   1. `getCreatorRewardRecipient(tokenId)` — the TOKEN-level fundsRecipient
//      (falling back to the collection's, then owner()). Zora's protocol
//      creator rewards land here.
//   2. the active sale strategy's `salesConfig.fundsRecipient` (FPSS for ETH,
//      ERC20Minter for USDC) — where PAID MINT PROCEEDS land.
//
// Kismet's own mint flow sets both to the same 0xSplits wallet, which is why
// every read here used to resolve (1) alone. In Process's moment-manage page
// now lets an artist point a moment's fundsRecipient at a split AFTER mint, and
// nothing guarantees it writes both pointers — so the two can diverge, leaving
// real proceeds on a contract Kismet never looks at ("nothing to distribute" on
// a funded split, or a distribute aimed at the wrong pot). Resolve BOTH
// everywhere and let the balance filter decide which actually holds money.
//
// Pure + import-free like the rest of this module so scripts/verify-distribute
// covers it without viem/redis.

const ADDRESS_RE = /^0x[0-9a-f]{40}$/
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** One entry of a viem/wagmi multicall result set, narrowed to what we read. */
export interface ContractRead {
  status: 'success' | 'failure'
  result?: unknown
}

/**
 * Decode the three reads built by `payoutTargetCalls` (creator-reward
 * recipient, FPSS sale row, ERC20Minter sale row) into the moment's DEDUPED
 * payout targets, creator-reward recipient FIRST (the historical primary, so
 * single-target moments keep their exact previous behaviour).
 *
 * Zero and malformed addresses drop out, as do failed reads — a moment with no
 * sale row on a strategy decodes that strategy's tuple as all-zero, which is
 * exactly the "not configured" signal. Deliberately does NOT filter on
 * `saleEnd`: an ENDED sale still has a live fundsRecipient holding
 * undistributed proceeds.
 */
export function decodePayoutTargets(results: readonly ContractRead[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (v: unknown): void => {
    if (typeof v !== 'string') return
    const a = v.toLowerCase()
    if (!ADDRESS_RE.test(a) || a === ZERO_ADDRESS || seen.has(a)) return
    seen.add(a)
    out.push(a)
  }

  const reward = results[0]
  if (reward?.status === 'success') push(reward.result)

  // viem decodes a named-component tuple into an object; a positional decode
  // (ABI drift, older viem) yields an array with fundsRecipient at index 4 on
  // BOTH strategy tuples. Accept either rather than silently resolving nothing.
  for (const r of [results[1], results[2]]) {
    if (r?.status !== 'success' || !r.result || typeof r.result !== 'object') continue
    if (Array.isArray(r.result)) push(r.result[4])
    else push((r.result as { fundsRecipient?: unknown }).fundsRecipient)
  }
  return out
}
