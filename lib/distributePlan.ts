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
// every read here used to resolve (1) alone. In Process's moment-manage
// Splits tab (in_process_web `b68d0d3`, 2026-08-19) now creates a split
// post-mint and points ONLY pointer (2) at it — its handleCreate calls
// `setSale(..., { fundsRecipient: splitAddress })` and never touches the
// token-level recipient — so the two pointers diverge on exactly the moments
// that feature touches, leaving real proceeds on a contract Kismet never
// looked at ("nothing to distribute" on a funded split, or a distribute aimed
// at the wrong pot). Resolve BOTH everywhere and let the balance filter
// decide which actually holds money.
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

// The EXACT runtime bytecode of an In Process split contract on Base: a
// Splits v2 minimal proxy delegating to the implementation embedded in the
// code (0x1e2086…b708; In Process's SplitV2Client leaves the SDK's default
// split type, Pull, so these are PullSplits). VERBATIM COPY
// of the reference constant in In Process's own gate — in_process_api,
// src/lib/splits/isSplitContract.ts — which their GET /splits distribute
// endpoint checks before distributing anything ("Invalid split contract
// address" otherwise). Mirroring their constant byte-for-byte means our
// "distributable" predicate can never admit an address their endpoint would
// reject, nor hide one it would accept.
//
// NOT v1: In Process creates every split (mint-time via processSplits AND the
// manage page via POST /splits) with @0xsplits/splits-sdk's SplitV2Client, so
// a v1-style splitMain() probe would reject every real In Process split. If
// In Process ever migrates implementations, this constant must move in
// lockstep with theirs — the failure mode is fail-closed (an unprobed split
// stops being offered), never a wrong distribute.
export const INPROCESS_SPLIT_BYTECODE =
  '0x36602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b3d3d3d3d363d3d37363d731e2086a7e84a32482ac03000d56925f607ccb7085af43d3d93803e605757fd5bf3'

/** The one viem-client capability the probe needs, stated structurally so
 *  this module stays import-free (verified by scripts/verify-distribute.ts);
 *  both the server client and wagmi's usePublicClient satisfy it. */
export interface TargetProbeClient {
  getCode: (args: { address: `0x${string}` }) => Promise<`0x${string}` | undefined>
}

/** True when `addr` is a split contract In Process's distribute endpoint will
 *  accept — its exact bytecode-equality gate, mirrored. Any failure (EOA,
 *  other contract, RPC hiccup) is false: this only ever ADMITS targets, so
 *  failing closed can't take away coverage that already exists. */
async function isInProcessSplit(client: TargetProbeClient, addr: string): Promise<boolean> {
  try {
    const code = await client.getCode({ address: addr as `0x${string}` })
    return typeof code === 'string' && code.toLowerCase() === INPROCESS_SPLIT_BYTECODE
  } catch {
    return false
  }
}

/**
 * Narrow a moment's on-chain payout targets to the ones that can actually be
 * distributed.
 *
 * `trustPrimary` says a Kismet mint-time split record exists for this moment.
 * When it does, the PRIMARY target (creator-reward recipient, index 0) passes
 * through unprobed — that is the pointer every read here has used since splits
 * shipped, so behaviour on the entire existing corpus is unchanged (and zero
 * extra RPC in the common case). Every other candidate has to earn its place
 * by matching In Process's split bytecode:
 *
 *   • an ADDITIONAL target (a sale strategy's fundsRecipient) is new here, and
 *     if a moment's sale row still points at the artist's own wallet, admitting
 *     it would surface that wallet's whole balance as "to distribute" and burn
 *     distribute quota on calls upstream rejects;
 *   • with NO record, the primary is just as likely to be a plain payout wallet
 *     — the Redis record used to be the only thing standing between a
 *     non-split moment and a distribute button over the creator's own balance.
 *
 * Costs nothing in the common case: the two pointers agree on a Kismet split
 * mint, so `targets` has length 1, `trustPrimary` is true, and no probe runs.
 */
export async function filterDistributableTargets(
  client: TargetProbeClient,
  targets: readonly string[],
  // No default on purpose: whether the primary is trusted is a per-call-site
  // security decision (it hinges on a Kismet record existing), and a silent
  // default would default in the permissive direction.
  opts: { trustPrimary: boolean },
): Promise<string[]> {
  if (targets.length === 0) return []
  if (opts.trustPrimary && targets.length === 1) return [...targets]
  const probed = await Promise.all(
    targets.map(async (t, i) =>
      opts.trustPrimary && i === 0 ? t : (await isInProcessSplit(client, t)) ? t : null,
    ),
  )
  return probed.filter((t): t is string => t !== null)
}
