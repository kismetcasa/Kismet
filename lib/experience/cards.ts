import 'server-only'
import type { Address } from 'viem'
import { getGateConfig } from '../gate'
import { serverBaseClient } from '../rpc'
import { resolveOnchainSalesBatch } from '../saleConfig'
import { hydrateArtworkMeta } from './artwork'
import { readCapsuleSupplies, readLiveStandings } from './authority'
import { entryKey, isDrawable, withLiveStanding } from './draw'
import { filterDeliverable } from './eligibility'
import { readLineup } from './lineup'
import { capsuleSelling, revealSelling, type Selling } from './selling'
import { coverage } from './solvency'
import { buildSnapshot, getPool, getRemaining } from './store'
import { isReveal, type CapsuleMachine, type Machine, type PoolEntry, type RevealMachine } from './types'

/** A machine as its card in the play list shows it. A capsule card carries its
 *  capsule: ending the machine closes that sale on-chain (MachineAction). */
export type MachineCardData = {
  id: string
  name: string
  state: Machine['state']
  creator: string
  /** Its cover — or, for a machine published before covers, art it already
   *  has: a capsule machine's capsule, a reveal machine's first piece. */
  cover: { image: string; thumbhash?: string } | null
  /** A capsule machine on sale: the price of a play, as its page shows it. A
   *  reveal machine has none to show — each of its pieces has its own. */
  price: { pricePerToken: string; currency: 'eth' | 'usdc' } | null
  /** Whether its page would sell a play right now, and if not, why
   *  (lib/experience/selling): a card offers only what its page sells. */
  selling: Selling
} & ({ kind: 'reveal' } | { kind: 'capsule'; capsule: { collection: string; tokenId: string } })

/**
 * Each machine's cover, by id: its own, or — for a machine published before
 * covers — art it already has (a capsule machine's capsule, a reveal
 * machine's first piece). One cached metadata read per machine without one.
 * `readPool` reads a reveal machine's pool: a caller that reads the pools
 * anyway passes its own, so each is read once (the creator's profile).
 */
export async function machineCovers(
  machines: Machine[],
  readPool: (id: string) => Promise<PoolEntry[]> = getPool,
): Promise<Map<string, MachineCardData['cover']>> {
  const uncovered = machines.filter((m) => !m.cover)
  const standIns = await Promise.all(
    uncovered.map(async (m) => {
      if (!isReveal(m)) return m.capsule
      const pool = await readPool(m.id).catch(() => [] as PoolEntry[])
      // The piece first by its key, the same stable pick as ever — found, not
      // sorted, so a pool the caller shares is never reordered under it.
      return pool.reduce<PoolEntry | null>((first, e) => (first && entryKey(first) <= entryKey(e) ? first : e), null)
    }),
  )
  const standInOf = new Map(uncovered.map((m, i) => [m.id, standIns[i]]))
  const art = await hydrateArtworkMeta(standIns.filter((p): p is { collection: string; tokenId: string } => p !== null))
  return new Map(
    machines.map((m) => {
      if (m.cover) return [m.id, { image: m.cover.uri, thumbhash: m.cover.thumbhash }]
      const standIn = standInOf.get(m.id)
      const image = standIn ? art[`${standIn.collection.toLowerCase()}:${standIn.tokenId}`]?.image : null
      return [m.id, image ? { image } : null]
    }),
  )
}

/** Reads each machine's pool once, however many of a request's reads ask for
 *  it (covers, the market, a lineup count): what each caller gets is shared,
 *  so none may reorder it. */
export function poolReader(): (id: string) => Promise<PoolEntry[]> {
  const pools = new Map<string, Promise<PoolEntry[]>>()
  return (id) => {
    let pool = pools.get(id)
    if (!pool) pools.set(id, (pool = getPool(id).catch(() => [] as PoolEntry[])))
    return pool
  }
}

const capsuleKey = (c: { collection: string; tokenId: string }) => `${c.collection.toLowerCase()}:${c.tokenId}`

/**
 * What the cards say about selling, for every machine given, read the way the
 * machine's own page reads it (app/api/experience/machines/[id]) and judged by
 * the same rule (lib/experience/selling) — in a fixed number of reads however
 * many machines there are: one multicall for the capsules' sales, one for
 * their supplies, one for every capsule machine's pieces' standing, and one
 * lineup read for every reveal machine's pieces. A read that fails says so on
 * the machines it touches ("price unavailable", "checking what's left"),
 * never "on sale".
 *
 * `price` is the price of a play while a capsule machine is on sale, as the
 * play list has always shown it; `supply` is each capsule machine's supply
 * as the chain has it (absent when it could not be read).
 */
export async function machineMarket(
  machines: Machine[],
  readPool: (id: string) => Promise<PoolEntry[]> = getPool,
): Promise<{
  prices: Map<string, NonNullable<MachineCardData['price']>>
  supplies: Map<string, { maxSupply: number | null; minted: number }>
  selling: Map<string, Selling>
}> {
  const capsules = machines.filter((m): m is CapsuleMachine => !isReveal(m))
  const liveCapsules = capsules.filter((m) => m.state === 'live')
  const liveReveals = machines.filter((m): m is RevealMachine => isReveal(m) && m.state === 'live')
  const [sales, supplyByCapsule, gate, snapshots, revealPools] = await Promise.all([
    resolveOnchainSalesBatch(
      serverBaseClient(),
      liveCapsules.map((m) => ({ collection: m.capsule.collection as Address, tokenId: BigInt(m.capsule.tokenId) })),
    ),
    readCapsuleSupplies(capsules.map((m) => m.capsule)),
    getGateConfig(),
    Promise.all(
      liveCapsules.map(async (m) => {
        const [pool, remaining] = await Promise.all([
          readPool(m.id).catch(() => [] as PoolEntry[]),
          getRemaining(m.id).catch(() => ({}) as Record<string, number | null>),
        ])
        return buildSnapshot(pool, remaining)
      }),
    ),
    Promise.all(liveReveals.map((m) => readPool(m.id).catch(() => [] as PoolEntry[]))),
  ])
  const passCollection = gate.passCollection?.toLowerCase() ?? null

  // Each capsule machine's table as its page builds it (drawableTable): the
  // deliverable pieces, then the chain's word on what is left of each.
  const allowed = await Promise.all(snapshots.map((snap) => filterDeliverable(snap, passCollection)))
  const pieces = new Map<string, { collection: string; tokenId: string }>()
  for (const e of allowed.flat()) pieces.set(entryKey(e), e)
  const [standing, lineup] = await Promise.all([
    readLiveStandings([...pieces.values()]),
    (async () => {
      const unique = new Map<string, PoolEntry>()
      for (const e of revealPools.flat()) unique.set(entryKey(e), e)
      const entries = [...unique.values()]
      const read = await readLineup(entries, passCollection).catch(() => [])
      return new Map(read.map((p) => [p.key, p.status]))
    })(),
  ])

  const now = BigInt(Math.floor(Date.now() / 1000))
  const prices = new Map<string, NonNullable<MachineCardData['price']>>()
  const selling = new Map<string, Selling>()
  liveCapsules.forEach((m, i) => {
    const sale = sales.get(capsuleKey(m.capsule)) ?? null
    if (sale && BigInt(sale.saleEnd) > now) {
      prices.set(m.id, { pricePerToken: sale.pricePerToken, currency: sale.type === 'erc20Mint' ? 'usdc' : 'eth' })
    }
    // Readable only when every one of its own pieces was: the page reads a
    // machine's pieces together, and one that fails leaves it unconfirmed.
    const own = allowed[i]
    const readable = standing !== null && own.every((e) => standing.has(entryKey(e)))
    const visible = readable ? withLiveStanding(own, Object.fromEntries(standing)) : own
    const remainingPrizes = visible.some((e) => e.remaining === null)
      ? null
      : visible.reduce((sum, e) => sum + (e.remaining ?? 0), 0)
    const supply = supplyByCapsule.get(capsuleKey(m.capsule))
    const cover = coverage({
      capsuleMaxSupply: supply?.maxSupply ?? m.capsuleMaxSupply,
      capsuleMinted: supply?.minted ?? 0,
      remainingPrizes,
    })
    const { window: _window, ...verdict } = capsuleSelling({
      state: m.state,
      sale: sale ? { pricePerToken: sale.pricePerToken, saleStart: sale.saleStart, saleEnd: sale.saleEnd } : null,
      saleReadable: sale !== null,
      capsulesOutstanding: cover.capsulesOutstanding,
      standingReadable: readable,
      drawable: visible.some(isDrawable),
      prizesRemaining: cover.prizesRemaining,
    })
    selling.set(m.id, verdict)
  })
  liveReveals.forEach((m, i) => {
    const statuses = revealPools[i].map((e) => lineup.get(entryKey(e)))
    selling.set(
      m.id,
      revealSelling({
        state: m.state,
        onSale: statuses.filter((s) => s === 'on-sale').length,
        waiting: statuses.filter((s) => s === 'upcoming').length,
      }),
    )
  })
  for (const m of machines) {
    if (!selling.has(m.id)) {
      selling.set(m.id, isReveal(m) ? revealSelling({ state: m.state, onSale: 0, waiting: 0 }) : capsuleSelling({
        state: m.state,
        sale: null,
        saleReadable: false,
        capsulesOutstanding: null,
        standingReadable: false,
        drawable: false,
        prizesRemaining: null,
      }))
    }
  }
  const supplies = new Map<string, { maxSupply: number | null; minted: number }>()
  for (const m of capsules) {
    const supply = supplyByCapsule.get(capsuleKey(m.capsule))
    if (supply) supplies.set(m.id, supply)
  }
  return { prices, supplies, selling }
}

/**
 * The play list's cards, in the order given: covers (above), and each
 * machine's price and whether it is selling (machineMarket).
 */
export async function machineCards(machines: Machine[]): Promise<MachineCardData[]> {
  const poolOf = poolReader()
  const [covers, market] = await Promise.all([machineCovers(machines, poolOf), machineMarket(machines, poolOf)])
  return machines.map((m) => {
    const card = {
      id: m.id,
      name: m.name,
      state: m.state,
      creator: m.creator,
      cover: covers.get(m.id) ?? null,
      price: market.prices.get(m.id) ?? null,
      selling: market.selling.get(m.id) ?? { open: false as const, reason: 'season closed' as const },
    }
    return isReveal(m) ? { ...card, kind: 'reveal' as const } : { ...card, kind: 'capsule' as const, capsule: m.capsule }
  })
}
