import 'server-only'
import { ExpirationTime, NoEntityFoundError, SchemaMismatchError } from '@arkiv-network/sdk'
import { and, asc, between, desc, eq, gt, lte, or } from '@arkiv-network/sdk/query'
import { addr, key as keyValue, u256, u64 } from '@arkiv-network/sdk/schema'
import { hexToBytes, hexToString, stringToBytes, type Address, type Hex } from 'viem'
import {
  DROP_MAX_CLAIMS,
  normalizeEntityKey,
  recordExpiresAt,
  type ClaimView,
  type DropRecord,
  type DropView,
  type OpenDropFields,
  type SettlementView,
} from '../drops'
import { arkivPublicClient, arkivWriterAddress, createAndHandOff, type ArkivCreateResult } from './client'
import { ClaimSchema, DropSchema, SettlementSchema } from './schemas'

/**
 * Every Kismet read of drops and claims goes through here, and every read is
 * pinned to `createdBy(writer)`: anyone can write an entity tagged
 * `kismet.drop.v1`, and "filtering by owner or creator is the only way to be
 * sure an entity came from an account you trust" (docs.arkiv.network/
 * querying/filter). Only what Kismet's writer created passed the Pass gate,
 * the signature check and the claim cap. Every query below was run against
 * Rabdi on 2026-11-06.
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

// ── Writes ───────────────────────────────────────────────────────────────

/** Expiry for a drop and all its claims: the window plus the settle grace.
 *  `override` (unix seconds) is for scripts/drops-smoke.ts, whose throwaway
 *  entities would otherwise sit in the live feed for a week. */
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
    // permissionlessExtension: "anyone can extend the entity, not only its
    // owner" — after the hand-off Kismet no longer owns the drop, and this is
    // what still lets anyone keep it alive through a slow settlement.
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

function toDropRecord(row: DropRow): DropRecord {
  return {
    key: normalizeEntityKey(row.$key),
    artist: row.artist.value.toLowerCase(),
    owner: row.$owner.toLowerCase(),
    title: row.title.value,
    description: row.description ? hexToString(row.description.value) : '',
    swarmRef: row.swarmRef.value,
    mime: row.mime.value,
    closesAt: Number(row.closesAt.value),
    maxClaims: Number(row.maxClaims.value),
  }
}

/** One drop by key — null when it never existed, has expired (both are
 *  NoEntityFoundError), isn't a kismet.drop.v1 (SchemaMismatchError), or was
 *  not written by Kismet's writer. */
export async function getDrop(dropKey: Hex): Promise<DropRecord | null> {
  let row: DropRow & { $creator: Address }
  try {
    row = (await arkivPublicClient().getEntity(dropKey, DropSchema)) as unknown as DropRow & { $creator: Address }
  } catch (err) {
    if (err instanceof NoEntityFoundError || err instanceof SchemaMismatchError) return null
    throw err
  }
  if (row.$creator.toLowerCase() !== writer().toLowerCase()) return null
  return toDropRecord(row)
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

/** A page of drops with their claim counts. Arkiv has no grouped count, so
 *  each card costs one count query (arkiv/friction.md). The two queries below
 *  stay written out, not shared through a helper, so the SDK keeps checking
 *  each filter and sort against the schema at compile time. */
async function withClaimCounts(rows: DropRow[]): Promise<DropView[]> {
  const counts = await Promise.all(rows.map((r) => countClaims(r.$key)))
  return rows.map((r, i) => ({ ...toDropRecord(r), claimCount: counts[i] }))
}

/** Drops still taking claims, soonest-closing first. */
export async function listOpenDrops(nowSec: number): Promise<DropView[]> {
  const page = await arkivPublicClient()
    .select()
    .from(DropSchema)
    .where(gt('closesAt', u64(BigInt(nowSec))))
    .createdBy(writer())
    .orderBy(asc('closesAt'))
    .limit(24)
    .fetch()
  return withClaimCounts(page.entities as unknown as DropRow[])
}

/** Drops whose window has closed but whose records have not expired yet —
 *  waiting for their artist to mint and airdrop. Newest first. */
export async function listSettlingDrops(nowSec: number): Promise<DropView[]> {
  const page = await arkivPublicClient()
    .select()
    .from(DropSchema)
    .where(lte('closesAt', u64(BigInt(nowSec))))
    .createdBy(writer())
    .orderBy(desc('closesAt'))
    .limit(24)
    .fetch()
  return withClaimCounts(page.entities as unknown as DropRow[])
}

type ClaimRow = {
  $key: Hex
  $owner: Address
  collector: { value: Address }
  claimedAt: { value: bigint }
}

/**
 * Every Kismet-written claim on a drop, paged by `$key` as the docs advise for
 * reading "every match exactly once" (docs.arkiv.network/querying/paginate).
 * `onMismatch: "throw"` is part of that advice: a row that doesn't fit the
 * schema would otherwise be skipped, shortening the page and ending the walk
 * early. A drop holds at most DROP_MAX_CLAIMS claims, so this is a few pages.
 */
export async function listClaims(dropKey: Hex): Promise<ClaimView[]> {
  const out: ClaimView[] = []
  let last: Hex | null = null
  for (let pageNo = 0; pageNo <= DROP_MAX_CLAIMS / 100; pageNo++) {
    const forDrop = eq('drop', keyValue(dropKey))
    const page = await arkivPublicClient()
      .select({ $key: true, $owner: true, collector: true, claimedAt: true })
      .from(ClaimSchema, { onMismatch: 'throw' })
      .where(last ? and(forDrop, gt('$key', keyValue(last))) : forDrop)
      .createdBy(writer())
      .orderBy(asc('$key'))
      .limit(100)
      .fetch()
    const rows = page.entities as unknown as ClaimRow[]
    out.push(
      ...rows.map((r) => ({
        key: normalizeEntityKey(r.$key),
        collector: r.collector.value.toLowerCase(),
        owner: r.$owner.toLowerCase(),
        claimedAt: Number(r.claimedAt.value),
      })),
    )
    if (rows.length < 100) break
    last = rows[rows.length - 1].$key
  }
  return out
}

/** Record a verified delivery. Same lifetime as the drop it settles, handed
 *  to the artist, readonly. */
export async function writeSettlement(input: {
  dropKey: Hex
  dropClosesAt: number
  artist: Address
  collection: Address
  tokenId: bigint
  airdropTx: Hex
  recipients: number
}): Promise<ArkivCreateResult> {
  return createAndHandOff({
    schema: SettlementSchema,
    values: {
      drop: keyValue(input.dropKey),
      collection: addr(input.collection),
      tokenId: u256(input.tokenId),
      airdropTx: input.airdropTx,
      recipients: u64(BigInt(input.recipients)),
    },
    expiration: recordExpiry(input.dropClosesAt),
    flags: { readonly: true },
    newOwner: input.artist,
  })
}

type SettlementRow = {
  $key: Hex
  drop: { value: Hex }
  collection: { value: Address }
  tokenId: { value: bigint }
  airdropTx: { value: string }
  recipients: { value: bigint }
}

/** Settlements for a set of drops, in one query (`drop = a OR drop = b …`). */
export async function getSettlements(dropKeys: Hex[]): Promise<Map<string, SettlementView>> {
  const out = new Map<string, SettlementView>()
  // One `or` query per batch; a drop has one settlement (the settle route
  // writes it under a lock), so a batch's rows fit one page.
  for (let i = 0; i < dropKeys.length; i += SETTLEMENT_BATCH) {
    const conditions = dropKeys.slice(i, i + SETTLEMENT_BATCH).map((k) => eq('drop', keyValue(k)))
    const page = await arkivPublicClient()
      .select({ $key: true, drop: true, collection: true, tokenId: true, airdropTx: true, recipients: true })
      .from(SettlementSchema)
      .where(conditions.length === 1 ? conditions[0] : or(...conditions))
      .createdBy(writer())
      .limit(100)
      .fetch()
    for (const r of page.entities as unknown as SettlementRow[]) {
      out.set(normalizeEntityKey(r.drop.value), {
        key: normalizeEntityKey(r.$key),
        collection: r.collection.value.toLowerCase(),
        tokenId: r.tokenId.value.toString(),
        airdropTx: r.airdropTx.value,
        recipients: Number(r.recipients.value),
      })
    }
  }
  return out
}

const SETTLEMENT_BATCH = 50

/** Claims a wallet currently OWNS — `ownedBy`, so a claim handed to this
 *  wallet shows up and one handed away does not. Newest first. */
export async function listClaimsOwnedBy(owner: Address): Promise<(ClaimView & { drop: Hex })[]> {
  const page = await arkivPublicClient()
    .select({ $key: true, $owner: true, drop: true, collector: true, claimedAt: true })
    .from(ClaimSchema)
    .ownedBy(owner)
    .createdBy(writer())
    .orderBy(desc('claimedAt'))
    .limit(50)
    .fetch()
  return (page.entities as unknown as (ClaimRow & { drop: { value: Hex } })[]).map((r) => ({
    key: normalizeEntityKey(r.$key),
    collector: r.collector.value.toLowerCase(),
    owner: r.$owner.toLowerCase(),
    claimedAt: Number(r.claimedAt.value),
    drop: normalizeEntityKey(r.drop.value),
  }))
}

/** Drops whose window closed between two instants — the reminder job's scan
 *  (lib/dropNotices), paged by `$key` like listClaims so every match is read
 *  exactly once. Bounded at ten pages a scan. */
export async function listDropsClosedBetween(fromSec: number, toSec: number): Promise<DropRecord[]> {
  const out: DropRecord[] = []
  const inWindow = between('closesAt', u64(BigInt(fromSec)), u64(BigInt(toSec)))
  let last: Hex | null = null
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const page = await arkivPublicClient()
      .select()
      .from(DropSchema, { onMismatch: 'throw' })
      .where(last ? and(inWindow, gt('$key', keyValue(last))) : inWindow)
      .createdBy(writer())
      .orderBy(asc('$key'))
      .limit(100)
      .fetch()
    const rows = page.entities as unknown as DropRow[]
    out.push(...rows.map(toDropRecord))
    if (rows.length < 100) break
    last = rows[rows.length - 1].$key
  }
  return out
}
