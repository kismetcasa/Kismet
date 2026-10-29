import { PERMISSION_BIT_ADMIN, PERMISSION_BIT_MINTER } from './permissions'

// The artist's own copy ("Mint a copy to myself") of a LIMITED edition.
//
// In Process's create relay drops the copy whenever a supply is set:
//   in_process_api src/lib/moment/createTokenParam.ts
//     mintToCreatorCount: token.maxSupply === undefined ? token.mintToCreatorCount : 0
// so `mintToCreatorCount: 1` only reaches the chain for an open edition. A
// limited edition minted with the toggle on came out with no copy (2026-10:
// frankiestyles' "unholy coast", an edition of 22) — and a 1/1, whose price
// is forced to 0 because the copy was meant to use up its single edition,
// was left as a FREE public mint of that edition for anyone.
//
// Kismet now sends that copy itself, from the artist's wallet, right after the
// relay mint: adminMint(artist, tokenId, 1). It needs ADMIN or MINTER on the
// collection, which the artist holds on their own collections (Zora's
// defaultAdmin; In Process makes the artist defaultAdmin on the ones it
// deploys). Before sending, the artist's balance is read: if In Process ever
// stops dropping the copy, the artist already holds it and nothing is sent.

/** The copy must come from the artist's wallet: wanted, and a supply is set. */
export function creatorCopyFromWallet(p: { artistMint: boolean; maxSupply: number | undefined }): boolean {
  return p.artistMint && p.maxSupply !== undefined
}

/** Zora's adminMint gate: ADMIN or MINTER, on the token or collection-wide
 *  (token 0) — the two rows ORed, as `_requireAdminOrRole` does. */
export function canAdminMint(collectionPerms: bigint, tokenPerms: bigint = 0n): boolean {
  const mask = PERMISSION_BIT_ADMIN | PERMISSION_BIT_MINTER
  return ((collectionPerms | tokenPerms) & mask) !== 0n
}

/**
 * The sale a 1/1 is created with: closed (it ended at the epoch), so nobody
 * can buy the single edition while the artist's copy is on its way — the
 * copy uses it up. `SALE_CLOSED_AT_CREATE` marks it: the sale-window label
 * (lib/inprocess getSaleWindow) shows no "Ended Jan 1, 1970" for it, while
 * collect gating still reads it as ended. Fixed-price ETH: Zora's ERC20
 * minter refuses a price of 0 (PricePerTokenTooLow), and a 1/1 has no price.
 */
export const SALE_CLOSED_AT_CREATE = '1'

export const ONE_OF_ONE_SALE = {
  type: 'fixedPrice' as const,
  pricePerToken: '0',
  saleStart: '0',
  saleEnd: SALE_CLOSED_AT_CREATE,
}
