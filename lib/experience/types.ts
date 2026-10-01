// Shared shapes for the Experience (capsule and reveal machines). Types and one
// type guard, no imports — so both the client surfaces and the server core can
// pull from here without dragging Redis, viem, or node:crypto into a bundle.
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
  /** Reveal machines only: set on a piece that came in through a linked
   *  collection rather than by hand — when it was minted. A full lineup makes
   *  room for a new piece by dropping the oldest of these; hand-picked pieces
   *  are never dropped. */
  linkedAt?: number
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
  /** Capsules in the purchase this unit belongs to — so a win can be told
   *  once per purchase, on unit 0, whichever route delivers it. Absent on
   *  claims made before the field. */
  units?: number
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
  /** CDP userOp hash, written before the await so a timeout is traceable —
   *  and the ONLY handle reconciliation uses. Resume asks CDP what became of
   *  this exact operation (lib/experience/delivery.readDeliveryOutcome), never
   *  the player's balance of the edition: a balance is moved by every mint of
   *  that edition, including a sibling unit's of the same capsule, and closed
   *  claims as delivered that had minted nothing. */
  userOpHash?: string
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
   *  list, which the pure checker must not read): another machine already uses
   *  this capsule token — in ANY state, including delisted, because a machine
   *  keeps its capsule for life. Claims are keyed per (machine, tx, unit), so
   *  two machines sharing one capsule would let a single paid mint play on
   *  BOTH — a cross-machine double-spend of the capsule itself. */
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
  /** The declared artist of an entry does not hold ADMIN on that token. The
   *  split check holds the machine to whoever is NAMED as artist, so a wrong
   *  name lets a creator dispense someone else's granted piece while paying
   *  only themselves. */
  | 'artist-not-admin'
  /** The artist's on-chain control of an entry could not be read. Refused
   *  rather than skipped, like headroom. */
  | 'artist-unreadable'
  /** The artist has not allowed capsule machines to mint this piece: the
   *  delivery account holds no mint rights on it. Every play that drew it
   *  would pend, so a machine leaning on it could sell capsules it cannot
   *  honour. The artist grants it from the artwork's page. */
  | 'piece-not-allowed'
  /** Whether the delivery account may mint an entry could not be read.
   *  Refused rather than skipped, like headroom. */
  | 'allowance-unreadable'
  /** The capsule token is in the Pass collection, so paying to play would mint
   *  the platform credential itself. */
  | 'capsule-is-pass'
  /** Reveal machines: Kismet has no record of who made the piece, so it could
   *  be neither credited nor held to its artist's availability choice. */
  | 'artist-unknown'
  /** Reveal machines: its artist turned reveal machines off, or it cannot be
   *  shown (hidden, a Pass, or its artist is not permitted). */
  | 'piece-unavailable'
  /** Reveal machines: a linked collection is not a Zora collection the chain
   *  answers for, or it is the Pass collection. */
  | 'collection-invalid'

/** A reveal machine piece's standing right now (lib/experience/lineup). */
export type PieceStatus =
  /** Collectable now: an open sale with copies left. */
  | 'on-sale'
  /** A sale whose window has not opened yet: the piece joins when it does. */
  | 'upcoming'
  /** No sale, or its window has closed. Joins again only if its artist opens
   *  a new one. */
  | 'not-on-sale'
  | 'sold-out'
  /** Its artist turned reveal machines off, it is hidden, its artist is
   *  blacklisted, or it is a Pass. */
  | 'unavailable'
  /** The chain or the flag store could not answer. Treated as not on sale. */
  | 'unreadable'

export interface LineupPiece {
  key: string
  collection: string
  tokenId: string
  artist: string
  status: PieceStatus
  /** Present when on sale: base units, as every price surface formats them. */
  sale?: { pricePerToken: string; currency: 'eth' | 'usdc'; saleEnd: number }
}

/** Machine visibility, and only visibility. `draft` is creator-only; `review` is
 *  queued for a curator; `live` is on the shelves; `ended` is off them by the
 *  creator's choice; `delisted` is off them by a curator's.
 *
 *  NONE of the last three stops a capsule already paid for from being opened.
 *  State governs listing, never settlement: a machine keeps its pledged copies
 *  and its capsule token for life, and honours every capsule it sold. Stopping a
 *  particular ARTWORK is a separate, per-artwork control (hide it, or blacklist
 *  its artist), which parks the claim for an operator instead of keeping the
 *  player's money. */
export type MachineState = 'draft' | 'review' | 'live' | 'ended' | 'delisted'

/** How a capsule machine's odds are set.
 *
 *  `manual` — the creator types a weight per piece.
 *  `supply` — a piece's weight is its total copies in the machine, set once at
 *  publish: a piece with twenty copies comes out twenty times as often as a
 *  one-of-one, and a one-of-one stays that rare all season rather than growing
 *  likelier as other copies go. So every piece needs a finite supply, and the
 *  weight the draw reads is simply the one stored — nothing is derived later. */
export type Rarity = 'manual' | 'supply'

/** A machine's cover: the still its card and its share preview show. Uploaded
 *  the way a collection's cover is (Arweave, first frame of a gif), so it is
 *  always an `ar://` URI, with the thumbhash the card blurs in from. */
export interface MachineCover {
  uri: string
  thumbhash?: string
}

/** An artist's own art for one stage of a play (lib/experience/frameUpload):
 *  a clip — a gif becomes one — or a still, with the still a viewer who asked
 *  for less motion sees instead. */
export interface StageFrame {
  uri: string
  kind: 'video' | 'image'
  /** Its still; the same upload as `uri` for an image. */
  poster: string
  thumbhash?: string
  /** The server's verdict on it (lib/experience/frameScreen): stored with the
   *  frame, never taken from a request, never sent to a player. None yet
   *  means it is still being checked, and is not played. */
  check?: FrameCheck
}

/** What the server's screening of a stage frame found. */
export type FrameCheck =
  | { state: 'passed'; at: number }
  | { state: 'refused'; reason: string; at: number }

/** The stages an artist can draw. A reveal machine's pull waits on nothing,
 *  so it has no dispense. Absent stages play the platform's own capsule. */
export interface MachineFrames {
  dispense?: StageFrame
  open?: StageFrame
}

/** What a stage frame is held to. It plays inside a pull, on a phone, often in
 *  a Farcaster webview: short, small, and no larger than a phone can show. */
export const FRAME_LIMITS = { seconds: 4, px: 1080, bytes: 2.5 * 1024 * 1024 } as const

interface MachineCommon {
  id: string
  /** Lowercased creator address — artist, or a host who owns no art. */
  creator: string
  name: string
  state: MachineState
  createdAt: number
  /** When the machine first went live. Set once and never cleared: a machine
   *  that has ever been live may have sold capsules, and every one of them is
   *  owed for life, so it can never be withdrawn — only ended or delisted. */
  listedAt?: number
  /** Absent on machines published before covers existed; their cards fall
   *  back to art the machine already has (lib/experience/cards). */
  cover?: MachineCover
  /** The artist's own frames for the play; absent, the platform's capsule. */
  frames?: MachineFrames
}

/** A machine that sells capsules: a player pays the capsule price once and a
 *  drawn artwork is minted to them. Only the creator's own work, because the
 *  capsule's split is the only thing that pays anyone. */
export interface CapsuleMachine extends MachineCommon {
  /** Absent on machines published before reveal machines existed. */
  kind?: 'capsule'
  /** The capsule: a Zora 1155 the creator minted. Its artwork themes the page,
   *  its price is the coin slot, its sale window is the season, and its
   *  on-chain maxSupply is the solvency ceiling. */
  capsule: { collection: string; tokenId: string }
  /** Capsule maxSupply read at publish — the immutable liability ceiling. */
  capsuleMaxSupply: number | null
  /** Base block number at publish. REQUIRED by the publish route — it is the
   *  bound the play route uses to refuse capsules minted before the machine
   *  opened, and a machine without it would honour every historical holder of
   *  its capsule token — so a chain-head read failure fails the publish rather
   *  than ship an unbounded machine. Also bounds the capsule-discovery log scan
   *  (lib/experience/discovery). Optional in the type only for machines
   *  published before the field existed: those have no bound to apply, and
   *  discovery falls back to a fixed lookback for them. */
  createdBlock?: number
  /** The capsule's ACTUAL payees, resolved server-side at publish from the
   *  split Kismet recorded when the capsule was minted — never from the publish
   *  request. Taking it from the request made the 'artist-not-in-split' check
   *  circular: the creator supplied both the pool and the list it was checked
   *  against. See lib/experience/payees. Persisted so a curator reviewing a
   *  queued machine, and anyone auditing a live one, can answer "is this machine
   *  actually paying the people in it?". */
  splitRecipients: string[]
  /** Absent means `manual`. */
  rarity?: Rarity
}

/** A machine with no capsule: a pull is free, reveals one artwork that is on
 *  sale right now, and the player collects it through its own sale at its own
 *  price. Anyone's work, unless its artist has turned availability off. */
export interface RevealMachine extends MachineCommon {
  kind: 'reveal'
  /** Linked collections, lowercased: every piece Kismet mints into one joins
   *  the lineup by itself (lib/experience/linked). Absent on machines that
   *  hold only hand-picked pieces. */
  collections?: string[]
}

export type Machine = CapsuleMachine | RevealMachine

export const isReveal = (m: Machine): m is RevealMachine => m.kind === 'reveal'
