import 'server-only'
import { ExpirationTime, NoEntityFoundError } from '@arkiv-network/sdk'
import { and, asc, desc, eq, gt, lte } from '@arkiv-network/sdk/query'
import { addr, key as keyValue, u64 } from '@arkiv-network/sdk/schema'
import { hexToBytes, hexToString, stringToBytes, type Address, type Hex } from 'viem'
import {
  DROP_MAX_CLAIMS,
  normalizeEntityKey,
  recordExpiresAt,
  type ClaimView,
  type DropView,
  type OpenDropFields,
} from '../drops'
import { arkivPublicClient, arkivWriterAddress, createAndHandOff, type ArkivCreateResult } from './client'
import { ClaimSchema, DropSchema } from './schemas'

/**
 * Every Kismet read of drops and claims goes through here, and every read is
 * pinned to `createdBy(writer)`: anyone can write an entity tagged
 * `kismet.drop.v1`, but only the ones Kismet's writer created passed the
 * Pass gate, the signature check and the claim cap. A look-alike written by
 * someone else never shows up in a feed, a count or an airdrop list.
 */

export interface SignedIntent {
  signature: Hex
  nonce: string
  expiresAt: number
}

function writer(): Address {
  const w = arkivWriterAddress()
  if (!w) throw new Error('Arkiv is not configured (set ARKIV_WRITER_PRIVATE_KEY)')
  return w
}

function sec(v: bigint | number): number {
  return Number(v)
}

function decodeText(hex: Hex | undefined): string {
  if (!hex || hex === '0x') return ''
  try {
    return hexToString(hex)
  } catch {
    return ''
  }
}

// ── Writes ───────────────────────────────────────────────────────────────

/** Expiry for a drop and all its claims: the window plus the settle grace.
 *  `override` (unix seconds) is for scripts/drops-smoke.ts, whose throwaway
 *  entities clean themselves up minutes after the test. */
function recordExpiry(closesAt: number, override?: number) {
  return ExpirationTime.atDate(new Date((override ?? recordExpiresAt(closesAt)) * 1000))
}

export async function writeDrop(input: {
  artist: Address
  fields: OpenDropFields
  intent: SignedIntent
  recordExpiresAtOverride?: number
}): Promise<ArkivCreateResult> {
  const { artist, fields, intent, recordExpiresAtOverride } = input
  return createAndHandOff({
    schema: DropSchema,
    values: {
      artist: addr(artist),
      closesAt: u64(BigInt(fields.closesAt)),
      maxClaims: u64(BigInt(fields.maxClaims)),
      title: fields.title,
      ...(fields.description ? { description: stringToBytes(fields.description) } : {}),
      swarmRef: fields.swarmRef,
      mime: fields.mime,
      intentNonce: intent.nonce,
      intentExpiresAt: u64(BigInt(intent.expiresAt)),
      intentSignature: hexToBytes(intent.signature),
    },
    expiration: recordExpiry(fields.closesAt, recordExpiresAtOverride),
    // readonly: the terms collectors claimed under can never change.
    // permissionlessExtension: anyone (a collector, Kismet's keeper) may keep
    // a drop alive longer without being able to edit it.
    flags: { readonly: true, permissionlessExtension: true },
    newOwner: artist,
  })
}

export async function writeClaim(input: {
  dropKey: Hex
  dropClosesAt: number
  collector: Address
  claimedAt: number
  intent: SignedIntent
  recordExpiresAtOverride?: number
}): Promise<ArkivCreateResult> {
  const { dropKey, dropClosesAt, collector, claimedAt, intent, recordExpiresAtOverride } = input
  return createAndHandOff({
    schema: ClaimSchema,
    values: {
      drop: keyValue(dropKey),
      collector: addr(collector),
      claimedAt: u64(BigInt(claimedAt)),
      intentNonce: intent.nonce,
      intentExpiresAt: u64(BigInt(intent.expiresAt)),
      intentSignature: hexToBytes(intent.signature),
    },
    expiration: recordExpiry(dropClosesAt, recordExpiresAtOverride),
    flags: { readonly: true },
    newOwner: collector,
  })
}

// ── Reads ────────────────────────────────────────────────────────────────

type DropRow = {
  $key: Hex
  $owner: Address
  artist: { value: Address }
  closesAt: { value: bigint }
  maxClaims: { value: bigint }
  title: { value: string }
  description?: { value: Hex }
  swarmRef: { value: string }
  mime: { value: string }
}

function toDropView(row: DropRow, claimCount: number): DropView {
  return {
    key: normalizeEntityKey(row.$key),
    artist: row.artist.value.toLowerCase(),
    owner: row.$owner.toLowerCase(),
    title: row.title.value,
    description: decodeText(row.description?.value),
    swarmRef: row.swarmRef.value,
    mime: row.mime.value,
    closesAt: sec(row.closesAt.value),
    maxClaims: sec(row.maxClaims.value),
    claimCount,
  }
}

export async function countClaims(dropKey: Hex): Promise<number> {
  const n = await arkivPublicClient()
    .count()
    .from(ClaimSchema)
    .where(eq('drop', keyValue(dropKey)))
    .createdBy(writer())
    .fetch()
  return Number(n)
}

/** One drop by key — null when it never existed, has expired, or was not
 *  written by Kismet's writer. */
export async function getDrop(dropKey: Hex): Promise<DropView | null> {
  let row: DropRow & { $creator: Address }
  try {
    row = (await arkivPublicClient().getEntity(dropKey, DropSchema)) as unknown as DropRow & { $creator: Address }
  } catch (err) {
    if (err instanceof NoEntityFoundError) return null
    // An entity under this key that is not a kismet.drop.v1 is "not a drop".
    if (err instanceof Error && err.name === 'SchemaMismatchError') return null
    throw err
  }
  if (row.$creator.toLowerCase() !== writer().toLowerCase()) return null
  return toDropView(row, await countClaims(dropKey))
}

/** Drops still taking claims, soonest-closing first. */
export async function listOpenDrops(opts: { nowSec: number; artist?: Address; limit?: number }): Promise<DropView[]> {
  const open = gt('closesAt', u64(BigInt(opts.nowSec)))
  const where = opts.artist ? and(open, eq('artist', addr(opts.artist))) : open
  const page = await arkivPublicClient()
    .select()
    .from(DropSchema)
    .where(where)
    .createdBy(writer())
    .orderBy(asc('closesAt'))
    .limit(opts.limit ?? 24)
    .fetch()
  const rows = page.entities as unknown as DropRow[]
  const counts = await Promise.all(rows.map((r) => countClaims(r.$key)))
  return rows.map((r, i) => toDropView(r, counts[i]))
}

/** Drops whose window has closed but whose records have not expired yet —
 *  the ones waiting for their artist to mint and airdrop. Newest first. */
export async function listSettlingDrops(opts: { nowSec: number; artist?: Address; limit?: number }): Promise<DropView[]> {
  const closed = lte('closesAt', u64(BigInt(opts.nowSec)))
  const where = opts.artist ? and(closed, eq('artist', addr(opts.artist))) : closed
  const page = await arkivPublicClient()
    .select()
    .from(DropSchema)
    .where(where)
    .createdBy(writer())
    .orderBy(desc('closesAt'))
    .limit(opts.limit ?? 24)
    .fetch()
  const rows = page.entities as unknown as DropRow[]
  const counts = await Promise.all(rows.map((r) => countClaims(r.$key)))
  return rows.map((r, i) => toDropView(r, counts[i]))
}

type ClaimRow = {
  $key: Hex
  $owner: Address
  collector: { value: Address }
  claimedAt: { value: bigint }
}

function toClaimView(row: ClaimRow): ClaimView {
  return {
    key: normalizeEntityKey(row.$key),
    collector: row.collector.value.toLowerCase(),
    owner: row.$owner.toLowerCase(),
    claimedAt: sec(row.claimedAt.value),
  }
}

/**
 * Every Kismet-written claim on a drop. Pages by `$key` (a keyset, not an
 * offset) so a claim landing mid-read can't shift a page and drop or repeat
 * a row; a drop never holds more than DROP_MAX_CLAIMS claims, so this ends
 * after a few pages.
 */
export async function listClaims(dropKey: Hex): Promise<ClaimView[]> {
  const out: ClaimView[] = []
  let last: Hex | null = null
  for (let pageNo = 0; pageNo < Math.ceil(DROP_MAX_CLAIMS / 100) + 1; pageNo++) {
    const forDrop = eq('drop', keyValue(dropKey))
    const page = await arkivPublicClient()
      .select({ $key: true, $owner: true, collector: true, claimedAt: true })
      .from(ClaimSchema)
      .where(last ? and(forDrop, gt('$key', keyValue(last))) : forDrop)
      .createdBy(writer())
      .orderBy(asc('$key'))
      .limit(100)
      .fetch()
    const rows = page.entities as unknown as ClaimRow[]
    out.push(...rows.map(toClaimView))
    if (rows.length < 100) break
    last = rows[rows.length - 1].$key
  }
  return out
}

/** Has this wallet claimed this drop (Kismet-written claims only)? */
export async function hasClaimed(dropKey: Hex, collector: Address): Promise<boolean> {
  const n = await arkivPublicClient()
    .count()
    .from(ClaimSchema)
    .where(and(eq('drop', keyValue(dropKey)), eq('collector', addr(collector))))
    .createdBy(writer())
    .fetch()
  return n > 0n
}

/** Claims a wallet currently OWNS — an `ownedBy` query, so a claim handed to
 *  this wallet shows up and one handed away does not. */
export async function listClaimsOwnedBy(owner: Address, limit = 50): Promise<(ClaimView & { drop: Hex })[]> {
  const page = await arkivPublicClient()
    .select({ $key: true, $owner: true, drop: true, collector: true, claimedAt: true })
    .from(ClaimSchema)
    .ownedBy(owner)
    .createdBy(writer())
    .orderBy(desc('claimedAt'))
    .limit(limit)
    .fetch()
  const rows = page.entities as unknown as (ClaimRow & { drop: { value: Hex } })[]
  return rows.map((r) => ({ ...toClaimView(r), drop: normalizeEntityKey(r.drop.value) }))
}
