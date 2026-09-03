// Shared shapes for the Experience (the capsule machine). Pure types only — no
// imports — so both the client surfaces and the server core can pull from here
// without dragging Redis, viem, or node:crypto into a bundle.
//
// The whole subsystem is built on one rule: A CREATOR SETS WEIGHTS AND SUPPLIES,
// NEVER ODDS. Every probability a player ever sees is DERIVED from these
// structures (lib/experience/draw.deriveOdds) and rendered from the same frozen
// snapshot the draw indexes into, so the published table and the actual
// distribution are the same object by construction rather than by policy.

/** A prize entry: one artist's piece admitted to a machine's pool.
 *
 *  `supply` is the artist's own consent boundary — how many copies they agree
 *  may be released. 0 means unlimited (an open edition). It is NOT the on-chain
 *  cap: `adminMint` is still bounded by the token's own maxSupply, re-read live
 *  before every delivery (see the route's authority re-check). */
export interface PoolEntry {
  /** Lowercased collection address. */
  collection: string
  /** Base-10 canonical tokenId (BigInt-normalized — never '01'). */
  tokenId: string
  /** Lowercased artist address; must appear in the machine's split. */
  artist: string
  /** Relative draw weight. Positive integer. Larger = drawn more often. */
  weight: number
  /** Copies the artist consents to release. 0 = unlimited. */
  supply: number
}

/** A pool entry plus its live remaining count, as frozen into a claim. */
export interface SnapshotEntry extends PoolEntry {
  /** Copies still available at freeze time. `null` when supply is unlimited. */
  remaining: number | null
}

/** One derived odds row. This is the ONLY shape a probability may reach the UI
 *  in — there is no field anywhere a creator can write a percentage into. */
export interface OddsRow {
  collection: string
  tokenId: string
  artist: string
  /** Probability in [0,1], derived from weight / Σweight over eligible entries. */
  probability: number
  remaining: number | null
}

/** Claim lifecycle. Deliberately NOT a bare NX flag (which is right for
 *  /api/collect, where a lost record costs only an index entry): here the record
 *  IS the obligation, so every interruption must be resumable at the exact step
 *  it died on. `sending` is written BEFORE the userOp is awaited — that is what
 *  makes an indeterminate "may still land" timeout recoverable at all. */
export type ClaimState =
  | 'claimed'    // NX won; units + claimant recorded
  | 'frozen'     // snapshot + hashes written; draw is now a pure function
  | 'drawn'      // prize selected, supply decremented
  | 'sending'    // userOpHash recorded, delivery in flight
  | 'delivered'  // confirmed on-chain; only now may a TTL apply
  | 'pending'    // stalled and visible: needs reconciliation or ops

export interface ClaimRecord {
  machineId: string
  /** Lowercased address the capsule was minted TO — the owner of this play.
   *  Never derived from receipt.from, which is the bundler on ERC-4337. */
  claimant: string
  txHash: string
  /** Which unit of a multi-quantity capsule mint this claim covers. */
  unitIndex: number
  state: ClaimState
  createdAt: number
  /** Frozen eligible set. The draw is a pure function of this and the seed. */
  snapshot?: SnapshotEntry[]
  /** sha256 of the canonical snapshot — published so a verifier can prove the
   *  weight table did not change between commit and draw. Without this a seed
   *  scheme proves only outcome-mapping, and odds can be altered silently while
   *  every individual verification still passes. */
  snapshotHash?: string
  /** Seed epoch this draw is bound to, recorded at freeze so verification uses
   *  the epoch that was live then rather than "today". */
  epoch?: string
  /** The commitment that was public for `epoch` at the moment of the freeze.
   *  Stored on the claim so a receipt is SELF-CONTAINED: a verifier can compare
   *  the revealed seed against the commitment this play was actually served
   *  under, instead of against whatever the server chooses to show later. */
  commitment?: string
  /** Redraw counter — each attempt is an independent, separately verifiable
   *  draw over the same frozen snapshot. */
  attempt?: number
  /** The selected prize. */
  prize?: { collection: string; tokenId: string; artist: string }
  /** CDP userOp hash, written before the await so a timeout is traceable. */
  userOpHash?: string
  /** Delivery transaction once confirmed. */
  txDelivered?: string
  /** Why a claim is pending — surfaced to the player and to ops. */
  pendingReason?: string
}

/** Every way a machine can fail its publish gate. Lives here rather than in
 *  lib/experience/solvency so the Capsule Studio can type its problem list
 *  without importing the checker's implementation — the codes are part of the
 *  contract between the gate and the surfaces that report it. */
export type SolvencyProblemCode =
  | 'empty-pool'
  | 'too-many-entries'
  | 'too-many-artists'
  | 'bad-weight'
  | 'bad-supply'
  | 'duplicate-entry'
  | 'artist-not-in-split'
  | 'pass-collection'
  | 'over-headroom'
  | 'undercollateralised'
  | 'floor-not-creator'
  /** Emitted by the create route, not checkSolvency (it needs the machine
   *  list, which the pure checker must not read): another live machine already
   *  uses this capsule token. Claims are keyed per (machine, tx, unit), so two
   *  machines sharing one capsule would let a single paid mint play on BOTH —
   *  a cross-machine double-spend of the capsule itself. */
  | 'capsule-in-use'

/** Machine visibility. `draft` is creator-only; `review` is queued for a
 *  curator; `live` is playable; `ended` keeps claims honourable but sells
 *  nothing; `delisted` is a moderation outcome that ALSO keeps claims
 *  honourable — a paid capsule is never stranded by a delisting. */
export type MachineState = 'draft' | 'review' | 'live' | 'ended' | 'delisted'

export interface Machine {
  id: string
  /** Lowercased creator address — artist, or a host who owns no art. */
  creator: string
  name: string
  state: MachineState
  /** The capsule: a Zora 1155 the creator minted. Its artwork themes the page,
   *  its price is the coin slot, its sale window is the season, and its
   *  on-chain maxSupply is the solvency ceiling. */
  capsule: { collection: string; tokenId: string }
  /** Capsule maxSupply read at publish — the immutable liability ceiling. */
  capsuleMaxSupply: number | null
  /** Base block number at publish, recorded best-effort. Bounds the
   *  capsule-discovery log scan (lib/experience/discovery): capsules can only
   *  be minted after the machine exists, so `fromBlock = createdBlock` makes
   *  the scan exact and tight instead of a lookback guess. Absent on machines
   *  published before the field existed, or when the read failed — discovery
   *  then falls back to a bounded lookback and the paste-a-hash path covers
   *  anything older. */
  createdBlock?: number
  /** Lowercased split recipients, as validated at publish.
   *
   *  PERSISTED, not just checked. Every pool artist must be in the split —
   *  an artist who cannot be paid must not be drawable — and that rule was
   *  previously enforced once at creation and then forgotten, leaving nothing
   *  able to answer "is this machine still paying the people in it?". A curator
   *  reviewing a queued machine, and anyone auditing a live one, needs the
   *  answer, so the set is part of the machine rather than a transient argument. */
  splitRecipients: string[]
  createdAt: number
  /** Content hash bound at curator approval; a material edit returns to review. */
  approvedHash?: string
}
