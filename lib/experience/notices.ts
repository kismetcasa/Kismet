import 'server-only'
import { redis } from '../redis'
import { bestEffort } from '../bestEffort'
import { ADMIN_ADDRESS } from '../config'
import { getGateConfig } from '../gate'
import { writeNotification } from '../notifications'
import { fetchArtworkMeta } from './artwork'
import { isDrawable } from './draw'
import { drawableTable } from './eligibility'
import { buildSnapshot, getMachine, getPool, getRemaining, optedOutPieces } from './store'
import { isReveal, type PoolEntry } from './types'

/**
 * What the people behind a machine are told that nothing else would tell
 * them. Each is sent at most once per machine (per artist), so a retried play
 * or a curator toggling a machine live twice does not repeat it.
 *
 * "Once" is one SET per machine, not a key per notice: SADD reports whether
 * the member was new, which is exactly the once-only test, and a machine
 * featuring fifty artists keeps one key rather than fifty that never expire.
 */

const once = async (machineId: string, what: string) =>
  (await redis.sadd(`kismetart:xp:${machineId}:notices`, what)) === 1

/**
 * A capsule machine whose table has nothing left it could deliver: tell its
 * creator, once, to end the season. Kismet stops selling on its own page the
 * moment this is true, but the capsule's on-chain sale is the creator's, and
 * it keeps selling on zora.co until they close it — each of those capsules is
 * a paid play with nothing to draw.
 *
 * Only on a table the chain confirmed: an unreadable one proves nothing.
 */
export async function noticeIfEmpty(machineId: string): Promise<void> {
  const machine = await getMachine(machineId)
  if (!machine || isReveal(machine) || machine.state !== 'live') return
  const gate = await getGateConfig()
  const snapshot = buildSnapshot(await getPool(machineId), await getRemaining(machineId))
  const { table, live } = await drawableTable(snapshot, gate.passCollection?.toLowerCase() ?? null)
  if (!live || table.some(isDrawable)) return
  if (!(await once(machineId, 'empty'))) return
  await writeNotification({
    type: 'experience_status',
    recipient: machine.creator,
    tokenName: machine.name,
    note: 'empty',
    machineId,
  }).catch(bestEffort('xp.noticeEmpty', { machineId }))
}

/**
 * The same notice, from a page read that found nothing left to draw — so a
 * creator hears the moment their machine runs dry (or they stop allowing its
 * last piece), not only after someone plays. Asks first, cheaply, whether
 * they have been told: an empty machine's every page view must not re-read
 * the chain.
 */
export async function noticeIfEmptyOnRead(machineId: string): Promise<void> {
  if ((await redis.sismember(`kismetart:xp:${machineId}:notices`, 'empty')) === 1) return
  await noticeIfEmpty(machineId)
}

/**
 * A machine is waiting for review: tell Kismet, whose admin wallet is the
 * only one that can approve it, so nothing sits in the queue unseen. Sent
 * once, when it is submitted.
 */
export async function noticeReview(machine: { id: string; name: string; creator: string }): Promise<void> {
  await writeNotification({
    type: 'experience_status',
    recipient: ADMIN_ADDRESS,
    actor: machine.creator,
    tokenName: machine.name,
    note: 'review',
    machineId: machine.id,
  }).catch(bestEffort('xp.noticeReview', { machineId: machine.id }))
}

/**
 * A reveal machine just went live: tell each artist whose work is in it,
 * except the curator themselves, that it is — one notice per artist, naming
 * their first piece. The artist's switch on the artwork page is how they take
 * it out; this is how they learn there is anything to take out. Pieces their
 * artist has already turned off are not mentioned.
 *
 * `only` narrows it to pieces that just joined a live machine through a linked
 * collection: an artist already told about this machine is not told again.
 */
export async function noticeFeaturedArtists(machineId: string, only?: PoolEntry[]): Promise<void> {
  const machine = await getMachine(machineId)
  if (!machine || !isReveal(machine) || machine.state !== 'live') return
  const pool = only ?? (await getPool(machineId))
  const off = await optedOutPieces(pool).catch(() => null)
  if (!off) return
  const firstByArtist = new Map<string, (typeof pool)[number]>()
  for (const e of pool) {
    if (!e.artist || e.artist === machine.creator || off.has(`${e.collection}:${e.tokenId}`)) continue
    if (!firstByArtist.has(e.artist)) firstByArtist.set(e.artist, e)
  }
  await Promise.all(
    [...firstByArtist].map(async ([artist, piece]) => {
      if (!(await once(machineId, `featured:${artist}`))) return
      const meta = await fetchArtworkMeta(piece.collection, piece.tokenId)
      await writeNotification({
        type: 'experience_featured',
        recipient: artist,
        actor: machine.creator,
        tokenAddress: piece.collection,
        tokenId: piece.tokenId,
        tokenName: meta?.name ?? undefined,
        tokenImage: meta?.image ?? undefined,
        note: machine.name,
        machineId,
      }).catch(bestEffort('xp.noticeFeatured', { machineId, artist }))
    }),
  )
}
