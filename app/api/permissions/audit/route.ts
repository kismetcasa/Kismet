import { NextRequest, NextResponse } from 'next/server'
import { type Address, verifyMessage } from 'viem'
import { isAddress } from '@/lib/address'
import { redis } from '@/lib/redis'
import { getCollectionMeta, getTrackedCollections } from '@/lib/kv'
import { PLATFORM_COLLECTION } from '@/lib/config'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { resolveSmartWallet } from '@/lib/resolveSmartWallet'
import { serverBaseClient } from '@/lib/rpc'

const ADMIN_ADDRESS = (process.env.ADMIN_ADDRESS ?? '').toLowerCase()
const SESSION_TTL = 4 * 60 * 60 * 1000

async function verifyAdminSession(body: {
  signature?: string
  timestamp?: number
}): Promise<{ error: string; status: number } | null> {
  if (!ADMIN_ADDRESS) return { error: 'Admin not configured', status: 403 }
  if (!body.signature || body.timestamp == null) {
    return { error: 'signature and timestamp required', status: 400 }
  }
  if (Date.now() - body.timestamp > SESSION_TTL) {
    return { error: 'Session expired — please sign in again', status: 401 }
  }
  const message = `Kismet Art admin session\nAddress: ${ADMIN_ADDRESS}\nTimestamp: ${body.timestamp}`
  const verified = await verifyMessage({
    address: ADMIN_ADDRESS as `0x${string}`,
    message,
    signature: body.signature as `0x${string}`,
  })
  if (!verified) return { error: 'Signature verification failed', status: 401 }
  return null
}

// Cached at kismetart:collection-perms:<addr>. `perms` is bigint-as-string
// since JSON.stringify can't serialize bigints natively.
interface CollectionPermsCacheEntry {
  collection: string
  artist: string | null
  smartWallet: string | null
  perms: string
  hasAdmin: boolean
  checkedAt: number
  error?: string
}

const cacheKey = (addr: string) =>
  `kismetart:collection-perms:${addr.toLowerCase()}`

async function writeCacheEntry(entry: CollectionPermsCacheEntry): Promise<void> {
  try {
    await redis.set(cacheKey(entry.collection), JSON.stringify(entry))
  } catch (err) {
    console.error('[permissions/audit] cache write failed', {
      collection: entry.collection,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Audit one collection. Captures any error path in the returned `error`
 * field so the batch caller doesn't abort on the first hiccup.
 */
async function auditOne(
  client: ReturnType<typeof serverBaseClient>,
  collection: string,
): Promise<CollectionPermsCacheEntry> {
  const checkedAt = Date.now()
  const meta = await getCollectionMeta(collection)
  const artist = meta?.artist ?? null

  if (!artist || !isAddress(artist)) {
    const entry: CollectionPermsCacheEntry = {
      collection,
      artist: null,
      smartWallet: null,
      perms: '0',
      hasAdmin: false,
      checkedAt,
      error: 'no artist recorded in KV meta',
    }
    await writeCacheEntry(entry)
    return entry
  }

  const smartWallet = await resolveSmartWallet(artist)

  if (!smartWallet) {
    const entry: CollectionPermsCacheEntry = {
      collection,
      artist,
      smartWallet: null,
      perms: '0',
      hasAdmin: false,
      checkedAt,
      error: 'smartwallet lookup failed or returned no address',
    }
    await writeCacheEntry(entry)
    return entry
  }

  let perms: bigint
  try {
    perms = await readPermissions(client, collection as Address, 0n, smartWallet as Address)
  } catch (err) {
    const entry: CollectionPermsCacheEntry = {
      collection,
      artist,
      smartWallet,
      perms: '0',
      hasAdmin: false,
      checkedAt,
      error: err instanceof Error ? err.message : String(err),
    }
    await writeCacheEntry(entry)
    return entry
  }

  const entry: CollectionPermsCacheEntry = {
    collection,
    artist,
    smartWallet,
    perms: perms.toString(),
    hasAdmin: hasAdminBit(perms),
    checkedAt,
  }
  await writeCacheEntry(entry)
  return entry
}

// Public-facing audit row. Strips the cache's `error` string (which can
// include raw RPC errors and internal infra signals) — replaced with a
// coarse `errored: boolean`. Detailed errors stay in the cache for the
// admin-gated POST response.
interface PublicAuditResult {
  collection: string
  artist: string | null
  smartWallet: string | null
  perms: string
  hasAdmin: boolean
  checkedAt: number
  errored: boolean
}

function toPublicResult(entry: CollectionPermsCacheEntry): PublicAuditResult {
  return {
    collection: entry.collection,
    artist: entry.artist,
    smartWallet: entry.smartWallet,
    perms: entry.perms,
    hasAdmin: entry.hasAdmin,
    checkedAt: entry.checkedAt,
    errored: !!entry.error,
  }
}

/**
 * GET /api/permissions/audit — public read of last-known cached results.
 * Empty array if nothing has been audited yet. Smart-wallet ↔ artist EOA
 * pairs are derivable from on-chain events anyway, so direct disclosure
 * is fine; only the raw error strings are redacted (see
 * `PublicAuditResult`).
 */
export async function GET() {
  const tracked = await getTrackedCollections()
  const platformLower = PLATFORM_COLLECTION.toLowerCase()
  const addresses = tracked.filter(
    (a) => a.toLowerCase() !== platformLower && isAddress(a),
  )
  if (addresses.length === 0) return NextResponse.json({ results: [] })
  const keys = addresses.map(cacheKey)
  let raws: (string | CollectionPermsCacheEntry | null)[] = []
  try {
    raws = await redis.mget<(string | CollectionPermsCacheEntry | null)[]>(...keys)
  } catch {
    return NextResponse.json({ results: [] })
  }
  const results: PublicAuditResult[] = []
  for (let i = 0; i < addresses.length; i++) {
    const raw = raws[i]
    if (!raw) continue
    // Guard per-entry parse: one corrupt entry shouldn't 500 the whole
    // response and hide every other collection's status.
    try {
      const entry =
        typeof raw === 'string' ? (JSON.parse(raw) as CollectionPermsCacheEntry) : raw
      results.push(toPublicResult(entry))
    } catch (err) {
      console.error('[permissions/audit GET] could not parse cache entry', {
        address: addresses[i],
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return NextResponse.json({ results })
}

/**
 * POST /api/permissions/audit — admin-only. Audits every tracked
 * collection, persists to cache, returns the full summary including the
 * verbose `error` field for each row.
 *
 * Skips PLATFORM_COLLECTION (the boot healthcheck audits that against
 * OPERATOR_SMART_WALLET, not per-artist). Concurrency capped at 10 to
 * stay within RPC + Upstash burst limits.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    signature?: string
    timestamp?: number
  }
  const err = await verifyAdminSession(body)
  if (err) return NextResponse.json({ error: err.error }, { status: err.status })

  const tracked = await getTrackedCollections()
  const platformLower = PLATFORM_COLLECTION.toLowerCase()
  const toAudit = tracked.filter(
    (a) => a.toLowerCase() !== platformLower && isAddress(a),
  )

  const client = serverBaseClient()
  const results: CollectionPermsCacheEntry[] = []
  const BATCH = 10
  for (let i = 0; i < toAudit.length; i += BATCH) {
    const chunk = toAudit.slice(i, i + BATCH)
    const chunkResults = await Promise.all(
      chunk.map((addr) => auditOne(client, addr)),
    )
    results.push(...chunkResults)
  }

  const ok = results.filter((r) => r.hasAdmin).length
  const missing = results.filter((r) => !r.hasAdmin && !r.error).length
  const errors = results.filter((r) => r.error).length

  return NextResponse.json({
    checked: results.length,
    ok,
    missing,
    errors,
    results,
  })
}
