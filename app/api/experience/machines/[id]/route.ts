import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { getGateConfig } from '@/lib/gate'
import { deriveOdds, entryKey, oddsAreCoherent } from '@/lib/experience/draw'
import { coverage } from '@/lib/experience/solvency'
import { openEpochSeeds } from '@/lib/experience/store'
import { epochFor } from '@/lib/experience/fairness'
import { buildSnapshot, getMachine, getPool, getRemaining, recentPlays } from '@/lib/experience/store'
import { readCapsuleSupply } from '@/lib/experience/authority'
import { resolveOnchainSale } from '@/lib/saleConfig'
import { serverBaseClient } from '@/lib/rpc'
import { fetchArtworkMeta, hydrateArtworkMeta, type ArtworkMeta } from '@/lib/experience/artwork'
import { filterDeliverable } from '@/lib/experience/eligibility'

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

  const [pool, remaining, supply, plays, sale] = await Promise.all([
    getPool(id),
    getRemaining(id),
    readCapsuleSupply(machine.capsule.collection, machine.capsule.tokenId),
    recentPlays(id, 12).catch(() => []),
    // THE PRICE OF A PLAY. Disclosure before a randomized purchase is this
    // surface's whole compliance posture (Apple 3.1.1, inherited through 4.7),
    // and it was publishing the odds while leaving the cost to be discovered in
    // the wallet prompt — worst on a multi-pull, where the player is committing
    // to N times a number they were never shown. The window comes with it: a
    // machine's `live` state is OUR record and says nothing about whether the
    // capsule's on-chain sale is open, so the two can disagree and the player
    // would only find out when the mint reverted.
    resolveOnchainSale(serverBaseClient(), machine.capsule.collection as `0x${string}`, BigInt(machine.capsule.tokenId)).catch(() => null),
  ])

  // Apply the SAME freeze-time exclusions the draw applies, so the published
  // table is the table a play will actually draw from. A row shown here that
  // the draw would skip is a false disclosure, which is the specific failure
  // this whole design exists to make impossible.
  // The SAME filter the draw applies — not a reimplementation of two of its
  // three tests, which is what this was: it omitted the artist blacklist, so a
  // blacklisted artist's row stayed in the published table with a probability it
  // could never win, and inflated the denominator under every other row.
  const snapshot = buildSnapshot(pool, remaining)
  const visible = await filterDeliverable(snapshot, passCollection)

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
      // player should be able to ask of any machine taking their money — and
      // it is now the capsule's real payee set (lib/experience/payees), not a
      // list the creator declared about themselves.
      splitRecipients: machine.splitRecipients ?? [],
      // bigints do not survive JSON; the client formats from the base-units
      // string exactly as every other price surface does (lib/inprocess.formatPrice).
      // Three states, not two. `resolveOnchainSale` returns null both when there
      // is genuinely no sale row AND when the reads threw, and the client used
      // to treat a null as "no window to enforce" — i.e. playable, with no price
      // shown. Odds disclosure in this same route fails closed; price disclosure
      // must too, so an unreadable sale is reported as unreadable and the client
      // refuses to sell rather than selling blind.
      sale: sale
        ? {
            pricePerToken: sale.pricePerToken.toString(),
            currency: sale.currency,
            saleStart: Number(sale.saleStart),
            saleEnd: Number(sale.saleEnd),
          }
        : null,
      saleReadable: sale !== null,
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
