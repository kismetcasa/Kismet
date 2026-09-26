import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { readArtistControl, readOperatorGrantScope } from '@/lib/experience/authority'
import { experienceOperator } from '@/lib/experience/delivery'
import { getMachine, machinesUsingPiece, optedOutPieces, setPieceAvailable } from '@/lib/experience/store'
import { getMomentMeta } from '@/lib/notifications'

/**
 * One artwork's standing with machines: whether its artist leaves it available
 * to reveal machines (the default), the operator an artist grants mint rights
 * to for their own capsule machines and whether they have, the public machines
 * that include the piece, and the artist Kismet recorded minting it. Read by
 * the machines panel on the artwork page, and by the studio to say whether a
 * pasted piece can go in before any check runs.
 *
 * The operator comes from here rather than from a public build-time constant
 * because it is derived from the delivery account itself (see
 * delivery.experienceOperator) — the address the artist grants to is, by
 * construction, the address that signs.
 *
 * Only public machines are listed. A machine in review or draft is not public
 * anywhere else, and this route answers anyone.
 */
function parsePiece(collection: unknown, tokenId: unknown): { collection: string; tokenId: string } | null {
  const c = String(collection ?? '').toLowerCase()
  const t = String(tokenId ?? '')
  if (!isAddress(c) || !/^\d+$/.test(t)) return null
  return { collection: c, tokenId: BigInt(t).toString() }
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`xp-piece:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const url = new URL(req.url)
  const piece = parsePiece(url.searchParams.get('collection'), url.searchParams.get('tokenId'))
  if (!piece) return errorResponse(400, 'Invalid artwork')
  const { collection, tokenId } = piece

  const [operator, meta, optedOut, ids] = await Promise.all([
    experienceOperator(),
    getMomentMeta(collection, tokenId).catch(() => null),
    optedOutPieces([piece]).catch(() => null),
    machinesUsingPiece(collection, tokenId).catch(() => [] as string[]),
  ])
  // A hint, not an attestation: the capsule gate still requires the creator
  // to hold ADMIN on the piece.
  const artist = meta?.creator ? meta.creator.toLowerCase() : null
  const scope = operator ? await readOperatorGrantScope(collection, tokenId) : undefined
  const machines = (await Promise.all(ids.map((id) => getMachine(id).catch(() => null))))
    .filter((m) => m !== null && (m.state === 'live' || m.state === 'ended' || m.state === 'delisted'))
    .map((m) => ({ id: m!.id, name: m!.name, state: m!.state, kind: m!.kind ?? 'capsule' }))

  return NextResponse.json({
    available: optedOut === null ? null : optedOut.size === 0,
    operator,
    allowed: scope === undefined ? null : scope !== null,
    scope: scope ?? null,
    machines,
    artist,
  })
}

/**
 * The artist's switch: may reveal machines show this piece? On by default, so
 * every Kismet artwork can be curated; off takes it out of every reveal machine
 * at once, including ones already live.
 *
 * Held to the same right as everything else an artist changes about a piece:
 * the signed-in wallet must hold admin on it, read from the chain.
 */
export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`xp-piece-set:${getClientIp(req)}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const session = await getSessionAddress(req).catch(() => null)
  if (!session || !isAddress(session)) return errorResponse(401, 'Sign in to change this')
  const body = (await req.json().catch(() => null)) as { collection?: string; tokenId?: string; available?: unknown } | null
  const piece = parsePiece(body?.collection, body?.tokenId)
  if (!piece) return errorResponse(400, 'Invalid artwork')
  if (typeof body?.available !== 'boolean') return errorResponse(400, 'Say whether it is available')

  const admin = await readArtistControl(piece.collection, piece.tokenId, session.toLowerCase())
  if (admin === undefined) return errorResponse(503, 'Could not confirm you manage this artwork — try again')
  if (!admin) return errorResponse(403, 'Only someone who manages this artwork can change this')

  await setPieceAvailable(piece.collection, piece.tokenId, body.available)
  return NextResponse.json({ ok: true, available: body.available })
}
