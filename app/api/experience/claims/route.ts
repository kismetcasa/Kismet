import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getClaim, getSpark, playedTxHashes } from '@/lib/experience/store'
import type { ClaimRecord } from '@/lib/experience/types'

/**
 * One player's plays on one machine — the basis for "you have a capsule still
 * opening" and for the resume affordance.
 *
 * ── Why the client cannot be the only record ──
 *
 * The play route records the claim server-side the instant the capsule is
 * proved, so a player who closed the tab mid-reveal, switched device, or
 * cleared storage still has an obligation on file. The client keeps its own
 * local ledger of capsule transactions (which covers the narrower window
 * between the mint landing and the play POST being recorded at all), but this
 * route is the durable half and the only one another device can see.
 *
 * Public and unauthenticated, like the rest of the surface: it reveals only
 * what the machine's own public play feed already does — that an address
 * played — plus the state of those plays. Nothing here can move an artwork.
 */

/** Bound the fan-out. A player with more plays than this on one machine sees
 *  their most recent; the unresolved ones are what this route exists for and
 *  they are vanishingly unlikely to be older than the window. */
const MAX_CLAIMS = 50

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`xp-claims:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const url = new URL(req.url)
  const machineId = url.searchParams.get('machineId') ?? ''
  const account = (url.searchParams.get('account') ?? '').toLowerCase()

  if (!/^[a-z0-9-]{3,64}$/.test(machineId)) return errorResponse(400, 'Invalid machineId')
  if (!isAddress(account)) return errorResponse(400, 'Invalid account')

  const hashes = [...(await playedTxHashes(machineId, account).catch(() => new Set<string>()))]
  const recent = hashes.slice(0, MAX_CLAIMS)

  // A capsule minted with quantity N produces N claims under one txHash. Probe
  // forward from unit 0 and stop at the first gap: units are always written
  // from 0 upward, so a gap means there is nothing further to find.
  const claims: ClaimRecord[] = []
  await Promise.all(
    recent.map(async (tx) => {
      for (let unit = 0; unit < 20; unit++) {
        const c = await getClaim(machineId, tx, unit).catch(() => null)
        if (!c) break
        claims.push(c)
      }
    }),
  )

  claims.sort((a, b) => b.createdAt - a.createdAt || a.unitIndex - b.unitIndex)

  return NextResponse.json({
    spark: await getSpark(machineId, account).catch(() => 0),
    claims: claims.map((c) => ({
      txHash: c.txHash,
      unitIndex: c.unitIndex,
      state: c.state,
      // `unresolved` is the field the UI acts on. Everything that is not
      // delivered is still owed, and every one of those is resumable — which is
      // the whole point of surfacing them.
      unresolved: c.state !== 'delivered',
      prize: c.prize ?? null,
      epoch: c.epoch ?? null,
      pendingReason: c.pendingReason ?? null,
      createdAt: c.createdAt,
    })),
  })
}
