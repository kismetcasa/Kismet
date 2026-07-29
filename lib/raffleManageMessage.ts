// Shared (client + server) builder for the message an artist signs to manage a
// moment's raffle. Pure — no server-only imports — so the client signs the exact
// string the server rebuilds and verifies. Every action and its parameters
// (winner, entriesCloseAt) are folded into the message, so a signature for one
// action can't be replayed as another, and tampering with a param invalidates it.

export type RaffleAction =
  | 'enable'
  | 'disable'
  | 'setCloseAt'
  | 'drawAndEnd'
  | 'reopen'

export interface RaffleManageFields {
  action: RaffleAction
  collection: string
  tokenId: string
  /** The wallet performing the action (must be creator / moment admin / admin). */
  address: string
  /** Single-use server-issued nonce (replay protection). */
  nonce: string
  /** drawAndEnd: a specific winner to crown, or null/undefined for a random draw. */
  winner?: string | null
  /** enable / setCloseAt: unix seconds entries auto-close at, or null for none. */
  closeAt?: number | null
}

export function buildRaffleManageMessage(f: RaffleManageFields): string {
  const lines = [
    `Kismet Raffle — ${f.action}`,
    `Collection: ${f.collection.toLowerCase()}`,
    `Token: ${f.tokenId}`,
  ]
  if (f.action === 'enable' || f.action === 'setCloseAt') {
    lines.push(`EntriesCloseAt: ${f.closeAt ?? 'none'}`)
  }
  if (f.action === 'drawAndEnd') {
    lines.push(`Winner: ${f.winner ? f.winner.toLowerCase() : 'random'}`)
  }
  lines.push(`Address: ${f.address.toLowerCase()}`)
  lines.push(`Nonce: ${f.nonce}`)
  return lines.join('\n')
}
