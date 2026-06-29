import { NextResponse } from 'next/server'
import { getEnabledRaffles } from '@/lib/raffle'

/**
 * GET /api/raffle/enabled — public. The full set of moments that have a raffle
 * (active or ended). The client loads this once on mount
 * (AdminContext.raffleEnabledKeys) so owned-edition surfaces decide "enter
 * raffle" vs "list" synchronously, with no per-card request.
 *
 * Enabling/disabling and the rest of the lifecycle (close, draw & end, reopen)
 * live in /api/raffle/manage, which is self-serve: authorized for the moment's
 * creator / a moment admin / the platform admin via a signed message.
 */
export async function GET() {
  const enabled = await getEnabledRaffles()
  return NextResponse.json({ enabled })
}
