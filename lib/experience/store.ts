import 'server-only'
import { redis } from '../redis'
import { randomHex } from '../random'
import { commitmentFor } from './fairness'
import { entryKey } from './draw'
import type { ClaimRecord, ClaimState, Machine, MachineState, PoolEntry, SnapshotEntry } from './types'

/**
 * Redis persistence for the Experience. Redis is the platform's only datastore,
 * so this follows the same conventions as lib/raffle and lib/splits: a `kismetart:`
 * prefix, lowercased address keys, and every unbounded collection either
 * write-trimmed or read-bounded.
 *
 * ── The one place this deliberately diverges from house style ──
 *
 * /api/collect's idempotency is a flat `SET NX '1'` with a 30-day TTL, and that
 * is right THERE: it guards the RECORDING of something already true on-chain,
 * so a lost key costs an index entry. Here the claim record IS the obligation —
 * the player has paid and is owed an artwork — so a bare flag plus a crash
 * between claim and delivery would leave a paid play with no evidence of what
 * was owed. Claims are therefore a state machine, and carry NO TTL until they
 * reach a terminal state.
 */

const P = 'kismetart:xp'

const kMachine = (id: string) => `${P}:${id}:meta`
const kPool = (id: string) => `${P}:${id}:pool`
const kRemaining = (id: string) => `${P}:${id}:remaining`
const kClaim = (id: string, tx: string, unit: number) => `${P}:${id}:claim:${tx.toLowerCase()}:${unit}`
const kPlays = (id: string) => `${P}:${id}:plays`
const kSeed = (id: string, epoch: string) => `${P}:${id}:seed:${epoch}`
const kSpark = (id: string, addr: string) => `${P}:${id}:spark:${addr.toLowerCase()}`
/** Cross-machine commitment ledger, keyed by the EDITION rather than the
 *  machine: machineId -> pledged supply. Without this two machines can each
 *  promise the same last copy of one edition and only one can be honoured. */
const kCommit = (collection: string, tokenId: string) =>
  `${P}:commit:${collection.toLowerCase()}:${tokenId}`
/** Directory of machines, score = createdAt. Write-trimmed like every other
 *  index in the codebase (cf. MAX_FEATURED, RAFFLE_ENABLED_KEY). */
const K_INDEX = `${P}:index`

const MAX_MACHINES = 1000
/** Bounded read AND write-trim for a machine's play log. Far above what any UI
 *  shows; the claim records themselves are the durable record, this is a feed. */
const MAX_PLAYS = 5000

// ─── machines ────────────────────────────────────────────────────────────────

export async function getMachine(id: string): Promise<Machine | null> {
  const raw = await redis.get<Machine | string>(kMachine(id))
  if (!raw) return null
  return typeof raw === 'string' ? (JSON.parse(raw) as Machine) : raw
}

/**
 * Reserve a machine id and write its record, atomically. Returns false when the
 * id is already taken.
 *
 * SET NX rather than the read-then-write a caller would otherwise do: two
 * creators submitting the same id in the same instant both pass a `getMachine`
 * check, and the loser then silently overwrites the winner's machine — creator,
 * capsule and all — while the winner's pool entries stay behind under the same
 * id. A machine record is an identity, so claiming one has to be a single
 * operation, exactly like `createClaim`.
 */
export async function createMachine(m: Machine): Promise<boolean> {
  const won = await redis.set(kMachine(m.id), JSON.stringify(m), { nx: true })
  if (won !== 'OK') return false
  await redis
    .multi()
    .zadd(K_INDEX, { score: m.createdAt, member: m.id })
    .zremrangebyrank(K_INDEX, 0, -(MAX_MACHINES + 1))
    .exec()
  return true
}

export async function saveMachine(m: Machine): Promise<void> {
  await redis
    .multi()
    .set(kMachine(m.id), JSON.stringify(m))
    .zadd(K_INDEX, { score: m.createdAt, member: m.id })
    .zremrangebyrank(K_INDEX, 0, -(MAX_MACHINES + 1))
    .exec()
}

export async function setMachineState(id: string, state: MachineState): Promise<Machine | null> {
  const m = await getMachine(id)
  if (!m) return null
  const next = { ...m, state }
  await redis.set(kMachine(id), JSON.stringify(next))
  return next
}

/** Machines newest-first, optionally filtered by state. Bounded read. */
export async function listMachines(states?: MachineState[]): Promise<Machine[]> {
  const ids = (await redis.zrange(K_INDEX, 0, MAX_MACHINES - 1, { rev: true })) as string[]
  if (ids.length === 0) return []
  const raws = await Promise.all(ids.map((id) => getMachine(id).catch(() => null)))
  const out = raws.filter((m): m is Machine => m !== null)
  return states ? out.filter((m) => states.includes(m.state)) : out
}

// ─── pool ────────────────────────────────────────────────────────────────────

export async function getPool(id: string): Promise<PoolEntry[]> {
  const raw = (await redis.hgetall<Record<string, PoolEntry | string>>(kPool(id))) ?? {}
  const out: PoolEntry[] = []
  for (const v of Object.values(raw)) {
    try {
      out.push(typeof v === 'string' ? (JSON.parse(v) as PoolEntry) : v)
    } catch {
      // A corrupt row is skipped rather than thrown: one bad write must not
      // make an entire machine unplayable, and the entry simply cannot be won.
      continue
    }
  }
  return out
}

export async function putPoolEntry(id: string, e: PoolEntry): Promise<void> {
  const key = entryKey(e)
  await redis.hset(kPool(id), { [key]: JSON.stringify(e) })
  // Seed the remaining counter. `-1` is the sentinel for unlimited so the hash
  // holds a number in every slot and HINCRBY never has to special-case a type.
  await redis.hset(kRemaining(id), { [key]: e.supply === 0 ? -1 : e.supply })
}

export async function removePoolEntry(id: string, e: { collection: string; tokenId: string }): Promise<void> {
  const key = entryKey(e)
  await redis.hdel(kPool(id), key)
  await redis.hdel(kRemaining(id), key)
}

/** Remaining counts by entry key. `null` = unlimited. Upstash round-trips
 *  numbers as either number or string (the dual-representation trap
 *  lib/gateFlags and lib/passTaint.parseUnitCount both guard for), so parse
 *  defensively and treat anything unreadable as exhausted — the safe direction,
 *  since it can only withhold a prize, never over-issue one. */
export async function getRemaining(id: string): Promise<Record<string, number | null>> {
  const raw = (await redis.hgetall<Record<string, number | string>>(kRemaining(id))) ?? {}
  const out: Record<string, number | null> = {}
  for (const [k, v] of Object.entries(raw)) {
    const n = typeof v === 'number' ? v : parseInt(String(v), 10)
    out[k] = !Number.isFinite(n) ? 0 : n < 0 ? null : n
  }
  return out
}

/**
 * Atomically consume one copy. Returns the value AFTER the decrement, so a
 * negative result means this caller lost a race for the last copy and must roll
 * forward to another entry. Unlimited entries (sentinel -1) are never
 * decremented — they cannot be exhausted, and letting HINCRBY run would turn
 * the sentinel into a meaningless -2, -3, …
 *
 * THE OVERSHOOT REPAIR IS PART OF THE CONSUME, NOT THE CALLER'S JOB. HINCRBY is
 * the only atomic primitive available, so a racer necessarily drives the counter
 * below zero before it can learn it lost. That value is not merely untidy: −1 is
 * the UNLIMITED SENTINEL, so an exhausted capped edition left at −1 reads back
 * from getRemaining as `null` and becomes infinitely drawable — over-issuing past
 * the artist's consented supply and past the edition's on-chain headroom.
 *
 * Repairing here rather than in the caller is what makes it correct: only this
 * function knows the decrement was ours, and the +1 is unconditional on the
 * capped path, so N concurrent racers each do exactly one −1 and one +1 and the
 * counter converges to 0 under every interleaving. The caller must therefore NOT
 * also release on a lost race — see lib/experience/runDraw.
 */
export async function consumeOne(id: string, key: string): Promise<number | null> {
  const current = await redis.hget<number | string>(kRemaining(id), key)
  const n = typeof current === 'number' ? current : parseInt(String(current ?? '0'), 10)
  if (n < 0) return null // unlimited
  const after = await redis.hincrby(kRemaining(id), key, -1)
  if (after < 0) {
    // We took a copy that was not there. Put it back immediately; leaving it
    // negative aliases the entry onto the unlimited sentinel.
    await redis.hincrby(kRemaining(id), key, 1).catch(() => {})
  }
  return after
}

/** Give a copy back after a SUCCESSFUL consume — used when a draw is
 *  decremented but the live authority re-check then rejects the piece, so the
 *  copy was never actually delivered.
 *
 *  Never call this for a lost race: `consumeOne` has already repaired that, and
 *  a second +1 would mint a copy that does not exist. The `n < 0` guard below
 *  covers only the unlimited sentinel, which was never decremented. */
export async function releaseOne(id: string, key: string): Promise<void> {
  const current = await redis.hget<number | string>(kRemaining(id), key)
  const n = typeof current === 'number' ? current : parseInt(String(current ?? '0'), 10)
  if (n < 0) return
  await redis.hincrby(kRemaining(id), key, 1).catch(() => {})
}

// ─── claims ──────────────────────────────────────────────────────────────────

/** Take the claim for one unit of one capsule mint. Returns null when another
 *  request already holds it — the caller then READS that claim and returns its
 *  recorded outcome, so a retry is idempotent rather than a second draw.
 *
 *  NX with no TTL: an undelivered claim must never expire. Only terminal claims
 *  are eligible for expiry, and even then we keep them (they are the receipt a
 *  player can verify against). */
export async function createClaim(rec: ClaimRecord): Promise<boolean> {
  const res = await redis.set(kClaim(rec.machineId, rec.txHash, rec.unitIndex), JSON.stringify(rec), {
    nx: true,
  })
  return res === 'OK'
}

export async function getClaim(
  machineId: string,
  txHash: string,
  unitIndex: number,
): Promise<ClaimRecord | null> {
  const raw = await redis.get<ClaimRecord | string>(kClaim(machineId, txHash, unitIndex))
  if (!raw) return null
  return typeof raw === 'string' ? (JSON.parse(raw) as ClaimRecord) : raw
}

/** Advance the state machine. The caller holds the claim, so this is a plain
 *  overwrite rather than a CAS — contention is already excluded by createClaim. */
export async function advanceClaim(
  rec: ClaimRecord,
  patch: Partial<ClaimRecord> & { state: ClaimState },
): Promise<ClaimRecord> {
  const next = { ...rec, ...patch }
  await redis.set(kClaim(rec.machineId, rec.txHash, rec.unitIndex), JSON.stringify(next))
  return next
}

/** Append to the machine's public play feed. Write-trimmed; never load-bearing
 *  (the claim record is the durable truth). */
export async function recordPlay(machineId: string, player: string, txHash: string): Promise<void> {
  await redis
    .multi()
    .zadd(kPlays(machineId), {
      score: Date.now(),
      member: `${player.toLowerCase()}:${txHash.toLowerCase()}`,
    })
    .zremrangebyrank(kPlays(machineId), 0, -(MAX_PLAYS + 1))
    .exec()
    .catch(() => {})
}

export async function recentPlays(machineId: string, n = 12): Promise<{ player: string; txHash: string }[]> {
  const raw = (await redis.zrange(kPlays(machineId), 0, Math.max(0, n - 1), { rev: true })) as string[]
  return raw.map((m) => {
    const i = m.indexOf(':')
    return { player: m.slice(0, i), txHash: m.slice(i + 1) }
  })
}

/** Claims recorded for a machine by one player — the basis for the "you have an
 *  unopened capsule" reconciliation, which compares this against the capsules
 *  the chain says they were minted. */
export async function playedTxHashes(machineId: string, player: string): Promise<Set<string>> {
  const raw = (await redis.zrange(kPlays(machineId), 0, MAX_PLAYS - 1, { rev: true })) as string[]
  const p = player.toLowerCase()
  const out = new Set<string>()
  for (const m of raw) {
    const i = m.indexOf(':')
    if (m.slice(0, i) === p) out.add(m.slice(i + 1))
  }
  return out
}

// ─── fairness epochs ─────────────────────────────────────────────────────────

/**
 * The server seed for a machine-epoch, created on first use. Returns the seed
 * and its commitment.
 *
 * SET NX is what makes the commitment honest: the first caller to need this
 * epoch fixes the seed, and no later call — including one that has already seen
 * a player's transaction — can replace it. The commitment is published from the
 * same value, so a seed can never be chosen after the fact to steer an outcome.
 */
export async function seedForEpoch(machineId: string, epoch: string): Promise<{ seed: string; commitment: string }> {
  const key = kSeed(machineId, epoch)
  const fresh = randomHex(32)
  const won = await redis.set(key, fresh, { nx: true })
  const seed = won === 'OK' ? fresh : ((await redis.get<string>(key)) ?? fresh)
  return { seed, commitment: commitmentFor(seed) }
}

/** Public commitment for an epoch without exposing the seed. Returns null when
 *  the epoch has not been opened yet. */
export async function commitmentForEpoch(machineId: string, epoch: string): Promise<string | null> {
  const seed = await redis.get<string>(kSeed(machineId, epoch))
  return seed ? commitmentFor(seed) : null
}

/** Reveal a PAST epoch's seed so anyone can recompute its draws. Refuses the
 *  current epoch: revealing a live seed would make every remaining draw in it
 *  predictable. */
export async function revealSeed(machineId: string, epoch: string, currentEpoch: string): Promise<string | null> {
  if (epoch >= currentEpoch) return null
  return (await redis.get<string>(kSeed(machineId, epoch))) ?? null
}

// ─── cross-machine commitment ledger ─────────────────────────────────────────

export async function pledgeSupply(
  collection: string,
  tokenId: string,
  machineId: string,
  supply: number,
): Promise<void> {
  await redis.hset(kCommit(collection, tokenId), { [machineId]: supply })
}

export async function releasePledge(collection: string, tokenId: string, machineId: string): Promise<void> {
  await redis.hdel(kCommit(collection, tokenId), machineId)
}

/** Supply pledged for an edition by machines OTHER than `exceptMachineId`. */
export async function otherPledges(
  collection: string,
  tokenId: string,
  exceptMachineId: string,
): Promise<number> {
  const raw = (await redis.hgetall<Record<string, number | string>>(kCommit(collection, tokenId))) ?? {}
  let sum = 0
  for (const [mid, v] of Object.entries(raw)) {
    if (mid === exceptMachineId) continue
    const n = typeof v === 'number' ? v : parseInt(String(v), 10)
    if (Number.isFinite(n) && n > 0) sum += n
  }
  return sum
}

// ─── spark ───────────────────────────────────────────────────────────────────

/** Credit earned by playing. Deliberately NOT a currency: it is denominated in
 *  plays, redeemable only for artwork in the machine that issued it, and never
 *  transferable or priced in money — an intermediate currency is the exact
 *  pattern loot-box regulators flag as opaque conversion. */
export async function addSpark(machineId: string, player: string, n = 1): Promise<number> {
  return await redis.incrby(kSpark(machineId, player), n)
}

export async function getSpark(machineId: string, player: string): Promise<number> {
  const v = await redis.get<number | string>(kSpark(machineId, player))
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Build the frozen snapshot: the pool joined to live remaining counts. This is
 *  the input the draw is a pure function of, and the exact array whose hash is
 *  committed into the claim.
 *
 *  The two nullish cases here mean OPPOSITE things and must not be conflated:
 *    - key PRESENT and null  -> unlimited (getRemaining's mapping of the -1
 *      sentinel). Must stay null: isDrawable treats null as always drawable.
 *    - key ABSENT            -> we have no counter for this entry at all, which
 *      is a corrupt or half-written pool. Fail closed at 0 so a missing counter
 *      can only withhold a prize, never over-issue one.
 *  A `?? 0` collapses the first into the second, which would make every open
 *  edition — including the creator floor piece the entire solvency model rests
 *  on — permanently undrawable, and would report a floor-backed machine as
 *  undercovered forever. Hence the explicit presence test. */
export function buildSnapshot(
  pool: PoolEntry[],
  remaining: Record<string, number | null>,
): SnapshotEntry[] {
  return pool.map((e) => {
    const key = entryKey(e)
    const has = Object.prototype.hasOwnProperty.call(remaining, key)
    return { ...e, remaining: has ? remaining[key] : 0 }
  })
}
