import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { readOperatorGrantScope } from '@/lib/experience/authority'
import { experienceOperator } from '@/lib/experience/delivery'
import { getMachine, machinesUsingPiece } from '@/lib/experience/store'

/**
 * One artwork's standing with capsule machines: the operator an artist grants
 * mint rights to, whether (and how) they have, and the public machines that
 * include the piece. Read by the allowance panel on the artwork page.
 *
 * The operator comes from here rather than from a public build-time constant
 * because it is derived from the delivery account itself (see
 * delivery.experienceOperator) — the address the artist grants to is, by
 * construction, the address that signs.
 *
 * Only public machines are listed. A machine in review or draft is not public
 * anywhere else, and this route answers anyone.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`xp-piece:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const url = new URL(req.url)
  const collection = (url.searchParams.get('collection') ?? '').toLowerCase()
  const rawToken = url.searchParams.get('tokenId') ?? ''
  if (!isAddress(collection)) return errorResponse(400, 'Invalid collection')
  if (!/^\d+$/.test(rawToken)) return errorResponse(400, 'Invalid tokenId')
  const tokenId = BigInt(rawToken).toString()

  const operator = await experienceOperator()
  if (!operator) return NextResponse.json({ operator: null, allowed: null, scope: null, machines: [] })

  const [scope, ids] = await Promise.all([
    readOperatorGrantScope(collection, tokenId),
    machinesUsingPiece(collection, tokenId).catch(() => [] as string[]),
  ])
  const machines = (await Promise.all(ids.map((id) => getMachine(id).catch(() => null))))
    .filter((m) => m !== null && (m.state === 'live' || m.state === 'ended' || m.state === 'delisted'))
    .map((m) => ({ id: m!.id, name: m!.name, state: m!.state }))

  return NextResponse.json({
    operator,
    allowed: scope === undefined ? null : scope !== null,
    scope: scope ?? null,
    machines,
  })
}
