import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getGateConfig } from '@/lib/gate'
import { getValidBalance } from '@/lib/pass-validity'
import { isPassBlacklisted } from '@/lib/pass-blacklist'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Public read of an address's Pass-collection validity. The profile
 * Collected tab overlays a "Valid Pass" badge on tokens from the
 * configured passCollection so the holder can confirm at a glance that
 * their Pass currently grants mint access (see ProfileView + MomentCard).
 *
 * Returns the configured `passCollection` so callers can match it against
 * a moment's collection address before rendering the badge — moments
 * from any other collection have no validity to display.
 *
 * Reads the stored ledger (`getValidBalance`) rather than running live
 * on-chain reconciliation (`hasValidPass`) — the badge can lag behind
 * actual on-chain state by up to one webhook delivery cycle, but reads
 * are cheap and the actual gate decision (mint enforcement) still runs
 * the live read. So the badge is eventually-consistent UX; policy stays
 * correct.
 *
 * Rate-limited 60/min/IP to bound enumeration probing.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`pass-validity:${ip}`, 60, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const address = req.nextUrl.searchParams.get('address')?.toLowerCase()
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }

  const config = await getGateConfig()
  if (!config.passCollection) {
    // Gate not configured — validity is meaningless. Return the shape so
    // the client doesn't need to special-case absence, just sees zero.
    return NextResponse.json({
      passCollection: null,
      validBalance: 0,
    })
  }

  // Pass-blacklist short-circuit: mirror what hasValidPass does at the
  // gate-check layer so the badge UX matches the actual mint policy. A
  // pass-blacklisted holder might still have a positive ledger value
  // (they hold the Pass on-chain, webhook credited them, admin
  // blacklisted them after) — surfacing `validBalance > 0` would
  // render a "valid Pass — gates mint access" badge that's a lie,
  // because hasValidPass returns false for them at mint time.
  if (await isPassBlacklisted(address)) {
    return NextResponse.json({
      passCollection: config.passCollection,
      validBalance: 0,
    })
  }

  const validBalance = await getValidBalance(config.passCollection, address)
  return NextResponse.json({
    passCollection: config.passCollection,
    validBalance,
  })
}
