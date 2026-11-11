import { addr, bytes, defineSchema, key, str, u256, u64 } from '@arkiv-network/sdk/schema'

/**
 * Kismet's Arkiv entities. arkiv/schema.md documents each one: what it
 * holds, which fields are indexed (filterable), who owns it and when it
 * expires.
 *
 * All are written by Kismet's writer wallet (so `$creator` is Kismet — the
 * attestation that the signature, Pass gate, claim cap or delivery were
 * checked) and then handed to their user (`$owner`). All are created
 * `readonly`, so no one — Kismet included — can change them afterwards.
 *
 * Only what a query filters on is indexed: an attribute is "either indexed,
 * so queries can filter on it, or stored only, which costs less"
 * (docs.arkiv.network/start-here/introduction). The app filters drops by
 * `closesAt` and claims by `drop`; `artist` and `collector` are read, never
 * filtered, so they are stored only. An Arkiv `str` holds 128 bytes, which is
 * why free text and signatures are `bytes` columns.
 */

/** Named schemas tag every entity with `arkiv.schema = <name>` and a query
 *  through the schema only matches that tag. Prefixed with the project, as
 *  the docs advise (Arkiv is public), and versioned so a future shape change
 *  can't be mistaken for this one. */
export const DROP_SCHEMA_NAME = 'kismet.drop.v1'
export const CLAIM_SCHEMA_NAME = 'kismet.claim.v1'
export const SETTLEMENT_SCHEMA_NAME = 'kismet.settlement.v1'

export const DropSchema = defineSchema(DROP_SCHEMA_NAME, {
  /** The artist who opened the drop (also its owner after the hand-off). */
  artist: addr(),
  /** Unix seconds — open drops are `closesAt > now`, "ending soon" sorts on it. */
  closesAt: u64().indexed(),
  maxClaims: u64(),
  title: str(),
  description: bytes().optional(),
  /** The artwork on Swarm: an unencrypted 32-byte reference, lowercase hex. */
  swarmRef: str(),
  mime: str(),
  /** The artist's EIP-712 OpenDrop signature and the values it signed over
   *  that are not columns above — enough to re-verify it on Base. */
  intentNonce: str(),
  intentExpiresAt: u64(),
  intentSignature: bytes(),
})

export const ClaimSchema = defineSchema(CLAIM_SCHEMA_NAME, {
  /** The drop entity this claim is for — every claim query filters on it. */
  drop: key().indexed(),
  /** The wallet that signed the claim (needed to re-verify the signature).
   *  The airdrop goes to the claim's current `$owner`, which starts as this
   *  wallet. */
  collector: addr(),
  /** Unix seconds. */
  claimedAt: u64(),
  intentNonce: str(),
  intentExpiresAt: u64(),
  intentSignature: bytes(),
})

/**
 * The proof a drop was delivered: the Base artwork its claims were airdropped
 * as. Written only after the airdrop transaction is checked on Base (every
 * claim's owner received the token in it, minted by the artist), handed to
 * the artist, readonly, and gone with the drop. Any app can read it to link a
 * drop to its NFT.
 */
export const SettlementSchema = defineSchema(SETTLEMENT_SCHEMA_NAME, {
  /** The drop this settles — looked up by drop, so indexed. */
  drop: key().indexed(),
  collection: addr(),
  tokenId: u256(),
  /** The Base transaction that airdropped the edition. */
  airdropTx: str(),
  recipients: u64(),
})
