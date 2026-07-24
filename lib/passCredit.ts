// Pure credit-decision predicate for a processed Pass Transfer event. Split out
// (like lib/gateFlags) so scripts/verify-pass-credit can lock it WITHOUT pulling
// in redis/rpc — lib/pass-validity imports both and can't load under
// `--experimental-strip-types`.
//
// THE REGRESSION IT GUARDS: the webhook must credit a MINT (from == 0x0) even
// when no platform flag was set for the tx. The original `if (platform)`
// condition credited ONLY flagged txs, so a Pass mint whose client-side
// /api/collect never ran — a hung waitForTransactionReceipt or a POST dropped
// on tab-close, i.e. the desktop-browser mint path — credited no one and
// permanently stranded the buyer behind the creator gate with no error and no
// trace. Dropping the `isMint` arm re-opens that silent, unrecoverable loss.

/** A processed Transfer earns a validity credit for its recipient when it is a
 *  MINT (from == 0x0 — the genesis of the Pass, always a valid acquisition, so
 *  it needs no platform flag) OR a platform-verified acquisition (its
 *  `(recipient, tokenId)` pair was flagged for this tx: a Kismet collect /
 *  airdrop / secondary fill). An unflagged non-mint transfer (OpenSea sale,
 *  P2P send, direct Seaport fill) earns NO credit — that is the off-platform
 *  path that must never launder validity. */
export function shouldCreditTransfer(params: { platform: boolean; isMint: boolean }): boolean {
  return params.platform || params.isMint
}
