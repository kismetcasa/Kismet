import { NextResponse } from 'next/server'
import { TurboFactory } from '@ardrive/turbo-sdk'
import { redis, FEATURED_KEY, TRENDING_KEY } from '@/lib/redis'
import { verifyAdminSession } from '@/lib/curator'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Upstash's per-request size cap. The created-mints SMEMBERS in the Mints feed
// hard-fails (not just slows) once the full set crosses this on the wire, so
// this endpoint surfaces how close we are. See REMEDIATION_PLAYBOOK.md §A2.
const REQUEST_CAP_BYTES = 10 * 1024 * 1024
// Approx wire bytes per created-mints member: "<0x40-hex-addr>:<tokenId>".
const APPROX_MEMBER_BYTES = 46

// Key literals mirror the (module-private) constants in lib/kv.ts and
// lib/listings.ts. Duplicated here intentionally: this is a read-only ops
// gauge, so a rename just shows null rather than breaking anything.
const KEY_CREATED_MINTS = 'kismetart:created-mints'
const KEY_COLLECTIONS = 'kismetart:collections'
const KEY_CREATED_COLLECTIONS = 'kismetart:created-collections'
const KEY_LISTINGS = 'kismetart:listings'

// Funder balance via the Turbo SDK (authenticates with the JWK directly — no
// address derivation). The drain backstop is operational, so seeing the
// balance here is the cheapest alerting hook (pair with a threshold alert).
async function arweaveBalanceWinc(): Promise<string | null> {
  const key = process.env.ARWEAVE_JWK
  if (!key) return null
  try {
    const jwk = JSON.parse(Buffer.from(key, 'base64').toString())
    const turbo = TurboFactory.authenticated({ privateKey: jwk })
    const { winc } = await turbo.getBalance()
    return String(winc)
  } catch {
    return null
  }
}

/**
 * Admin-only operational gauges. Every Redis read here is O(1) (DBSIZE /
 * SCARD / ZCARD) — deliberately NEVER SMEMBERS/ZRANGE the growing sets, which
 * is the very anti-pattern this endpoint exists to watch. Reuses the
 * cookie-based admin session (lib/curator) so there's no new auth surface.
 */
export async function GET() {
  const session = await verifyAdminSession()
  if ('error' in session) {
    return NextResponse.json({ error: session.error }, { status: session.status })
  }

  const [
    dbsize,
    createdMints,
    collections,
    createdCollections,
    listings,
    trending,
    featured,
    arweaveWinc,
  ] = await Promise.all([
    redis.dbsize().catch(() => null),
    redis.scard(KEY_CREATED_MINTS).catch(() => null),
    redis.scard(KEY_COLLECTIONS).catch(() => null),
    redis.scard(KEY_CREATED_COLLECTIONS).catch(() => null),
    redis.zcard(KEY_LISTINGS).catch(() => null),
    redis.zcard(TRENDING_KEY).catch(() => null),
    redis.zcard(FEATURED_KEY).catch(() => null),
    arweaveBalanceWinc(),
  ])

  const createdMintsBytes =
    typeof createdMints === 'number' ? createdMints * APPROX_MEMBER_BYTES : null
  const pctOfCap =
    createdMintsBytes != null ? Number((createdMintsBytes / REQUEST_CAP_BYTES).toFixed(3)) : null

  return NextResponse.json(
    {
      timestamp: Date.now(),
      redis: { dbsize, createdMints, collections, createdCollections, listings, trending, featured },
      // Leading indicator for the SMEMBERS 10 MB hard-fail on the Mints feed.
      // When createdMintsPctOf10MBCap approaches 1.0, the materialized-feed /
      // Postgres migration becomes urgent rather than architectural-someday.
      cliff: {
        createdMintsApproxBytes: createdMintsBytes,
        createdMintsPctOf10MBCap: pctOfCap,
      },
      arweave: { balanceWinc: arweaveWinc },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
