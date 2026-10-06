// A play's draw, recomputed in the player's own browser with Web Crypto.
//
// The verify route already recomputes a draw, but that is Kismet checking
// Kismet. This takes the published material — the revealed seed, the frozen
// table, the block that sealed the draw — and redoes every step here: the
// seed against its commitment, the table against its hash, the HMAC for each
// attempt, the weighted pick. It hashes the same strings as the server
// (fairnessCore) and picks with the same function (draw.drawAtAttempt), so an
// honest draw lands on the delivered artwork and anything else says where it
// does not.

import { drawAtAttempt } from './draw'
import { canonicalSnapshot, drawMessage } from './fairnessCore'
import type { SnapshotEntry } from './types'

const utf8 = new TextEncoder()
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', utf8.encode(text)))
}

export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', utf8.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', k, utf8.encode(message)))
}

export interface DrawMaterial {
  serverSeed: string
  commitment: string
  snapshot: SnapshotEntry[]
  snapshotHash: string
  txHash: string
  unitIndex: number
  attempt: number
  /** The block that sealed the draw; absent on a claim drawn before blocks were mixed in. */
  blockHash?: string | null
  /** What the draw is said to have picked. */
  picked: { collection: string; tokenId: string }
}

export interface DrawCheck {
  /** The revealed seed hashes to the commitment. */
  seed: boolean
  /** The table hashes to the hash committed at the freeze. */
  table: boolean
  /** What the draw picks, recomputed here. */
  pick: { collection: string; tokenId: string } | null
  /** The pick is what it is said to be. */
  matches: boolean
}

/** Recompute one draw from its published material. */
export async function recomputeDraw(m: DrawMaterial): Promise<DrawCheck> {
  const [seedHash, tableHash] = await Promise.all([sha256Hex(m.serverSeed), sha256Hex(canonicalSnapshot(m.snapshot))])
  const hashes = await Promise.all(
    Array.from({ length: m.attempt + 1 }, (_, a) =>
      hmacSha256Hex(m.serverSeed, drawMessage({ txHash: m.txHash, unitIndex: m.unitIndex, attempt: a, blockHash: m.blockHash })),
    ),
  )
  const { pick } = drawAtAttempt(m.snapshot, (a) => hashes[a], m.attempt)
  const same = (a: { collection: string; tokenId: string } | null) =>
    !!a && a.collection.toLowerCase() === m.picked.collection.toLowerCase() && a.tokenId === m.picked.tokenId
  return {
    seed: seedHash === m.commitment.toLowerCase(),
    table: tableHash === m.snapshotHash.toLowerCase(),
    pick: pick ? { collection: pick.collection, tokenId: pick.tokenId } : null,
    matches: same(pick),
  }
}
