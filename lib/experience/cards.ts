import 'server-only'
import type { Address } from 'viem'
import { serverBaseClient } from '../rpc'
import { resolveOnchainSalesBatch } from '../saleConfig'
import { hydrateArtworkMeta } from './artwork'
import { entryKey } from './draw'
import { getPool } from './store'
import { isReveal, type Machine, type PoolEntry } from './types'

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

/**
 * The price of a play, by id, for every capsule machine on sale — one
 * multicall for all of them. None for a reveal machine (each piece has its
 * own), for a machine off the shelves, or for a sale that has ended or could
 * not be read: a card shows no price rather than a wrong one.
 */
export async function machinePrices(machines: Machine[]): Promise<Map<string, NonNullable<MachineCardData['price']>>> {
  const onSale = machines.flatMap((m) => (!isReveal(m) && m.state === 'live' ? [m] : []))
  const sales = await resolveOnchainSalesBatch(
    serverBaseClient(),
    onSale.map((m) => ({ collection: m.capsule.collection as Address, tokenId: BigInt(m.capsule.tokenId) })),
  )
  const now = BigInt(Math.floor(Date.now() / 1000))
  const prices = new Map<string, NonNullable<MachineCardData['price']>>()
  for (const m of onSale) {
    const sale = sales.get(`${m.capsule.collection.toLowerCase()}:${m.capsule.tokenId}`)
    if (sale && BigInt(sale.saleEnd) > now) {
      prices.set(m.id, { pricePerToken: sale.pricePerToken, currency: sale.type === 'erc20Mint' ? 'usdc' : 'eth' })
    }
  }
  return prices
}

/**
 * The play list's cards, in the order given: covers (above) and each capsule
 * machine's price while it is on sale (machinePrices).
 */
export async function machineCards(machines: Machine[]): Promise<MachineCardData[]> {
  const [covers, prices] = await Promise.all([machineCovers(machines), machinePrices(machines)])
  return machines.map((m) => {
    const card = {
      id: m.id,
      name: m.name,
      state: m.state,
      creator: m.creator,
      cover: covers.get(m.id) ?? null,
      price: prices.get(m.id) ?? null,
    }
    return isReveal(m) ? { ...card, kind: 'reveal' as const } : { ...card, kind: 'capsule' as const, capsule: m.capsule }
  })
}
