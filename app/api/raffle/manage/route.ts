import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { authorizeRaffleManager } from '@/lib/raffleAuth'
import type { RaffleAction } from '@/lib/raffleManageMessage'
import {
  clearRaffleEnabled,
  endRaffle,
  getEligibleEntrants,
  isEntered,
  reopenRaffle,
  setEntriesCloseAt,
  setRaffleEnabled,
} from '@/lib/raffle'

const ACTIONS: RaffleAction[] = ['enable', 'disable', 'setCloseAt', 'drawAndEnd', 'reopen']

/**
 * Self-serve raffle management for a moment. The caller signs a nonce'd message
 * (see lib/raffleManageMessage) and is authorized as the moment's creator, a
 * moment admin, or the platform admin (lib/raffleAuth — same model as
 * /api/distribute). Actions:
 *
 *   enable      — turn the raffle on; snapshot entriesCloseAt (sale end).
 *   disable     — turn it off (entrants kept for a later re-enable).
 *   setCloseAt  — edit / clear the entries auto-close time ("close now" = now).
 *   drawAndEnd  — pick the winner from ELIGIBLE entrants (those who still hold
 *                 the edition — entered-then-sold are excluded) and finalize.
 *                 Random by default; an explicit `winner` allows a manual pick.
 *   reopen      — un-end (clear winner, reopen entries).
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`raffle-manage:${ip}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const body = (await req.json().catch(() => null)) as {
    action?: string
    collection?: string
    tokenId?: string
    callerAddress?: string
    signature?: string
    nonce?: string
    winner?: string | null
    closeAt?: number | null
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const action = body.action as RaffleAction | undefined
  const collection = body.collection?.toLowerCase()
  const tokenId = body.tokenId
  const address = body.callerAddress?.toLowerCase()

  if (!action || !ACTIONS.includes(action)) return errorResponse(400, 'Invalid action')
  if (!collection || !isAddress(collection)) return errorResponse(400, 'Invalid collection')
  if (!tokenId || !/^\d+$/.test(tokenId)) return errorResponse(400, 'Invalid tokenId')

  // Normalize the action params up front so the signed message and the effect
  // use identical values.
  const closeAt =
    typeof body.closeAt === 'number' && Number.isFinite(body.closeAt)
      ? Math.floor(body.closeAt)
      : null
  const winner = body.winner ? body.winner.toLowerCase() : null
  if (winner && !isAddress(winner)) return errorResponse(400, 'Invalid winner address')

  const auth = await authorizeRaffleManager({
    action,
    collection,
    tokenId,
    address: address ?? '',
    nonce: body.nonce ?? '',
    signature: body.signature ?? '',
    ...(action === 'enable' || action === 'setCloseAt' ? { closeAt } : {}),
    ...(action === 'drawAndEnd' ? { winner } : {}),
  })
  if (!auth.ok) return errorResponse(auth.status, auth.error)

  switch (action) {
    case 'enable':
      await setRaffleEnabled(collection, tokenId)
      await setEntriesCloseAt(collection, tokenId, closeAt)
      return NextResponse.json({ ok: true, enabled: true, entriesCloseAt: closeAt })

    case 'disable':
      await clearRaffleEnabled(collection, tokenId)
      return NextResponse.json({ ok: true, enabled: false })

    case 'setCloseAt':
      await setEntriesCloseAt(collection, tokenId, closeAt)
      return NextResponse.json({ ok: true, entriesCloseAt: closeAt })

    case 'drawAndEnd': {
      const eligible = await getEligibleEntrants(collection, tokenId)
      if (winner) {
        // Manual pick — must be an entrant who still holds the edition.
        if (!(await isEntered(collection, tokenId, winner))) {
          return errorResponse(400, 'That address is not an entrant')
        }
        if (!eligible.some((e) => e.address === winner)) {
          return errorResponse(400, 'That entrant no longer holds the edition')
        }
        await endRaffle(collection, tokenId, winner)
        return NextResponse.json({ ok: true, ended: true, winner })
      }
      // Random draw from eligible holders.
      if (eligible.length === 0) {
        return errorResponse(400, 'No eligible entrants — nobody who entered still holds the edition')
      }
      const chosen = eligible[Math.floor(Math.random() * eligible.length)].address
      await endRaffle(collection, tokenId, chosen)
      return NextResponse.json({ ok: true, ended: true, winner: chosen })
    }

    case 'reopen':
      await reopenRaffle(collection, tokenId)
      return NextResponse.json({ ok: true, ended: false })
  }
}
