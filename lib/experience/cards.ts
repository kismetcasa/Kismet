import 'server-only'
import type { Address } from 'viem'
import { serverBaseClient } from '../rpc'
import { resolveOnchainSalesBatch } from '../saleConfig'
import { hydrateArtworkMeta } from './artwork'
import { entryKey } from './draw'
import { getPool } from './store'
import { isReveal, type Machine } from './types'

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
 */
export async function machineCovers(machines: Machine[]): Promise<Map<string, MachineCardData['cover']>> {
  const uncovered = machines.filter((m) => !m.cover)
  const standIns = await Promise.all(
    uncovered.map(async (m) => {
      if (!isReveal(m)) return m.capsule
      const pool = await getPool(m.id).catch(() => [])
      return pool.sort((a, b) => (entryKey(a) < entryKey(b) ? -1 : 1))[0] ?? null
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
 * The play list's cards, in the order given: covers (above) and, for every
 * capsule machine on sale, its price — one multicall for all of them.
 */
export async function machineCards(machines: Machine[]): Promise<MachineCardData[]> {
  const onSale = machines.flatMap((m) => (!isReveal(m) && m.state === 'live' ? [m] : []))
  const [covers, sales] = await Promise.all([
    machineCovers(machines),
    resolveOnchainSalesBatch(
      serverBaseClient(),
      onSale.map((m) => ({ collection: m.capsule.collection as Address, tokenId: BigInt(m.capsule.tokenId) })),
    ),
  ])
  const now = BigInt(Math.floor(Date.now() / 1000))

  return machines.map((m) => {
    const sale = isReveal(m) ? undefined : sales.get(`${m.capsule.collection.toLowerCase()}:${m.capsule.tokenId}`)
    const card = {
      id: m.id,
      name: m.name,
      state: m.state,
      creator: m.creator,
      cover: covers.get(m.id) ?? null,
      price:
        m.state === 'live' && sale && BigInt(sale.saleEnd) > now
          ? { pricePerToken: sale.pricePerToken, currency: sale.type === 'erc20Mint' ? ('usdc' as const) : ('eth' as const) }
          : null,
    }
    return isReveal(m) ? { ...card, kind: 'reveal' as const } : { ...card, kind: 'capsule' as const, capsule: m.capsule }
  })
}
