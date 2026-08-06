import { randomInt } from 'node:crypto'
import { NextRequest, NextResponse, after } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { bestEffort } from '@/lib/bestEffort'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { recordAdminAction } from '@/lib/adminAudit'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { authorizeRaffleManager } from '@/lib/raffleAuth'
import type { RaffleAction } from '@/lib/raffleManageMessage'
import {
  acquireDrawLock,
  clearRaffleEnabled,
  endRaffle,
  getEligibleEntrants,
  getEntrants,
  getRaffleState,
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

  // Audit every successful mutation (never-throws; called after the effect) —
  // draws especially: the winner selection is a trust-me event, so who ran
  // which action, on what, with what outcome must be reconstructable.
  const audit = (meta?: Record<string, unknown>) =>
    recordAdminAction(`raffle.${action}`, {
      actor: auth.caller,
      target: `${collection}:${tokenId}`,
      ...(meta ? { meta } : {}),
    })

  switch (action) {
    case 'enable': {
      // Both creator-exclusion gates (enter route + the draw filter) key off
      // the KV creator record — without one, the artwork's creator could
      // enter and win their own raffle. Refuse instead of running unguarded.
      // Only the platform-admin / momentAdmins auth paths can even get here
      // without the record (creator auth reads the same key), and the
      // mint-time enable writes it in the same post-mint batch.
      const meta = await getMomentMeta(collection, tokenId)
      if (!meta?.creator) {
        return errorResponse(
          409,
          'This artwork has no creator record, so creator exclusion can’t be enforced — the raffle can’t be enabled',
        )
      }
      // A past close time would create a raffle that is born closed ("winner
      // announced soon", nothing to enter). The panel already sends null for
      // an elapsed sale end; this rejects direct-API misuse the same way.
      if (closeAt != null && closeAt <= Math.floor(Date.now() / 1000)) {
        return errorResponse(400, 'Entries close time is in the past — omit it or pick a future time')
      }
      await setRaffleEnabled(collection, tokenId)
      await setEntriesCloseAt(collection, tokenId, closeAt)
      await audit({ closeAt })
      return NextResponse.json({ ok: true, enabled: true, entriesCloseAt: closeAt })
    }

    case 'disable':
      await clearRaffleEnabled(collection, tokenId)
      await audit()
      return NextResponse.json({ ok: true, enabled: false })

    case 'setCloseAt':
      await setEntriesCloseAt(collection, tokenId, closeAt)
      await audit({ closeAt })
      return NextResponse.json({ ok: true, entriesCloseAt: closeAt })

    case 'drawAndEnd': {
      // Defense in depth on the enter route's creator exclusion: even if a
      // creator entry ever landed (pre-rule data, KV creator recorded late),
      // the creator can't be drawn — or manually picked — as their own winner.
      const [state, allEligible, meta] = await Promise.all([
        getRaffleState(collection, tokenId),
        getEligibleEntrants(collection, tokenId),
        getMomentMeta(collection, tokenId),
      ])
      // Stale-panel guard: a draw against an already-ended raffle would
      // silently overwrite the recorded winner and notify a second "winner"
      // (whose raffle_win copy promises the physical). Re-drawing is an
      // explicit reopen-then-draw; the draw lock in finalize() below closes
      // the remaining sub-second window two concurrent draws could slip
      // through this check.
      if (state === 'ended') {
        return errorResponse(409, 'The raffle has already ended — reopen it to draw again')
      }
      const creatorLower = meta?.creator?.toLowerCase() ?? null
      const eligible = allEligible.filter((e) => e.address !== creatorLower)

      // Announce the outcome post-response (best-effort): the winner gets
      // raffle_win, every other entrant gets a raffle_ended winner
      // announcement ("<winner> has won the physical edition of <artwork>!")
      // — otherwise the winner only learns by revisiting the artwork. The
      // FULL entrant list is notified (not just still-eligible holders):
      // everyone who entered deserves to see the raffle resolve.
      //
      // Actor semantics: raffle_win carries the drawing artist/admin as actor
      // (informational); raffle_ended carries the WINNER as actor, so the
      // notification row + push resolve "[profile] has won …" to the winner's
      // name and avatar. The winner is never a raffle_ended recipient, so the
      // actor==recipient self-filter in writeNotification can't misfire.
      const announceOutcome = (drawnWinner: string) => {
        after(async () => {
          try {
            const entrants = await getEntrants(collection, tokenId)
            await Promise.all(
              entrants.map((e) =>
                writeNotification({
                  type: e.address === drawnWinner ? 'raffle_win' : 'raffle_ended',
                  recipient: e.address,
                  actor: e.address === drawnWinner ? auth.caller : drawnWinner,
                  tokenAddress: collection,
                  tokenId,
                  tokenName: meta?.name,
                }),
              ),
            )
          } catch (err) {
            // The response already returned 200 — a swallowed failure here
            // would mean the winner is never told, invisibly. No retry (the
            // artist can reopen+redraw if the log shows a miss), but never
            // silent.
            bestEffort('raffle.announceOutcome', { collection, tokenId, winner: drawnWinner })(err)
          }
        })
      }

      // Winner selection is validated above; the write itself is single-flight
      // (SET NX lock) so two draws racing past the state check can't both
      // record a winner and double-notify — the loser 409s.
      const finalize = async (chosen: string, manual: boolean) => {
        if (!(await acquireDrawLock(collection, tokenId))) return false
        await endRaffle(collection, tokenId, chosen)
        announceOutcome(chosen)
        await audit({ winner: chosen, manual, eligible: eligible.length })
        return true
      }

      if (winner) {
        // Manual pick — must be an eligible entrant (still holds, not creator).
        if (!(await isEntered(collection, tokenId, winner))) {
          return errorResponse(400, 'That address is not an entrant')
        }
        if (!eligible.some((e) => e.address === winner)) {
          return errorResponse(400, 'That entrant is not eligible to win')
        }
        if (!(await finalize(winner, true))) {
          return errorResponse(409, 'A draw is already in progress')
        }
        return NextResponse.json({ ok: true, ended: true, winner })
      }
      // Random draw from eligible holders — crypto-grade randomness: costs
      // nothing and removes "Math.random picked my winner" from the trust
      // conversation.
      if (eligible.length === 0) {
        return errorResponse(400, 'No eligible entrants — nobody who entered still holds the edition')
      }
      const chosen = eligible[randomInt(eligible.length)].address
      if (!(await finalize(chosen, false))) {
        return errorResponse(409, 'A draw is already in progress')
      }
      return NextResponse.json({ ok: true, ended: true, winner: chosen })
    }

    case 'reopen':
      await reopenRaffle(collection, tokenId)
      await audit()
      return NextResponse.json({ ok: true, ended: false })
  }
}
