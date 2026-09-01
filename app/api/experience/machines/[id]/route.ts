import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { getGateConfig } from '@/lib/gate'
import { deriveOdds, entryKey, oddsAreCoherent } from '@/lib/experience/draw'
import { coverage } from '@/lib/experience/solvency'
import { commitmentForEpoch } from '@/lib/experience/store'
import { epochFor } from '@/lib/experience/fairness'
import { buildSnapshot, getMachine, getPool, getRemaining, recentPlays } from '@/lib/experience/store'
import { readCapsuleSupply } from '@/lib/experience/authority'
import { isMomentHidden } from '@/lib/hiddenMoments'

/**
 * Everything a player must see BEFORE they can pay: the lineup, the derived
 * odds, live coverage, and today's fairness commitment.
 *
 * This route is the reason the play button can exist. Apple's Guideline 3.1.1
 * requires the odds of a randomized purchase to be disclosed before purchase,
 * and Guideline 4.7 (extended to HTML5/JS mini apps in November 2025) makes the
 * native HOST responsible for software it embeds — so as a Farcaster Mini App
 * we inherit that obligation through the host, which can be rejected for our
 * non-compliance. Disclosure is therefore a distribution requirement, not only
 * an ethic, and the client is built so the play control cannot render without
 * this payload.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (!/^[a-z0-9-]{3,64}$/.test(id)) return errorResponse(400, 'Invalid id')

  const machine = await getMachine(id)
  if (!machine) return errorResponse(404, 'Machine not found')
  if (machine.state === 'draft' || machine.state === 'review') {
    // Unlisted machines are not public. The creator reads their own draft
    // through the authenticated write route instead.
    return errorResponse(404, 'Machine not found')
  }

  const gate = await getGateConfig()
  const passCollection = gate.passCollection?.toLowerCase() ?? null

  const [pool, remaining, supply, plays] = await Promise.all([
    getPool(id),
    getRemaining(id),
    readCapsuleSupply(machine.capsule.collection, machine.capsule.tokenId),
    recentPlays(id, 12).catch(() => []),
  ])

  // Apply the SAME freeze-time exclusions the draw applies, so the published
  // table is the table a play will actually draw from. A row shown here that
  // the draw would skip is a false disclosure, which is the specific failure
  // this whole design exists to make impossible.
  const snapshot = buildSnapshot(pool, remaining)
  const visible = []
  for (const e of snapshot) {
    if (passCollection && e.collection.toLowerCase() === passCollection) continue
    if (await isMomentHidden(e.collection, e.tokenId).catch(() => true)) continue
    visible.push(e)
  }

  const odds = deriveOdds(visible)
  // A table that doesn't sum to 1 is not a table we may publish. Serving it
  // would be exactly the "provably fair over a rigged table" failure mode.
  if (!oddsAreCoherent(odds)) {
    console.error('[xp] incoherent odds table', { id })
    return errorResponse(503, 'Machine temporarily unavailable')
  }

  const remainingPrizes = visible.some((e) => e.remaining === null)
    ? null
    : visible.reduce((sum, e) => sum + (e.remaining ?? 0), 0)

  const epoch = epochFor(Date.now())

  return NextResponse.json({
    machine: {
      id: machine.id,
      name: machine.name,
      state: machine.state,
      creator: machine.creator,
      capsule: machine.capsule,
    },
    odds: odds.map((o) => ({ ...o, key: entryKey(o) })),
    coverage: coverage({
      capsuleMaxSupply: supply?.maxSupply ?? machine.capsuleMaxSupply,
      capsuleMinted: supply?.minted ?? 0,
      remainingPrizes,
    }),
    // Published in advance so a player can confirm the seed was fixed before
    // their transaction existed. The seed itself stays secret until the epoch
    // closes — revealing a live seed would make every remaining draw in it
    // predictable.
    fairness: { epoch, commitment: await commitmentForEpoch(id, epoch) },
    recentPlays: plays,
  })
}
