import { addr, bytes, defineSchema, key, str, u64 } from '@arkiv-network/sdk/schema'

/**
 * Kismet's Arkiv entities. arkiv/schema.md documents each one: what it
 * holds, which fields are indexed (filterable), who owns it and when it
 * expires.
 *
 * Both are written by Kismet's writer wallet (so `$creator` is Kismet — the
 * attestation that the signature, Pass gate and claim cap were checked) and
 * then handed to their user (`$owner`). Both are created `readonly`, so no
 * one — Kismet included — can change their terms afterwards.
 *
 * Arkiv's `str` holds at most 128 bytes, which is why free text and
 * signatures are `bytes` columns.
 */

/** Named schemas tag every entity with `arkiv.schema = <name>` and a query
 *  through the schema only matches that tag. Versioned so a future shape
 *  change can't be mistaken for this one. */
export const DROP_SCHEMA_NAME = 'kismet.drop.v1'
export const CLAIM_SCHEMA_NAME = 'kismet.claim.v1'

export const DropSchema = defineSchema(DROP_SCHEMA_NAME, {
  /** The artist who opened the drop (also its owner after the hand-off). */
  artist: addr().indexed(),
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
  /** The drop entity this claim is for. */
  drop: key().indexed(),
  /** The wallet that signed the claim. The airdrop goes to the claim's
   *  current `$owner`, which starts as this wallet. */
  collector: addr().indexed(),
  /** Unix seconds. */
  claimedAt: u64(),
  intentNonce: str(),
  intentExpiresAt: u64(),
  intentSignature: bytes(),
})
