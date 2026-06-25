// Shared (client + server) builder for the message a collector signs to enter
// a moment's raffle. Pure — no server-only imports — so the client signs the
// exact string the server rebuilds and verifies. The server controls the
// template, so every field (collection, tokenId, wallet, issuedAt) is bound
// into the signature; tampering with any of them invalidates it.

export interface RaffleEntryFields {
  collection: string
  tokenId: string
  address: string
  /** Unix seconds the entry was signed; the server rejects stale signatures. */
  issuedAt: number
}

/** A signed entry is only accepted within this window of `issuedAt`. */
export const RAFFLE_ENTRY_MAX_AGE_SECONDS = 10 * 60

export function buildRaffleEntryMessage({
  collection,
  tokenId,
  address,
  issuedAt,
}: RaffleEntryFields): string {
  return [
    'Kismet Raffle — enter',
    '',
    'By signing, you enter this edition into the raffle. This is a free,',
    'gas-less signature — it moves nothing and your edition stays in your wallet.',
    '',
    `Collection: ${collection.toLowerCase()}`,
    `Token: ${tokenId}`,
    `Wallet: ${address.toLowerCase()}`,
    `Issued: ${issuedAt}`,
  ].join('\n')
}
