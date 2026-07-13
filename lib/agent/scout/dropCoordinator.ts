/**
 * Drop coordinator (Phase 3) — the cross-user, fair-distribution half of agentic
 * collecting. Fired the instant a watched artist drops on our platform: it runs
 * from the post-mint / cover-mint hooks (lib/mint-proxy.ts and the
 * app/api/collections cover-mint), adjacent to markCreatedMint — our internal
 * "as soon as it drops" signal, so no external indexer is needed. It gathers every live agent
 * watching that artist, computes what each can take (their per-drop target +
 * budget + the per-wallet cap), then allocates the drop's supply ROUND-ROBIN
 * (everyone gets 1, then a 2nd, … — see allocate.ts) so a scarce drop spreads
 * evenly instead of the first agent grabbing it all. Each allocation is minted to
 * the user within their own bounded Spend Permission.
 *
 * Authoritative on-chain truth throughout: the drop's price/supply/per-wallet cap
 * and each watcher's remaining allowance are read live; the mint mints to the
 * USER (never the spender); the bounded permission is the hard cap regardless.
 */

import { getPermissionStatus } from '@base-org/account/spend-permission'
import type { Address, Hex } from 'viem'
import { redis } from '@/lib/redis'
import { serverBaseClient } from '@/lib/rpc'
import { fetchEligibleTokens } from '@/lib/saleConfig'
import { readMintFeeWithBound } from '@/lib/zoraMint'
import { writeNotification } from '@/lib/notifications'
import { expandToFidSiblings } from '@/lib/addressUnion'
import type { BatchCollectItem } from '@/lib/agent/collectBatch'
import { getWatchers, getScoutsBatch, getScout, saveScout, type ScoutRecord } from './store'
import { evaluateCandidate, type Candidate } from './engine'
import { allocateRoundRobin, fairOrder, OPEN_EDITION_SUPPLY, type DropWatcher } from './allocate'
import { collectViaSpendPermission } from './serverExecutor'
import { getScoutSpender, type ScoutSpender } from './spender'
import { isKillSwitchEngaged } from './killSwitch'

const lc = (s: string) => s.toLowerCase()

const ERC1155_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export interface DropCoordinationSummary {
  /** Live agents watching this artist that were considered. */
  watchers: number
  /** Total editions minted across all users. */
  collected: number
  /** Distinct users who received >= 1. */
  recipients: number
  reason?: string
}

interface Bidder {
  record: ScoutRecord
  owner: Address
  target: number
  affordable: number
  /** On-chain currentPeriod.start, captured during bidding — the authoritative
   *  anchor for both the policy item-cap gate and the post-collect usage bump. */
  periodStart: number
}

const empty = (watchers: number, reason: string): DropCoordinationSummary => ({ watchers, collected: 0, recipients: 0, reason })

/**
 * Coordinate one drop. `drop.creator` is the minting (artist) wallet; watchers are
 * those whose agent lists it. Best-effort throughout — any single failure skips
 * just that user, never the whole drop.
 */
export async function runDropCoordination(
  drop: { collection: string; tokenId: string; creator: string },
  baseUrl: string,
): Promise<DropCoordinationSummary> {
  const collection = drop.collection as Address
  const tokenId = BigInt(drop.tokenId)
  const creator = lc(drop.creator)

  // Emergency stop — fail CLOSED (lib/agent/scout/killSwitch).
  if (await isKillSwitchEngaged()) return empty(0, 'kill switch engaged')

  // 0. Coordinate each drop ONCE — a double markCreatedMint trigger must not
  //    double-collect. A SET-NX lock is the one-shot guard; any watcher this run
  //    misses is caught + balance-deduped by their on-open run, so locking a
  //    coordinated drop for a day is safe.
  const lockKey = `kismetart:scout-drop:${lc(drop.collection)}:${drop.tokenId}`
  try {
    if ((await redis.set(lockKey, '1', { nx: true, ex: 86_400 })) !== 'OK') return empty(0, 'already coordinated')
  } catch {
    /* lock store unavailable — proceed; a rare double is still bounded by each permission */
  }

  // 1. Gather watchers across the artist's FID-verified wallets — a drop from a
  //    sibling wallet still reaches everyone watching ANY of the artist's
  //    addresses (mirrors the on-open path, which queries the FID-expanded
  //    timeline). Keep only LIVE agents that watch one of those wallets.
  const wallets = await expandToFidSiblings(creator)
  const fidSet = new Set(wallets.map(lc))
  const owners = [...new Set((await Promise.all(wallets.map(getWatchers))).flat())]
  if (owners.length === 0) return empty(0, 'no watchers')
  const records = await getScoutsBatch(owners)
  const live: ScoutRecord[] = []
  for (const r of records.values()) {
    if (!r.permission || !r.away) continue
    if (r.scout.status !== 'active' || r.scout.mode !== 'auto') continue
    if (!r.scout.policy.creators.map(lc).some((c) => fidSet.has(c))) continue // stale index / not this artist
    live.push(r)
  }
  if (live.length === 0) return empty(owners.length, 'no live watchers')

  // 1b. Resolve the spender UP FRONT: we need its atomicity to size editions (a
  //     non-atomic EOA must mint at most 1/drop — a late mint revert would strand
  //     a multi-edition spend), and to fail fast when it isn't configured.
  let spender: ScoutSpender
  try {
    spender = await getScoutSpender()
  } catch {
    return empty(live.length, 'spender unconfigured')
  }

  // 2. Resolve the drop's currency + price + per-wallet cap + remaining supply
  //    ON-CHAIN, once. Try USDC then ETH; whichever has an active sale is it.
  const client = serverBaseClient()
  let currency: 'eth' | 'usdc' | null = null
  let price = 0n
  let maxPerAddress = 0n
  let remainingSupply: bigint | undefined
  for (const cur of ['usdc', 'eth'] as const) {
    const [tok] = await fetchEligibleTokens(client, collection, [tokenId], cur)
    if (tok) {
      currency = cur
      price = tok.pricePerToken
      maxPerAddress = tok.maxPerAddress
      remainingSupply = tok.remainingSupply
      break
    }
  }
  if (!currency) return empty(live.length, 'drop not mintable')

  const mintFee =
    currency === 'eth'
      ? await readMintFeeWithBound(client as Parameters<typeof readMintFeeWithBound>[0], collection)
      : 0n
  const perEdition = price + (currency === 'eth' ? mintFee : 0n)

  // 3. Bid. Each watcher's OWN engine policy is enforced first (same gates the
  //    on-open run applies — maxItemPrice, blocked lists, the period item cap), so
  //    a watched artist can't price a junk token at a watcher's whole allowance and
  //    drain them past the cap they configured. Then size by budget ∧ per-wallet
  //    cap ∧ edition target (clamped to 1 on a non-atomic spender, H-1).
  const now = Math.floor(Date.now() / 1000)
  const matched = live.filter((r) => r.scout.budget.currency === currency)
  if (matched.length === 0) return empty(live.length, 'no budget in the drop currency')

  // Fail CLOSED on balance reads (mirrors the per-user path): a total read failure
  // bails; a per-token failure skips that watcher. Re-collecting drops a user owns
  // would waste their budget on duplicates.
  const balances = await readBalances(client, collection, tokenId, matched.map((r) => r.scout.owner as Address))
  if (balances === null) return empty(live.length, 'could not verify balances')
  const withBalance = matched.map((r, i) => ({ r, balance: balances[i] }))

  const bidders: Bidder[] = []
  // Bound the RPC fan-out: a drop watched by thousands of agents must not fire
  // thousands of concurrent getPermissionStatus reads at once (rate-limit/timeout
  // would fail the whole drop). Evaluate in fixed-size chunks — sequential
  // execution downstream already serializes on the shared spender's nonce mutex.
  const EVAL_CHUNK = 25
  for (let s = 0; s < withBalance.length; s += EVAL_CHUNK) {
    await Promise.all(
      withBalance.slice(s, s + EVAL_CHUNK).map(async ({ r, balance }) => {
        // Tag the candidate with the artist wallet THIS watcher actually listed —
        // FID expansion may have surfaced them via a sibling — so the engine's
        // creator-allowlist gate passes for the right reason.
        const watched = r.scout.policy.creators.map(lc).find((c) => fidSet.has(c))
        if (!watched) return // defensive: live-filter already guaranteed this
        if (balance === null) return // balance read failed for this token → skip (fail-closed)
        const target = spender.atomic ? Math.max(1, Math.floor(r.scout.policy.maxEditionsPerDrop ?? 1)) : 1
        // Read permission status FIRST so we have the on-chain period anchor for
        // the policy gate (so the item-cap is judged against the chain's period).
        let periodStart: number
        let budgetEditions = target
        try {
          const status = await getPermissionStatus(r.permission!)
          if (!status.isActive) return
          periodStart = status.currentPeriod.start
          // Keep the division in bigint and clamp to `target` (≤10) BEFORE Number,
          // so a huge ETH allowance can't lose precision (M-1).
          const big = perEdition > 0n ? status.remainingSpend / perEdition : BigInt(target)
          budgetEditions = Number(big > BigInt(target) ? BigInt(target) : big)
        } catch {
          return
        }
        const candidate: Candidate = { collection: drop.collection, tokenId: drop.tokenId, creator: watched, currency, pricePerToken: price.toString() }
        if (evaluateCandidate(r.scout, candidate, r.usage, now, undefined, periodStart).action !== 'collect') return // policy gate
        const perWallet = maxPerAddress > 0n ? Number(maxPerAddress - balance) : Number.MAX_SAFE_INTEGER
        const affordable = Math.max(0, Math.min(target, Math.floor(budgetEditions), Math.floor(perWallet)))
        if (affordable >= 1) bidders.push({ record: r, owner: r.scout.owner as Address, target, affordable, periodStart })
      }),
    )
  }
  if (bidders.length === 0) return empty(live.length, 'no eligible watcher within policy')

  // 4. Round-robin allocate the supply, in a drop-seeded fair order.
  const supply = remainingSupply !== undefined ? Number(remainingSupply) : OPEN_EDITION_SUPPLY
  const ordered = fairOrder(bidders, `${lc(collection)}:${drop.tokenId}`)
  const inputs: DropWatcher[] = ordered.map((b) => ({ owner: lc(b.owner), target: b.target, affordable: b.affordable }))
  const allocations = allocateRoundRobin(inputs, supply)
  if (allocations.length === 0) return empty(live.length, 'supply exhausted')

  // 5. Execute SEQUENTIALLY. The shared spender serializes every submission on one
  //    nonce anyway (getScoutSpender wraps it in a mutex — CDP smart accounts MUST
  //    send user ops sequentially, not concurrently), so fanning out here would
  //    only pile up on that lock. Each mint goes to its user, bounded by their own
  //    permission + the per-(user,drop) lock in collectViaSpendPermission. A
  //    per-user failure is caught (returns 0) and self-heals on their on-open run.
  const byOwner = new Map(bidders.map((b) => [lc(b.owner), b]))
  let collected = 0
  let recipients = 0
  let failed = 0
  for (const a of allocations) {
    const b = byOwner.get(a.owner)
    if (!b) continue
    const item: BatchCollectItem = {
      collection,
      tokenId,
      quantity: BigInt(a.editions),
      currency,
      pricePerToken: price,
      mintFee,
      comment: '',
    }
    try {
      const { txHash } = await collectViaSpendPermission({ permission: b.record.permission!, spender, recipient: b.owner, item, editionTarget: BigInt(b.target) })
      await recordCollect(baseUrl, b.owner, drop, currency, a.editions, txHash)
      // Tell the user their agent collected (mirrors the on-open run's notice).
      await writeNotification({ type: 'agent_collect', recipient: b.owner, amount: a.editions, currency }).catch(() => {})
      // Decrement this watcher's per-period DROP budget — one coordinated drop is
      // one item regardless of editions — so maxItemsPerPeriod stays enforced
      // across the coordinator + on-open paths (the on-chain allowance is still the
      // hard dollar cap). Best-effort, anchored to the watcher's on-chain period.
      await bumpItemUsage(b.record, b.periodStart).catch(() => {})
      collected += a.editions
      recipients += 1
    } catch (err) {
      // sold out mid-run / allowance race / concurrent-collect lock — skip; self-heals
      // on-open. Log WHY so a systemic failure (paymaster/RPC/contract) is visible
      // rather than swallowed into a silently-empty coordination.
      failed += 1
      console.error('[scout] coordinated collect failed', {
        owner: b.owner,
        collection: drop.collection,
        tokenId: drop.tokenId,
        editions: a.editions,
        spender: spender.address,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // Failure-only summary (mirrors runScoutServer). `allFailed` = every allocated
  // collect threw — the systemic-breakage signal for this drop.
  if (failed > 0) {
    console.error('[scout] drop coordination completed with failures', {
      collection: drop.collection,
      tokenId: drop.tokenId,
      watchers: live.length,
      recipients,
      collected,
      failed,
      allFailed: recipients === 0,
    })
  }
  return { watchers: live.length, collected, recipients }
}

/** Per-owner balance of the drop token. FAIL-CLOSED: a total read failure returns
 *  null (the coordinator bails) and a per-token failure is null (that watcher is
 *  skipped) — never 0, which would falsely treat an owner as not-yet-collected. */
async function readBalances(
  client: ReturnType<typeof serverBaseClient>,
  collection: Address,
  tokenId: bigint,
  owners: Address[],
): Promise<(bigint | null)[] | null> {
  if (owners.length === 0) return []
  try {
    const res = await client.multicall({
      contracts: owners.map((o) => ({ address: collection, abi: ERC1155_BALANCE_ABI, functionName: 'balanceOf' as const, args: [o, tokenId] as const })),
      allowFailure: true,
    })
    return res.map((r) => (r.status === 'success' ? (r.result as bigint) : null))
  } catch {
    return null
  }
}

/** Increment a watcher's per-period DROP count by one after a coordinated collect,
 *  so maxItemsPerPeriod is enforced across the coordinator + on-open paths. Re-reads
 *  the record (to reduce clobbering a concurrent on-open update), rolls to the
 *  on-chain period anchor, then saves. Best-effort; the on-chain Spend Permission
 *  allowance is the authoritative cap regardless of this off-chain counter. */
async function bumpItemUsage(record: ScoutRecord, periodStart: number): Promise<void> {
  const fresh = await getScout(record.scout.owner)
  if (!fresh) return // record was deleted mid-coordination (user turned off) — never resurrect it
  const u = fresh.usage
  const usage =
    u.periodStart === periodStart
      ? { ...u, itemsThisPeriod: u.itemsThisPeriod + 1 }
      : { periodStart, spentThisPeriod: '0', itemsThisPeriod: 1 }
  await saveScout({ ...fresh, usage })
}

/** Record one verified collect on the proof-gated /api/collect (it re-checks the
 *  TransferSingle to `account` on-chain, so no session needed). Best-effort. */
async function recordCollect(
  baseUrl: string,
  account: string,
  drop: { collection: string; tokenId: string },
  currency: 'eth' | 'usdc',
  amount: number,
  txHash: Hex,
): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moment: { collectionAddress: drop.collection, tokenId: drop.tokenId },
        account,
        amount,
        currency,
        txHash,
      }),
    })
  } catch {
    /* the mint is on-chain regardless; the record/feed is cosmetic */
  }
}
