// lib/arkiv/drops.ts for scripts/e2e/drops-flow.ts — the same exports and
// contracts, held in memory, because an Arkiv write needs a funded testnet
// key. What the real module guarantees and the app relies on is kept:
//
//   - every entity is created by the writer and handed to its user in the
//     same write (owner = artist / collector), and reads only trust entities
//     the writer created ($creator);
//   - an entity is gone once it expires (the drop's close plus the settle
//     grace, recordExpiresAt), and expiry is read off the clock the harness
//     moves;
//   - `str` columns refuse more than 128 bytes (Arkiv's MAX_STRING_BYTES);
//   - the orderings and limits of each query (open: soonest first, 24;
//     settling: newest first, 24; owned claims: newest first, 50).
//
// The real queries are run against Rabdi by scripts/e2e/drops-arkiv-live.ts.
import { randomBytes } from 'node:crypto'
import type { Address, Hex } from 'viem'
import { arkivWriterAddress, type ArkivCreateResult } from '../../lib/arkiv/client.ts'
import {
  ARKIV_STR_MAX_BYTES,
  normalizeEntityKey,
  recordExpiresAt,
  type ClaimView,
  type DropRecord,
  type DropView,
  type OpenDropFields,
  type SettlementView,
} from '../../lib/drops.ts'

export interface SignedIntent {
  signature: Hex
  nonce: string
  expiresAt: number
}

type Kind = 'drop' | 'claim' | 'settlement'

interface Entity {
  key: Hex
  kind: Kind
  creator: string
  owner: string
  expiresAt: number
  values: Record<string, string | number | bigint>
}

export const arkiv = {
  entities: new Map<string, Entity>(),
  writes: 0,
  /** A collector handing their claim to another wallet (only an EOA owner can). */
  transfer(key: string, newOwner: string): void {
    const e = arkiv.entities.get(key.toLowerCase())
    if (!e) throw new Error(`no entity ${key}`)
    e.owner = newOwner.toLowerCase()
  },
}

const nowSec = () => Math.floor(Date.now() / 1000)
const hex32 = (): Hex => `0x${randomBytes(32).toString('hex')}`

function writer(): string {
  const w = arkivWriterAddress()
  if (!w) throw new Error('Arkiv is not configured (set ARKIV_WRITER_PRIVATE_KEY)')
  return w.toLowerCase()
}

function str(value: string, column: string): string {
  if (Buffer.byteLength(value, 'utf8') > ARKIV_STR_MAX_BYTES) {
    throw new Error(`Arkiv str column ${column} is over ${ARKIV_STR_MAX_BYTES} bytes`)
  }
  return value
}

function create(kind: Kind, owner: Address, expiresAt: number, values: Entity['values']): ArkivCreateResult {
  const key = hex32()
  arkiv.entities.set(key, { key, kind, creator: writer(), owner: owner.toLowerCase(), expiresAt, values })
  arkiv.writes++
  return { entityKey: key, txHash: hex32() }
}

/** Live, writer-created entities of a kind — what `createdBy(writer)` reads. */
function live(kind: Kind): Entity[] {
  const t = nowSec()
  const w = writer()
  return [...arkiv.entities.values()].filter((e) => e.kind === kind && e.creator === w && e.expiresAt > t)
}

// ── Writes ───────────────────────────────────────────────────────────────

export async function writeDrop(input: {
  artist: Address
  fields: OpenDropFields
  intent: SignedIntent
  recordExpiresAtOverride?: number
}): Promise<ArkivCreateResult> {
  const { artist, fields, intent } = input
  return create('drop', artist, input.recordExpiresAtOverride ?? recordExpiresAt(fields.closesAt), {
    artist: artist.toLowerCase(),
    closesAt: fields.closesAt,
    maxClaims: fields.maxClaims,
    title: str(fields.title, 'title'),
    description: fields.description,
    swarmRef: str(fields.swarmRef, 'swarmRef'),
    mime: str(fields.mime, 'mime'),
    intentNonce: str(intent.nonce, 'intentNonce'),
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
  return create('claim', input.collector, input.recordExpiresAtOverride ?? recordExpiresAt(input.dropClosesAt), {
    drop: normalizeEntityKey(input.dropKey),
    collector: input.collector.toLowerCase(),
    claimedAt: input.claimedAt,
    intentNonce: str(input.intent.nonce, 'intentNonce'),
  })
}

export async function writeSettlement(input: {
  dropKey: Hex
  dropClosesAt: number
  artist: Address
  collection: Address
  tokenId: bigint
  airdropTx: Hex
  recipients: number
}): Promise<ArkivCreateResult> {
  return create('settlement', input.artist, recordExpiresAt(input.dropClosesAt), {
    drop: normalizeEntityKey(input.dropKey),
    collection: input.collection.toLowerCase(),
    tokenId: input.tokenId,
    airdropTx: str(input.airdropTx, 'airdropTx'),
    recipients: input.recipients,
  })
}

// ── Reads ────────────────────────────────────────────────────────────────

function toDrop(e: Entity): DropRecord {
  const v = e.values
  return {
    key: normalizeEntityKey(e.key),
    artist: String(v.artist),
    owner: e.owner,
    title: String(v.title),
    description: String(v.description ?? ''),
    swarmRef: String(v.swarmRef),
    mime: String(v.mime),
    closesAt: Number(v.closesAt),
    maxClaims: Number(v.maxClaims),
  }
}

function toClaim(e: Entity): ClaimView {
  return { key: normalizeEntityKey(e.key), collector: String(e.values.collector), owner: e.owner, claimedAt: Number(e.values.claimedAt) }
}

export async function getDrop(dropKey: Hex): Promise<DropRecord | null> {
  const e = live('drop').find((d) => d.key === dropKey.toLowerCase())
  return e ? toDrop(e) : null
}

export async function countClaims(dropKey: Hex): Promise<number> {
  return live('claim').filter((c) => c.values.drop === dropKey.toLowerCase()).length
}

async function withCounts(drops: Entity[]): Promise<DropView[]> {
  return Promise.all(drops.map(async (d) => ({ ...toDrop(d), claimCount: await countClaims(d.key) })))
}

export async function listOpenDrops(now: number): Promise<DropView[]> {
  const rows = live('drop').filter((d) => Number(d.values.closesAt) > now)
  rows.sort((a, b) => Number(a.values.closesAt) - Number(b.values.closesAt))
  return withCounts(rows.slice(0, 24))
}

export async function listSettlingDrops(now: number): Promise<DropView[]> {
  const rows = live('drop').filter((d) => Number(d.values.closesAt) <= now)
  rows.sort((a, b) => Number(b.values.closesAt) - Number(a.values.closesAt))
  return withCounts(rows.slice(0, 24))
}

export async function listClaims(dropKey: Hex): Promise<ClaimView[]> {
  return live('claim')
    .filter((c) => c.values.drop === dropKey.toLowerCase())
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map(toClaim)
}

export async function getSettlements(dropKeys: Hex[]): Promise<Map<string, SettlementView>> {
  const wanted = new Set(dropKeys.map((k) => k.toLowerCase()))
  const out = new Map<string, SettlementView>()
  for (const s of live('settlement')) {
    if (!wanted.has(String(s.values.drop))) continue
    out.set(String(s.values.drop), {
      key: normalizeEntityKey(s.key),
      collection: String(s.values.collection),
      tokenId: String(s.values.tokenId),
      airdropTx: String(s.values.airdropTx),
      recipients: Number(s.values.recipients),
    })
  }
  return out
}

export async function listClaimsOwnedBy(owner: Address): Promise<(ClaimView & { drop: Hex })[]> {
  return live('claim')
    .filter((c) => c.owner === owner.toLowerCase())
    .sort((a, b) => Number(b.values.claimedAt) - Number(a.values.claimedAt))
    .slice(0, 50)
    .map((c) => ({ ...toClaim(c), drop: String(c.values.drop) as Hex }))
}

export async function listDropsClosedBetween(fromSec: number, toSec: number): Promise<DropRecord[]> {
  return live('drop')
    .filter((d) => Number(d.values.closesAt) >= fromSec && Number(d.values.closesAt) <= toSec)
    .map(toDrop)
}
