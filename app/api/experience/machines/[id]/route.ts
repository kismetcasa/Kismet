import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { getGateConfig } from '@/lib/gate'
import { deriveOdds, entryKey, oddsAreCoherent } from '@/lib/experience/draw'
import { coverage } from '@/lib/experience/solvency'
import { openEpochSeeds } from '@/lib/experience/store'
import { epochFor } from '@/lib/experience/fairness'
import { buildSnapshot, getMachine, getPool, getRemaining, recentPlays } from '@/lib/experience/store'
import { readCapsuleSupply } from '@/lib/experience/authority'
import { isMomentHidden } from '@/lib/hiddenMoments'
import { fetchArtworkMeta, hydrateArtworkMeta, type ArtworkMeta } from '@/lib/experience/artwork'

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

  // Titles and covers for the lineup, plus the capsule's own artwork so the page
  // can show what the player is buying. Hydrated server-side on the payload the
  // client already fetches rather than as N per-row requests; every leg fails
  // soft to the token id, because a metadata outage must not be able to suppress
  // an odds table.
  const [art, capsuleArt] = await Promise.all([
    hydrateArtworkMeta(visible).catch(() => ({}) as Record<string, ArtworkMeta>),
    fetchArtworkMeta(machine.capsule.collection, machine.capsule.tokenId).catch(() => null),
  ])
  // A table that doesn't sum to 1 is not a table we may publish. Serving it
  // would be exactly the "provably fair over a rigged table" failure mode.
  if (!oddsAreCoherent(odds)) {
    console.error('[xp] incoherent odds table', { id })
    return errorResponse(503, 'Machine temporarily unavailable')
  }

  const remainingPrizes = visible.some((e) => e.remaining === null)
    ? null
    : visible.reduce((sum, e) => sum + (e.remaining ?? 0), 0)

  // Opening the seeds on the READ path is what makes the commitment honest: it
  // fixes today's and tomorrow's seed before this visitor can mint a capsule, so
  // the commitment they are shown provably predates their own transaction. A
  // lazily-created seed would be minted after that transaction existed.
  const fairness = await openEpochSeeds(id, epochFor(Date.now())).catch(() => null)

  return NextResponse.json({
    machine: {
      id: machine.id,
      name: machine.name,
      state: machine.state,
      creator: machine.creator,
      capsule: machine.capsule,
      capsuleArt,
      // Who a play pays. Public because it is the answer to the question a
      // player should be able to ask of any machine taking their money.
      splitRecipients: machine.splitRecipients ?? [],
    },
    odds: odds.map((o) => {
      const key = entryKey(o)
      return { ...o, key, name: art[key]?.name ?? null, image: art[key]?.image ?? null }
    }),
    coverage: coverage({
      capsuleMaxSupply: supply?.maxSupply ?? machine.capsuleMaxSupply,
      capsuleMinted: supply?.minted ?? 0,
      remainingPrizes,
    }),
    // Published in advance so a player can confirm the seed was fixed before
    // their transaction existed. The seed itself stays secret until the epoch
    // closes — revealing a live seed would make every remaining draw in it
    // predictable. `next` is tomorrow's commitment, already fixed today, which
    // is the part that makes "committed in advance" checkable rather than
    // asserted: anyone can record it now and hold us to it tomorrow.
    fairness,
    recentPlays: plays,
  })
}
