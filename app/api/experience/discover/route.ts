import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { discoverCapsuleMints } from '@/lib/experience/discovery'
import { getClaim, getMachine } from '@/lib/experience/store'

/**
 * Every capsule this player holds for this machine that still owes them a
 * play — INCLUDING capsules minted entirely outside this app.
 *
 * This is the route that closes the "minted on zora.co" gap: the capsule is a
 * plain Zora 1155, so any frontend can sell it, and only ours records the
 * transaction hash the play route needs. Discovery reads the mints straight
 * off the chain (see lib/experience/discovery for why that is one cheap,
 * cached, fully-filtered call), then subtracts what has already been
 * delivered. What remains is precisely the set of owed plays, whatever
 * frontend the capsule came from and whatever device it was bought on.
 *
 * Public and unauthenticated like the claims route, and for the same reason:
 * it reveals only on-chain-public facts (that an address minted a token) plus
 * claim states, and nothing here can move an artwork anywhere but to the
 * capsule's own recorded owner.
 */

/** Per-tx unit probe ceiling, matching the claims route: units are written
 *  from 0 upward, so the first gap ends the probe. */
const MAX_UNITS_PROBED = 20

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  // Tighter than the claims route: a miss costs an eth_getLogs round trip, and
  // the 30s discovery cache means honest refreshes mostly never reach it.
  if (!(await checkRateLimit(`xp-discover:${ip}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const url = new URL(req.url)
  const machineId = url.searchParams.get('machineId') ?? ''
  const account = (url.searchParams.get('account') ?? '').toLowerCase()

  if (!/^[a-z0-9-]{3,64}$/.test(machineId)) return errorResponse(400, 'Invalid machineId')
  if (!isAddress(account)) return errorResponse(400, 'Invalid account')

  const machine = await getMachine(machineId)
  if (!machine) return errorResponse(404, 'Machine not found')
  if (machine.state === 'draft' || machine.state === 'review') {
    return errorResponse(404, 'Machine not found')
  }

  const mints = await discoverCapsuleMints({
    collection: machine.capsule.collection,
    tokenId: machine.capsule.tokenId,
    account,
    createdBlock: machine.createdBlock,
  })

  // Subtract what is already settled. A unit is OWED unless its claim exists
  // and reached `delivered`; a claim in any other state is surfaced too, since
  // those are exactly the stalls the resume path exists for.
  const capsules = await Promise.all(
    mints.map(async (m) => {
      const owedUnits: number[] = []
      const probe = Math.min(m.units, MAX_UNITS_PROBED)
      for (let unit = 0; unit < probe; unit++) {
        const claim = await getClaim(machineId, m.txHash, unit).catch(() => null)
        if (!claim || claim.state !== 'delivered') owedUnits.push(unit)
      }
      return { txHash: m.txHash, units: m.units, owedUnits }
    }),
  )

  return NextResponse.json({
    capsules: capsules.filter((c) => c.owedUnits.length > 0),
  })
}
