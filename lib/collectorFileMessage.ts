// Shared (client + server) builder for the message a collector signs to prove
// wallet ownership for a collector-file download when they have no session and
// their holding wallet sits outside the FC-verification union (see
// COLLECTOR_DOWNLOADS_DESIGN.md §5.1 path 2). Pure — no server-only imports —
// so the client signs the exact string the server rebuilds and verifies; the
// raffle entry message (lib/raffleMessage.ts) is the shipped precedent.

export interface DownloadProofFields {
  collection: string
  tokenId: string
  address: string
  /** Unix seconds the proof was signed; the server rejects stale signatures. */
  issuedAt: number
}

/** A signed proof is only accepted within this window of `issuedAt`. */
export const DOWNLOAD_PROOF_MAX_AGE_SECONDS = 10 * 60

export function buildDownloadProofMessage({
  collection,
  tokenId,
  address,
  issuedAt,
}: DownloadProofFields): string {
  return [
    'Kismet collector download',
    '',
    'By signing, you verify this wallet holds the edition so its collector',
    'file can be downloaded. This is a free, gas-less signature — it moves',
    'nothing and your edition stays in your wallet.',
    '',
    `Collection: ${collection.toLowerCase()}`,
    `Token: ${tokenId}`,
    `Wallet: ${address.toLowerCase()}`,
    `Issued: ${issuedAt}`,
  ].join('\n')
}
