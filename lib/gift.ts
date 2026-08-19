/**
 * Collect-and-gift — the pure decision layer.
 *
 * A "gift" on Kismet is NOT a collect followed by a transfer. It is a single
 * primary mint whose recipient is someone other than the payer: the same
 * `1155.mint()` / `ERC20Minter.mint()` call every collect makes, with the
 * `mintTo` encoded in `minterArguments` pointed at the recipient instead of
 * the signer. The payer signs and pays; the edition is created directly in
 * the recipient's wallet.
 *
 * WHY THAT SHAPE, AND NOT MINT-THEN-TRANSFER (the Pass-gate constraint):
 * the Pass gate's whole threat model is about TRANSFERS. lib/pass-validity's
 * processTransfer decrements `from` on every non-mint Transfer and — unless
 * the (recipient, tokenId) pair was platform-flagged for that exact tx —
 * records the moved units against the recipient as an off-platform
 * acquisition, which hasValidPass then subtracts from what they can prove
 * (lib/passTaint.ts). A bundled mint→transfer gift would have to win a race
 * against the Alchemy webhook to get its flag written, and the tx hash isn't
 * even known before signing on the EIP-5792 path. Losing that race would
 * revoke the payer AND hand the recipient a copy that proves nothing — the
 * precise outcome gifting exists to avoid. (Before the per-holder model it
 * was worse still: the mis-flagged transfer tainted the tokenId
 * collection-wide, clamping every holder of a 100-edition drop to zero.)
 *
 * A gift-mint has no transfer at all. Its on-chain footprint is a
 * `TransferSingle(from = 0x0, to = recipient)` — indistinguishable in shape
 * from an ordinary collect, and already the exact event the gate treats as
 * the genesis of a valid Pass (processTransfer's `isMint` arm credits `to`
 * unconditionally; /api/collect's verifyMintOnChain proves the same thing
 * synchronously). So gifting cannot open a gate gap: it introduces no new
 * event type, no new credit path, and no provenance rule that applies.
 * It is the paid analogue of an airdrop, which the Mint Pass Ruleset already
 * lists as "valid for minting" (lib/patronCollection.PATRON_MINT_PASS_RULESET).
 *
 * WHAT THE PAYER GETS: nothing. They never hold the edition, so they earn no
 * validity credit and the piece never enters their collected list. That is
 * the correct reading of the ledger (validity follows the holder) and callers
 * MUST say so in the UI — a Patron who gifts expecting to keep a Pass would
 * otherwise be surprised at the gate.
 *
 * Zero imports on purpose — same pattern as lib/passUnion and lib/gateFlags,
 * so scripts/verify-gift.ts can pin these semantics under
 * `node --experimental-strip-types` without dragging in redis/viem/next.
 */

/** Mints to this address burn the edition; never a valid gift target. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Case-insensitive well-formed-hex check. Deliberately NOT EIP-55-strict:
 *  the server normalizes to lowercase everywhere (see lib/address.isAddress
 *  for the same reasoning), and this module is shared by both sides. Client
 *  typo detection stays with viem's strict check at the input. */
function isHexAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

export type GiftRejection =
  /** Not a well-formed 0x address (an unresolved ENS name lands here too —
   *  the caller resolves before planning). */
  | 'invalid-recipient'
  /** 0x0 — a mint to the zero address is a burn, not a gift. */
  | 'burn-address'

export type MintPlan =
  /** Ordinary collect: mint to the signer. Also what a "gift to yourself"
   *  degrades to — it is exactly a collect, so it is not an error. */
  | { mode: 'collect'; mintTo: string; giftedBy: null }
  /** Gift: mint to someone else, paid by the signer. */
  | { mode: 'gift'; mintTo: string; giftedBy: string }
  | { mode: 'invalid'; reason: GiftRejection }

/**
 * Decide who a collect mints to, given the connected signer and an optional
 * gift recipient (already ENS-resolved by the caller).
 *
 * Self-gift collapses to `collect` rather than rejecting: minting to your own
 * address IS a collect, the ledger treats the two identically, and failing it
 * would only produce a confusing error for a harmless input. Callers that
 * want to nudge the user ("that's your own wallet") can compare `mode`.
 *
 * `signer` is trusted to be a well-formed address (every caller reads it from
 * the wallet). Recipients are untrusted user input and are validated here.
 */
export function planMint(signer: string, recipient?: string | null): MintPlan {
  const from = signer.toLowerCase()
  if (recipient == null || recipient === '') {
    return { mode: 'collect', mintTo: from, giftedBy: null }
  }
  if (!isHexAddress(recipient)) {
    return { mode: 'invalid', reason: 'invalid-recipient' }
  }
  const to = recipient.toLowerCase()
  if (to === ZERO_ADDRESS) {
    return { mode: 'invalid', reason: 'burn-address' }
  }
  if (to === from) {
    return { mode: 'collect', mintTo: from, giftedBy: null }
  }
  return { mode: 'gift', mintTo: to, giftedBy: from }
}

/** User-facing copy for a rejected recipient. One source so the collect hook
 *  and the gift form can't drift. */
export function giftRejectionMessage(reason: GiftRejection): string {
  switch (reason) {
    case 'invalid-recipient':
      return 'Enter a valid wallet address or .eth name'
    case 'burn-address':
      return 'That address would burn the artwork'
  }
}

/**
 * Server-side counterpart: decide whether to TRUST a client's `giftedBy`
 * claim. Attribution is the only thing this field drives (the creator's
 * collect notification names the payer, and the recipient gets a "X gifted
 * you …" ping) — the security-critical work (validity credit, collected
 * list) is keyed off the RECIPIENT, who is proved by the
 * `TransferSingle(0x0 → recipient)` log. So this is spam control, not a
 * trust boundary: an unproven claim is DROPPED, never fatal.
 *
 * Two independent proofs are accepted, because neither covers every wallet:
 *   - `receiptFrom` — the EOA that submitted the tx, straight off the
 *     receipt and unforgeable. Correct for every plain-EOA collect.
 *   - `sessionAddress` — the SIWE-authenticated caller (lib/session). The
 *     fallback for smart-wallet / ERC-4337 paths, where `receiptFrom` is the
 *     BUNDLER, not the user. This is exactly why the claim is never DERIVED
 *     from `receiptFrom`: doing so would stamp a bundler address as the
 *     "gifter" on ordinary smart-wallet self-collects.
 *
 * A claim equal to the collector is also dropped — that is a self-collect,
 * and a client that labels one as a gift must not be able to manufacture a
 * phantom gifter (or ping the collector about their own purchase).
 */
export function verifyGiftClaim(params: {
  claimed: string | null | undefined
  collector: string
  receiptFrom?: string | null
  sessionAddress?: string | null
}): string | null {
  const { claimed } = params
  if (!isHexAddress(claimed)) return null
  const gifter = claimed.toLowerCase()
  if (gifter === params.collector.toLowerCase()) return null
  const proofs = [params.receiptFrom, params.sessionAddress]
  for (const proof of proofs) {
    if (isHexAddress(proof) && proof.toLowerCase() === gifter) return gifter
  }
  return null
}
