import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getSessionAddress } from '@/lib/session'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import {
  dropCreatorGrant,
  listAuthorizedCreators,
  saveCreatorGrant,
  startCreatorGrant,
} from '@/lib/authorizedCreators'
import { errorResponse, upstreamError } from '@/lib/apiResponse'

// GET /api/collection/authorized-creators?collection=0x… — the creators panel's
// list: the grants the panel recorded (EOA → smart wallet, with the label the
// admin typed), merged with the chain. Every other address holding ADMIN at
// token 0 comes back as an `unmapped` row — a grant made on etherscan, or one
// whose save never landed — so it can be seen and revoked. Started grants the
// chain has confirmed are recorded on the way. See lib/authorizedCreators.ts.
//
// Public like before (who holds ADMIN is public on chain), but it now reads
// the chain, inprocess and, once per cache window, the collection's
// UpdatedPermissions logs, so it is rate limited per client.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collection = searchParams.get('collection')
  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (!(await checkRateLimit(`authorized-creators:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests — try again in a minute')
  }
  try {
    const creators = await listAuthorizedCreators(collection)
    return NextResponse.json({ creators })
  } catch (err) {
    // The records couldn't be read. Answering an empty or chain-only list
    // would relabel every recorded creator as unmapped; the panel keeps what
    // it last showed instead.
    return upstreamError(503, 'Could not load authorized creators', err, 'authorized-creators')
  }
}

interface PostBody {
  collection?: string
  /** EOA the admin authorized — what they typed (or the address an
   *  ENS name resolved to client-side). */
  eoa?: string
  /** Pre-resolved smart wallet for `eoa`. Server re-resolves to verify
   *  the client didn't fabricate a mapping. */
  smartWallet?: string
  /** Optional ENS / display label captured at grant time. */
  label?: string
  /** 'pending': the grant is about to be sent — record it as started (every
   *  check runs now, while nothing is on chain). Absent: record the grant. */
  stage?: string
}

// POST /api/collection/authorized-creators — record an EOA→smart-wallet
// mapping, or (stage: 'pending') a grant about to be sent. Auth required;
// caller must hold ADMIN on-chain (same gate Zora enforces on addPermission).
export async function POST(req: NextRequest) {
  const viewer = await getSessionAddress(req)
  if (!viewer) {
    return errorResponse(401, 'Sign in to continue')
  }

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const { collection, eoa, smartWallet, label, stage } = body
  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (!eoa || !isAddress(eoa)) {
    return errorResponse(400, 'Invalid eoa')
  }
  if (!smartWallet || !isAddress(smartWallet)) {
    return errorResponse(400, 'Invalid smartWallet')
  }
  if (stage !== undefined && stage !== 'pending') {
    return errorResponse(400, 'Invalid stage')
  }

  const input = { collection, eoa, smartWallet, label }
  if (stage === 'pending') {
    const started = await startCreatorGrant(viewer, input)
    if (!started.ok) return errorResponse(started.status, started.error)
    return NextResponse.json({ ok: true, pending: started.value })
  }
  const saved = await saveCreatorGrant(viewer, input)
  if (!saved.ok) return errorResponse(saved.status, saved.error)
  return NextResponse.json({ ok: true, creator: saved.value })
}

// DELETE /api/collection/authorized-creators?collection=…&eoa=… — drop a
// mapping (and any started grant for it). Same admin gate as POST; the
// on-chain revoke happens separately on the client (the admin signs a
// `removePermission` tx). We don't conflate the two: the chain is the source
// of truth for permissions, KV only carries the EOA-display reverse lookup.
export async function DELETE(req: NextRequest) {
  const viewer = await getSessionAddress(req)
  if (!viewer) {
    return errorResponse(401, 'Sign in to continue')
  }
  const { searchParams } = new URL(req.url)
  const collection = searchParams.get('collection')
  const eoa = searchParams.get('eoa')
  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (!eoa || !isAddress(eoa)) {
    return errorResponse(400, 'Invalid eoa')
  }
  const dropped = await dropCreatorGrant(viewer, collection, eoa)
  if (!dropped.ok) return errorResponse(dropped.status, dropped.error)
  return NextResponse.json({ ok: true })
}
