import { keccak256, toBytes } from 'viem'

/**
 * Claim drops — the pure half (no server deps, so the client form, the API
 * routes and scripts/verify-drops.ts all import the SAME rules).
 *
 * A claim drop is a time-boxed, free-to-claim release:
 *   1. An artist (a Pass holder) uploads an image to Swarm and opens a drop
 *      by signing an `OpenDrop` intent. Kismet writes a read-only `drop`
 *      entity on Arkiv and hands its ownership to the artist.
 *   2. Collectors claim by signing a `ClaimDrop` intent — no gas, no fee, no
 *      ETH needed. Kismet writes a read-only `claim` entity and hands its
 *      ownership to the collector.
 *   3. When the window closes the artist mints the artwork once (the normal
 *      sponsored mint) and airdrops a copy to every claim (Zora `adminMint`,
 *      which carries no protocol mint fee — hooks/useAirdrop.ts).
 *
 * Arkiv holds only the state that is temporary by nature — the open drop and
 * the pending claims — and both expire SETTLE_GRACE_SECONDS after the window
 * closes ("A shorter lifetime costs less", docs.arkiv.network/writing/
 * expiration). The finished NFT lives on Base. See arkiv/how-you-use-arkiv.md.
 */

// ── Limits ───────────────────────────────────────────────────────────────

/** Title length shown in the UI. An Arkiv `str` holds "128 bytes of UTF-8"
 *  (docs.arkiv.network/reference/limits), so the byte length is checked too. */
export const DROP_TITLE_MAX_CHARS = 100
export const ARKIV_STR_MAX_BYTES = 128
/** Stored as an Arkiv `bytes` column, since a `str` would cap at 128 bytes. */
export const DROP_DESCRIPTION_MAX_CHARS = 1000

/**
 * One drop settles in ONE airdrop, and an airdrop caps at
 * MAX_AIRDROP_RECIPIENTS (lib/config.ts) — so a drop never takes more claims
 * than a single airdrop can deliver. scripts/verify-drops.ts pins the two
 * equal so they cannot drift.
 */
export const DROP_MAX_CLAIMS = 200

/** Shortest and longest claim window. Ten minutes keeps a live demo short;
 *  thirty days keeps the whole record (window + grace) far inside Arkiv's
 *  7,884,000-block (~182.5-day) maximum lifetime. */
export const DROP_MIN_WINDOW_SECONDS = 10 * 60
export const DROP_MAX_WINDOW_SECONDS = 30 * 24 * 60 * 60

/** How long the drop and its claims stay on Arkiv after the window closes:
 *  the artist's time to mint and airdrop. After that both expire on their
 *  own — the permanent record is the NFT on Base. */
export const SETTLE_GRACE_SECONDS = 7 * 24 * 60 * 60

/** Window presets the form offers (seconds). */
export const DROP_WINDOW_PRESETS: { label: string; seconds: number }[] = [
  { label: '10 min', seconds: 10 * 60 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '24 hours', seconds: 24 * 60 * 60 },
  { label: '3 days', seconds: 3 * 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
]

/** Images only for v1: Swarm previews are served through
 *  /api/drops/{key}/media, and video would need the byte-range handling
 *  /api/img does for Arweave. */
const DROP_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type DropMediaType = (typeof DROP_MEDIA_TYPES)[number]
export const DROP_MEDIA_MAX_BYTES = 15 * 1024 * 1024

export function isDropMediaType(v: unknown): v is DropMediaType {
  return typeof v === 'string' && (DROP_MEDIA_TYPES as readonly string[]).includes(v)
}

/**
 * The image type the bytes actually are (magic numbers), or null. The upload
 * route requires it to equal the declared Content-Type, so a file can't be
 * stored on Swarm as an "image" and later served as something else.
 */
export function sniffImageType(b: Uint8Array): DropMediaType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'image/png'
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
    return 'image/gif'
  }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp'
  }
  return null
}

/** The file name the upload gives Bee (`POST /bzz?name=`, "Filename when
 *  uploading single file" — Bee OpenAPI). */
export function extensionForMediaType(mime: DropMediaType): string {
  return mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length)
}

// ── Identifiers ──────────────────────────────────────────────────────────

/** An unencrypted Swarm reference: 32 bytes, lowercase hex, no 0x. Encrypted
 *  references (64 bytes) are refused on purpose — they embed the decryption
 *  key, and Arkiv entities are public. */
export function isSwarmRef(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
}

/** An Arkiv entity key: 32 bytes, 0x-prefixed hex. */
export function isEntityKey(v: unknown): v is `0x${string}` {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
}

export function normalizeEntityKey(v: string): `0x${string}` {
  return v.toLowerCase() as `0x${string}`
}

// ── Time ─────────────────────────────────────────────────────────────────

/** THE open rule: claims are taken while `now < closesAt`. The open-drops
 *  query (`closesAt > now`), the claim route and the drop page all agree. */
export function isDropOpen(closesAt: number, nowSec: number): boolean {
  return nowSec < closesAt
}

/** When the drop and its claims leave Arkiv (unix seconds). */
export function recordExpiresAt(closesAt: number): number {
  return closesAt + SETTLE_GRACE_SECONDS
}

/** Countdown text: two units, largest first ("2d 4h", "3h 12m", "45s"). */
export function formatTimeLeft(seconds: number): string {
  if (seconds <= 0) return 'closed'
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  const s = Math.floor(seconds % 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// ── Validation ───────────────────────────────────────────────────────────

export interface DropTerms {
  title: string
  description: string
  /** Unix seconds. */
  closesAt: number
  maxClaims: number
}

export interface OpenDropFields extends DropTerms {
  swarmRef: string
  mime: DropMediaType
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * The terms an artist chooses. The form checks them BEFORE uploading (so a
 * missing title never costs an upload); validateOpenDrop adds the artwork.
 * `nowSec` is injected so the oracle can pin the window bounds.
 */
export function validateDropTerms(raw: Record<string, unknown>, nowSec: number): Validated<DropTerms> {
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return { ok: false, error: 'Give the drop a title' }
  if (title.length > DROP_TITLE_MAX_CHARS || new TextEncoder().encode(title).length > ARKIV_STR_MAX_BYTES) {
    return { ok: false, error: `Title is too long (max ${DROP_TITLE_MAX_CHARS} characters)` }
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  if (description.length > DROP_DESCRIPTION_MAX_CHARS) {
    return { ok: false, error: `Description is too long (max ${DROP_DESCRIPTION_MAX_CHARS} characters)` }
  }

  const closesAt = Number(raw.closesAt)
  if (!Number.isInteger(closesAt)) return { ok: false, error: 'Invalid close time' }
  const window = closesAt - nowSec
  if (window < DROP_MIN_WINDOW_SECONDS) return { ok: false, error: 'The claim window must be at least 10 minutes' }
  if (window > DROP_MAX_WINDOW_SECONDS) return { ok: false, error: 'The claim window can be at most 30 days' }

  const maxClaims = Number(raw.maxClaims)
  if (!Number.isInteger(maxClaims) || maxClaims < 1 || maxClaims > DROP_MAX_CLAIMS) {
    return { ok: false, error: `Claims must be between 1 and ${DROP_MAX_CLAIMS}` }
  }

  return { ok: true, value: { title, description, closesAt, maxClaims } }
}

/** The full set of rules for opening a drop — the open route runs it after
 *  the form did (never trust the client). */
export function validateOpenDrop(raw: Record<string, unknown>, nowSec: number): Validated<OpenDropFields> {
  const terms = validateDropTerms(raw, nowSec)
  if (!terms.ok) return terms
  if (!isSwarmRef(raw.swarmRef)) return { ok: false, error: 'Upload an image first' }
  if (!isDropMediaType(raw.mime)) return { ok: false, error: 'Unsupported image type' }
  return { ok: true, value: { ...terms.value, swarmRef: raw.swarmRef, mime: raw.mime } }
}

// ── EIP-712 intents ──────────────────────────────────────────────────────
//
// Same domain as the mint intent (lib/intent.ts KISMET_INTENT_DOMAIN: Kismet,
// v1, Base) and the same server-issued single-use nonce
// (/api/auth/intent-nonce → lib/intentAuth.verifyTypedIntent). The typed
// `action` slot plus the distinct primaryType mean a drop signature can never
// be replayed as a mint or a claim, or the other way round. The signature is
// stored on the Arkiv entity, so anyone can rebuild this exact message and
// verify the artist or collector authorized it.

export const OPEN_DROP_TYPES = {
  OpenDrop: [
    { name: 'action', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'title', type: 'string' },
    { name: 'descriptionHash', type: 'string' },
    { name: 'swarmRef', type: 'string' },
    { name: 'mime', type: 'string' },
    { name: 'closesAt', type: 'uint256' },
    { name: 'maxClaims', type: 'uint256' },
    { name: 'nonce', type: 'string' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const

export const CLAIM_DROP_TYPES = {
  ClaimDrop: [
    { name: 'action', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'drop', type: 'bytes32' },
    { name: 'nonce', type: 'string' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const

interface OpenDropMessage {
  action: 'open-drop'
  account: `0x${string}`
  title: string
  descriptionHash: string
  swarmRef: string
  mime: string
  closesAt: bigint
  maxClaims: bigint
  nonce: string
  expiresAt: bigint
}

interface ClaimDropMessage {
  action: 'claim-drop'
  account: `0x${string}`
  drop: `0x${string}`
  nonce: string
  expiresAt: bigint
}

/** keccak256 of the description, or '' when there is none — the wallet
 *  shows the title and terms; the hash binds the text without a wall of it. */
export function hashDescription(description: string): string {
  return description ? keccak256(toBytes(description)) : ''
}

export function buildOpenDropMessage(
  account: string,
  fields: OpenDropFields,
  nonce: string,
  expiresAt: number,
): OpenDropMessage {
  return {
    action: 'open-drop',
    account: account.toLowerCase() as `0x${string}`,
    title: fields.title,
    descriptionHash: hashDescription(fields.description),
    swarmRef: fields.swarmRef,
    mime: fields.mime,
    closesAt: BigInt(fields.closesAt),
    maxClaims: BigInt(fields.maxClaims),
    nonce,
    expiresAt: BigInt(expiresAt),
  }
}

export function buildClaimDropMessage(
  account: string,
  dropKey: string,
  nonce: string,
  expiresAt: number,
): ClaimDropMessage {
  return {
    action: 'claim-drop',
    account: account.toLowerCase() as `0x${string}`,
    drop: normalizeEntityKey(dropKey),
    nonce,
    expiresAt: BigInt(expiresAt),
  }
}

// ── Wire shapes (API → UI) ───────────────────────────────────────────────

/** A drop as read from Arkiv. */
export interface DropRecord {
  key: `0x${string}`
  artist: string
  owner: string
  title: string
  description: string
  swarmRef: string
  mime: string
  closesAt: number
  maxClaims: number
}

/** A drop with its live claim count, as pages show it. */
export interface DropView extends DropRecord {
  claimCount: number
}

export interface ClaimView {
  key: `0x${string}`
  collector: string
  owner: string
  claimedAt: number
}

/**
 * The airdrop list for settlement: each claim's CURRENT owner (a claim is an
 * Arkiv entity its collector owns, and "only the owner can change, hand over
 * or delete it" — so a collector with an EOA can hand it to another wallet
 * before the drop settles), deduplicated, capped at DROP_MAX_CLAIMS, in
 * claim order.
 */
export function settlementRecipients(claims: ClaimView[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const ordered = [...claims].sort((a, b) => a.claimedAt - b.claimedAt || (a.key < b.key ? -1 : 1))
  for (const c of ordered) {
    const a = c.owner.toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(a) || seen.has(a)) continue
    seen.add(a)
    out.push(a)
    if (out.length >= DROP_MAX_CLAIMS) break
  }
  return out
}

// ── Public links ─────────────────────────────────────────────────────────

/** The Rabdi explorer routes `/entity/<key>` and `/tx/<hash>` (its router,
 *  checked 2026-11-06). */
const ARKIV_EXPLORER_URL = 'https://rabdi.explorer.arkiv.network'
export function arkivEntityUrl(key: string): string {
  return `${ARKIV_EXPLORER_URL}/entity/${key}`
}
export function arkivTxUrl(txHash: string): string {
  return `${ARKIV_EXPLORER_URL}/tx/${txHash}`
}

/** The Swarm Foundation's public gateway, with the read path Swarm's docs and
 *  bee-js use (`/bzz/<ref>/`). lib/swarm.ts falls back to it; the drop page
 *  links to it so anyone can fetch the artwork from Swarm directly. */
export const SWARM_PUBLIC_GATEWAY = 'https://api.gateway.ethswarm.org'
export function swarmGatewayUrl(reference: string): string {
  return `${SWARM_PUBLIC_GATEWAY}/bzz/${reference}/`
}
