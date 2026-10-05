import 'server-only'
import { redis } from '@/lib/redis'
import { getMachine, legacySparkKey, listMachines, recordRevealCollect, revealMachineLists } from './store'
import { isReveal } from './types'

/**
 * Kismet, what playing earns, and the records that come with it.
 *
 * One kismet for each paid play: a capsule opened on a capsule machine, a
 * piece collected through a reveal machine (its pulls are free, so a pull
 * earns nothing until it is collected). Kismet is a count of what a person
 * has done here, never a currency: it buys nothing, moves nowhere and has no
 * price — the intermediate currency loot-box regulators flag is exactly what
 * it is not.
 *
 * ── Built to stay cheap ──
 *
 * Every write is O(1) — HINCRBY, one ZADD trimmed to a bound, SET NX — and
 * every read is one key: no scans, no fan-out per play.
 *
 *   kismetart:xp:kismet:<addr>    hash  machineId → kismet earned there
 *   kismetart:xp:history:<addr>   zset  what came out, newest HISTORY_MAX
 *   kismetart:xp:<id>:stats       hash  plays, collects, eth_gwei, usdc_micro
 *   kismetart:xp:credited:<key>   string  a sale or collect counted once
 *
 * A machine's figures are counted as they happen, so they start when this
 * shipped; plays before then are still in its play log (store.playCount).
 */

const kKismet = (account: string) => `kismetart:xp:kismet:${account.toLowerCase()}`
const kHistory = (account: string) => `kismetart:xp:history:${account.toLowerCase()}`
const kStats = (machineId: string) => `kismetart:xp:${machineId}:stats`
const kCredited = (key: string) => `kismetart:xp:credited:${key.toLowerCase()}`
const kCarried = (account: string) => `kismetart:xp:kismet-carried:${account.toLowerCase()}`

/** How much of a person's history is kept: far more than a page shows. */
export const HISTORY_MAX = 100
/** How long "counted once" is remembered: longer than any replay could come. */
const CREDITED_TTL_S = 400 * 24 * 60 * 60

export type HistoryEntry = {
  /** The machine. */
  m: string
  k: 'play' | 'collect'
  /** The artwork that came out of it. */
  c: string
  t: string
  tx: string
  /** The capsule within its purchase; 0 for a collect. */
  u: number
  at: number
}

type Price = { pricePerToken: bigint; currency: 'eth' | 'usdc' } | null

/** Revenue as the stats hash keeps it: whole gwei for ETH, micro-dollars for
 *  USDC — integers HINCRBY can add without the precision a float loses. */
function revenueField(price: Price, quantity: number): [string, number] | null {
  if (!price || price.pricePerToken <= 0n || quantity <= 0) return null
  const total = price.pricePerToken * BigInt(quantity)
  return price.currency === 'eth' ? ['eth_gwei', Number(total / 1_000_000_000n)] : ['usdc_micro', Number(total)]
}

/**
 * Carry a person's spark — the per-machine play counter kismet replaced —
 * into kismet, once. Read lazily, on their first credit or first read, so no
 * migration has to be run: one MGET over the capsule machines, then never
 * again. The marker is taken first, so two requests cannot both carry it.
 */
async function carrySpark(account: string): Promise<void> {
  if ((await redis.set(kCarried(account), '1', { nx: true })) !== 'OK') return
  try {
    const capsules = (await listMachines()).filter((m) => !isReveal(m))
    if (capsules.length === 0) return
    const sparks = await redis.mget<(number | string | null)[]>(...capsules.map((m) => legacySparkKey(m.id, account)))
    const tx = redis.multi()
    let carried = 0
    capsules.forEach((m, i) => {
      const n = Number(sparks[i] ?? 0)
      if (Number.isInteger(n) && n > 0) {
        tx.hincrby(kKismet(account), m.id, n)
        carried++
      }
    })
    if (carried > 0) await tx.exec()
  } catch (err) {
    // Give the next request the chance this one lost.
    await redis.del(kCarried(account)).catch(() => {})
    throw err
  }
}

/** One kismet for a paid capsule play, as its claim is made. */
export async function creditPlay(machineId: string, account: string): Promise<void> {
  await carrySpark(account).catch(() => {})
  await redis.hincrby(kKismet(account), machineId, 1)
}

/** What a play delivered, in its player's history. */
export async function recordPlayHistory(account: string, entry: Omit<HistoryEntry, 'k' | 'at'>): Promise<void> {
  await appendHistory(account, { ...entry, k: 'play', at: Date.now() })
}

async function appendHistory(account: string, entry: HistoryEntry): Promise<void> {
  await redis
    .multi()
    .zadd(kHistory(account), { score: entry.at, member: JSON.stringify(entry) })
    .zremrangebyrank(kHistory(account), 0, -(HISTORY_MAX + 1))
    .exec()
}

/**
 * A capsule purchase in its machine's figures — the capsules it bought and
 * what they cost — counted once per transaction, whichever of its capsules is
 * opened first.
 */
export async function recordCapsuleSale(machineId: string, txHash: string, units: number, price: () => Promise<Price>): Promise<void> {
  if ((await redis.set(kCredited(`sale:${machineId}:${txHash}`), '1', { nx: true, ex: CREDITED_TTL_S })) !== 'OK') return
  const tx = redis.multi().hincrby(kStats(machineId), 'plays', units)
  // Its price read only now, once per purchase: a ten-pull opens ten claims.
  const revenue = revenueField(await price().catch(() => null), units)
  if (revenue) tx.hincrby(kStats(machineId), revenue[0], revenue[1])
  await tx.exec()
}

/**
 * A collect through a reveal machine, proved on chain by /api/collect: one
 * kismet for the collector, the piece in their history and in the machine's
 * log of what came out, and the sale in the machine's figures. Counted once,
 * and only for a live reveal machine that lists the piece — a collect made
 * anywhere else of a piece it lists still went through no machine.
 */
export async function creditRevealCollect(input: {
  machineId: string
  account: string
  collection: string
  tokenId: string
  txHash: string
  quantity: number
  price: Price
}): Promise<boolean> {
  const machine = await getMachine(input.machineId)
  if (!machine || !isReveal(machine) || machine.state !== 'live') return false
  if (!(await revealMachineLists(input.machineId, input.collection, input.tokenId))) return false
  const key = `collect:${input.txHash}:${input.collection}:${input.tokenId}`
  if ((await redis.set(kCredited(key), '1', { nx: true, ex: CREDITED_TTL_S })) !== 'OK') return false
  await carrySpark(input.account).catch(() => {})
  const at = Date.now()
  const entry: HistoryEntry = { m: input.machineId, k: 'collect', c: input.collection, t: input.tokenId, tx: input.txHash, u: 0, at }
  const tx = redis
    .multi()
    .hincrby(kKismet(input.account), input.machineId, 1)
    .zadd(kHistory(input.account), { score: at, member: JSON.stringify(entry) })
    .zremrangebyrank(kHistory(input.account), 0, -(HISTORY_MAX + 1))
    .hincrby(kStats(input.machineId), 'collects', input.quantity)
  const revenue = revenueField(input.price, input.quantity)
  if (revenue) tx.hincrby(kStats(input.machineId), revenue[0], revenue[1])
  await tx.exec()
  await recordRevealCollect(input.machineId, {
    player: input.account,
    collection: input.collection,
    tokenId: input.tokenId,
    txHash: input.txHash,
    unitIndex: 0,
  }).catch(() => {})
  return true
}

/** A person's kismet, by machine, most first. */
export async function kismetOf(account: string): Promise<{ total: number; machines: { id: string; kismet: number }[] }> {
  await carrySpark(account).catch(() => {})
  const raw = (await redis.hgetall<Record<string, number | string>>(kKismet(account))) ?? {}
  const machines = Object.entries(raw)
    .map(([id, n]) => ({ id, kismet: Number(n) }))
    .filter((m) => Number.isInteger(m.kismet) && m.kismet > 0)
    .sort((a, b) => b.kismet - a.kismet)
  return { total: machines.reduce((sum, m) => sum + m.kismet, 0), machines }
}

/** A person's kismet at one machine. */
export async function kismetAt(account: string, machineId: string): Promise<number> {
  await carrySpark(account).catch(() => {})
  const n = Number(await redis.hget<number | string>(kKismet(account), machineId))
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** What came out of the machines for a person, newest first. */
export async function historyOf(account: string, n = 30): Promise<HistoryEntry[]> {
  const raw = (await redis.zrange(kHistory(account), 0, Math.max(0, n - 1), { rev: true })) as (string | HistoryEntry)[]
  const out: HistoryEntry[] = []
  for (const r of raw) {
    try {
      out.push(typeof r === 'string' ? (JSON.parse(r) as HistoryEntry) : r)
    } catch {
      continue
    }
  }
  return out
}

export type MachineStats = { plays: number; collects: number; ethWei: string; usdcMicro: string }

/** A machine's figures since they were first counted. */
export async function machineStats(machineId: string): Promise<MachineStats> {
  const raw = (await redis.hgetall<Record<string, number | string>>(kStats(machineId))) ?? {}
  const int = (v: unknown) => {
    const n = Number(v ?? 0)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return {
    plays: int(raw.plays),
    collects: int(raw.collects),
    ethWei: (BigInt(int(raw.eth_gwei)) * 1_000_000_000n).toString(),
    usdcMicro: String(int(raw.usdc_micro)),
  }
}
