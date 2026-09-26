import 'server-only'
import { parseAbi, type Address } from 'viem'
import { multicall } from 'viem/actions'
import { getMomentMetaBatch } from '../notifications'
import { serverBaseClient } from '../rpc'
import { entryKey, MAX_POOL_ENTRIES } from './draw'
import { isDeliverableEntry } from './eligibility'
import { getMachine, joinLineup, machinesLinking, optedOutPieces } from './store'
import { isReveal, type PoolEntry } from './types'

/**
 * Linked collections: a reveal machine that grows by itself.
 *
 * A curator links a collection and every piece Kismet mints into it joins the
 * lineup — the pieces already there when the machine is published, newest
 * first, and each new one the moment it is minted (the mint route calls
 * joinLinkedMachines). Only work minted on Kismet, the rule every reveal
 * machine keeps: Kismet knows who made it, so it can credit them and honour
 * their choice to keep it out.
 *
 * Joining is not showing. A piece in the lineup appears only while it is on
 * sale (lib/experience/lineup), so a new piece whose sale opens tomorrow
 * appears tomorrow, and one that sells out leaves by itself.
 */

export const MAX_LINKED_COLLECTIONS = 3

const NEXT_TOKEN_ID_ABI = parseAbi(['function nextTokenId() view returns (uint256)'])

/** Each collection's next token id, from one multicall; null where the chain
 *  did not answer — which is also how a non-Zora address answers. */
export async function readNextTokenIds(collections: string[]): Promise<(bigint | null)[]> {
  if (collections.length === 0) return []
  const res = await multicall(serverBaseClient(), {
    contracts: collections.map((c) => ({ address: c as Address, abi: NEXT_TOKEN_ID_ABI, functionName: 'nextTokenId' as const })),
    allowFailure: true,
  }).catch(() => null)
  return collections.map((_, i) => (res?.[i]?.status === 'success' ? (res[i].result as bigint) : null))
}

const mintedAt = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * The pieces already in the linked collections that a new machine starts
 * with: Kismet-minted, still available to machines, not already hand-picked,
 * newest first, at most `room` of them. Pieces that cannot go in are passed
 * over quietly — nobody picked them, so there is nobody to tell.
 */
export async function linkedPieces(input: {
  collections: string[]
  nextTokenIds: bigint[]
  room: number
  exclude: Set<string>
  passCollection: string | null
}): Promise<PoolEntry[]> {
  if (input.room <= 0) return []
  const ids: { collection: string; tokenId: string }[] = []
  input.collections.forEach((collection, i) => {
    for (let t = input.nextTokenIds[i] - 1n; t >= 1n && t >= input.nextTokenIds[i] - BigInt(MAX_POOL_ENTRIES); t--) {
      const piece = { collection, tokenId: t.toString() }
      if (!input.exclude.has(entryKey(piece))) ids.push(piece)
    }
  })
  const metas = await getMomentMetaBatch(ids.map((p) => ({ address: p.collection, tokenId: p.tokenId })))
  const minted: PoolEntry[] = []
  ids.forEach((p, i) => {
    const artist = metas[i]?.creator?.toLowerCase()
    if (artist) minted.push({ ...p, artist, weight: 1, supply: 0, linkedAt: mintedAt(metas[i]?.createdAt) })
  })
  const off = await optedOutPieces(minted)
  const allowed = await Promise.all(minted.map((e) => isDeliverableEntry(e, input.passCollection)))
  return minted
    .filter((e, i) => allowed[i] && !off.has(entryKey(e)))
    .sort((a, b) => b.linkedAt! - a.linkedAt! || Number(BigInt(b.tokenId) - BigInt(a.tokenId)))
    .slice(0, input.room)
}

/**
 * A piece was just minted on Kismet: add it to every machine linked to its
 * collection. Machines that have ended or were delisted are left alone.
 * Returns the live machines it joined, whose curators' artists may need
 * telling (lib/experience/notices).
 */
export async function joinLinkedMachines(piece: {
  collection: string
  tokenId: string
  artist: string
  mintedAt: number
}): Promise<{ machineId: string; entry: PoolEntry }[]> {
  const entry: PoolEntry = {
    collection: piece.collection.toLowerCase(),
    tokenId: BigInt(piece.tokenId).toString(),
    artist: piece.artist.toLowerCase(),
    weight: 1,
    supply: 0,
    linkedAt: piece.mintedAt,
  }
  const joined: { machineId: string; entry: PoolEntry }[] = []
  for (const machineId of await machinesLinking(entry.collection)) {
    const m = await getMachine(machineId).catch(() => null)
    if (!m || !isReveal(m) || m.state === 'ended' || m.state === 'delisted') continue
    if ((await joinLineup(machineId, entry, MAX_POOL_ENTRIES)) && m.state === 'live') joined.push({ machineId, entry })
  }
  return joined
}
