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
  /** The player's balance of the DRAWN edition, read before the first delivery
   *  was attempted. Reconciliation compares against this, never against zero:
   *  prizes are ordinary editions a player may already own (and every solvent
   *  machine carries an unlimited creator floor piece that repeat players win
   *  again and again), so `balanceOf > 0` answers "do they hold one", not "did
   *  our mint land". Without the floor, a paid play whose delivery stalled was
   *  closed as delivered having minted nothing — after the artist's copy had
   *  already been consumed. */
  balanceBefore?: number
  /** How many sponsored userOps this claim has broadcast. Distinct from
   *  `attempt`, which counts DRAWS. A prize whose adminMint reverts while the
   *  authority reads look healthy would otherwise retry forever, and every
   *  retry is gas the platform pays. */
  deliveryAttempts?: number
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
  /** The capsule has a split whose members Kismet cannot name, so the pool
   *  cannot be held to it. Refused rather than assumed — see
   *  lib/experience/payees for why the alternative is a vacuous check. */
  | 'capsule-split-unverifiable'
  /** The creator holds neither admin nor sales rights on the capsule token, so
   *  they control neither what a play costs nor who it pays. */
  | 'capsule-not-controlled'
  /** The capsule has no sale row, or is priced at zero — a play would dispense
   *  another artist's consented edition for nothing. */
  | 'capsule-not-priced'
  /** An entry's live on-chain headroom could not be read, so the pledge could
   *  not be checked against it. Refused rather than skipped. */
  | 'headroom-unreadable'
  /** The capsule token is in the Pass collection, so paying to play would mint
   *  the platform credential itself. */
  | 'capsule-is-pass'

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
  /** The capsule's ACTUAL payees, resolved server-side at publish from the
   *  split Kismet recorded when the capsule was minted — never from the publish
   *  request. Taking it from the request made the 'artist-not-in-split' check
   *  circular: the creator supplied both the pool and the list it was checked
   *  against. See lib/experience/payees. Persisted so a curator reviewing a
   *  queued machine, and anyone auditing a live one, can answer "is this machine
   *  actually paying the people in it?". */
  splitRecipients: string[]
  createdAt: number
}
