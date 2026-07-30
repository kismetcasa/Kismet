import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getGateConfig, getPassCollectionName } from '@/lib/gate'
import { getValidBalance, getValidBalances } from '@/lib/pass-validity'
import { isPassBlacklisted } from '@/lib/pass-blacklist'
import { expandToGateWallets } from '@/lib/addressUnion'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Public read of an address's Pass-collection validity. Two scopes:
 *
 *   default (per-address) — the profile Collected tab overlays a "Valid
 *   Pass" badge on tokens from the configured passCollection so the holder
 *   can confirm at a glance that their Pass currently grants mint access
 *   (see ProfileView + MomentCard). A badge on a token is a statement about
 *   THAT wallet's holding, so this scope never aggregates.
 *
 *   ?scope=identity — the gate-hint scope used by usePassGate: validity
 *   summed over the address's FC-verified sibling union
 *   (expandToGateWallets), zeroed when ANY union member is pass-blacklisted.
 *   Mirrors hasGateAccess's union semantics exactly so the "collect from
 *   <name>" CTA can never disagree with the server's mint verdict — the
 *   Mini App case where the connected signer is the host wallet while the
 *   Pass lives on a sibling (see PATRON_GATE_MINIAPP_RCA.md). Exposes
 *   nothing non-public: per-address balances are already enumerable here,
 *   and the sibling graph is public Farcaster data.
 *
 * Returns the configured `passCollection` so callers can match it against
 * a moment's collection address before rendering the badge — moments
 * from any other collection have no validity to display.
 *
 * Reads the stored ledger (`getValidBalance`/`getValidBalances`) rather
 * than running live on-chain reconciliation (`hasValidPass`) — the answer
 * can lag behind actual on-chain state by up to one webhook delivery
 * cycle, but reads are cheap and the actual gate decision (mint
 * enforcement) still runs the live read. So both scopes are
 * eventually-consistent UX; policy stays correct.
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
      enabled: false,
      passCollection: null,
      passCollectionName: null,
      validBalance: 0,
    })
  }

  // Live collection name (cached) so the gate UI can render "collect from
  // <name>" instead of a hardcoded label.
  const passCollectionName = await getPassCollectionName(config.passCollection)

  // Identity scope — union-aggregated hint for the gate CTA. The queried
  // address is always first in the union, so the per-address blacklist
  // short-circuit below is subsumed by this loop.
  if (req.nextUrl.searchParams.get('scope') === 'identity') {
    const wallets = await expandToGateWallets(address)
    let validBalance = 0
    let blacklisted = false
    for (const wallet of wallets) {
      if (await isPassBlacklisted(wallet)) { blacklisted = true; break }
    }
    if (!blacklisted) {
      const balances = await getValidBalances(config.passCollection, wallets)
      validBalance = balances.reduce((sum, b) => sum + b, 0)
    }
    return NextResponse.json({
      enabled: config.enabled,
      passCollection: config.passCollection,
      passCollectionName,
      validBalance,
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
      enabled: config.enabled,
      passCollection: config.passCollection,
      passCollectionName,
      validBalance: 0,
    })
  }

  const validBalance = await getValidBalance(config.passCollection, address)
  return NextResponse.json({
    // `enabled` lets gate-aware UI (e.g. MintForm's "collect from <name>" CTA)
    // tell "gate configured but off" from "gate actively enforcing". When off,
    // the CTA must not fire — everyone can still mint.
    enabled: config.enabled,
    passCollection: config.passCollection,
    passCollectionName,
    validBalance,
  })
}
