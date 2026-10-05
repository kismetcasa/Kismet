import { NextRequest, NextResponse, after } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { isAddress } from '@/lib/address'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { acquireLock } from '@/lib/redisLock'
import { getSessionAddress } from '@/lib/session'
import { getGateConfig } from '@/lib/gate'
import { deriveOdds, entryKey, isDrawable, oddsAreCoherent } from '@/lib/experience/draw'
import { coverage } from '@/lib/experience/solvency'
import { openEpochSeeds } from '@/lib/experience/store'
import { epochFor } from '@/lib/experience/fairness'
import {
  buildSnapshot,
  getMachine,
  getPool,
  getRemaining,
  machineStateLockKey,
  prizesDelivered,
  type PrizeRecord,
  setMachineArt,
  setMachineState,
  withdrawMachine,
} from '@/lib/experience/store'
import { frameStatus, parseCover, parseFrames, playerFrames } from '@/lib/experience/cover'
import { screenMachineFrames, screenMachineFramesSoon, screeningDue } from '@/lib/experience/frameScreen'
import { readCapsuleSupply } from '@/lib/experience/authority'
import { resolveOnchainSale } from '@/lib/saleConfig'
import { serverBaseClient } from '@/lib/rpc'
import { fetchArtworkMeta, hydrateArtworkMeta, type ArtworkMeta } from '@/lib/experience/artwork'
import { drawableTable } from '@/lib/experience/eligibility'
import { noticeIfEmptyOnRead } from '@/lib/experience/notices'
import { readLineup } from '@/lib/experience/lineup'
import { isReveal, type RevealMachine } from '@/lib/experience/types'
import { ADMIN_ADDRESS } from '@/lib/config'

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
    // Unlisted machines are not public. The creator sees their own on their
    // profile (GET /api/experience/machines?creator=).
    return errorResponse(404, 'Machine not found')
  }
  // A frame not yet screened — its gateway was not ready, or the box had no
  // ffmpeg — is tried again after a read, and is not played until it passes.
  if (screeningDue(machine.frames)) after(() => screenMachineFramesSoon(id).catch(() => {}))

  const gate = await getGateConfig()
  const passCollection = gate.passCollection?.toLowerCase() ?? null
  if (isReveal(machine)) return revealPayload(machine, passCollection)

  const poolRead = getPool(id)
  const [pool, remaining, supply, plays, sale] = await Promise.all([
    poolRead,
    getRemaining(id),
    readCapsuleSupply(machine.capsule.collection, machine.capsule.tokenId),
    recentWins(id, poolRead),
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
  // The SAME function the draw uses — not a reimplementation of part of it,
  // which is what this once was: it omitted the artist blacklist, so a
  // blacklisted artist's row stayed in the published table with a probability it
  // could never win, and inflated the denominator under every other row. It
  // now also drops what the chain says cannot be delivered (sold out, consent
  // withdrawn); when the chain cannot be read, `live` is false and the page
  // refuses to sell on an unconfirmed table.
  const snapshot = buildSnapshot(pool, remaining)
  const { table: visible, live } = await drawableTable(snapshot, passCollection)
  // Nothing left it could give, on a table the chain confirmed: its creator is
  // told, once, to end the season — the capsule keeps selling on zora.co until
  // they do, and every capsule sold there is a play with nothing to draw.
  if (machine.state === 'live' && live && !visible.some(isDrawable)) after(() => noticeIfEmptyOnRead(id).catch(() => {}))

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
      cover: machine.cover?.uri ?? null,
      // A player's stage plays only screened frames; the creator's editor is
      // shown every frame and where its screening stands.
      frames: playerFrames(machine.frames),
      frameStatus: frameStatus(machine.frames),
      rarity: machine.rarity ?? 'manual',
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
    // Whether the table above reflects the chain right now. Selling is refused
    // on a table that could not be confirmed, as it is on an unreadable price.
    standingReadable: live,
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
    recentWins: plays,
  })
}

/**
 * A reveal machine's page: the pieces on sale right now, each with its price,
 * and nothing else. Every one is equally likely — 1 in however many are on
 * sale — and a pull picks from exactly this list, so the odds shown are the
 * odds played. Pieces that are off sale, sold out or turned off by their artist
 * are simply absent; they come back by themselves when that changes.
 */
async function revealPayload(machine: RevealMachine, passCollection: string | null): Promise<NextResponse> {
  const pool = await getPool(machine.id)
  const [lineup, wins] = await Promise.all([
    readLineup(pool, passCollection),
    recentWins(machine.id, Promise.resolve(pool)),
  ])
  const onSale = lineup.filter((p) => p.status === 'on-sale')
  const art = await hydrateArtworkMeta(onSale).catch(() => ({}) as Record<string, ArtworkMeta>)
  return NextResponse.json({
    machine: {
      id: machine.id,
      kind: 'reveal',
      name: machine.name,
      state: machine.state,
      cover: machine.cover?.uri ?? null,
      // A player's stage plays only screened frames; the creator's editor is
      // shown every frame and where its screening stands.
      frames: playerFrames(machine.frames),
      frameStatus: frameStatus(machine.frames),
      creator: machine.creator,
    },
    // The curator earns the mint referral on every collect made through their
    // machine. Kismet's own machines keep Kismet's referral, which the admin
    // wallet that published them is not.
    referral: machine.creator === ADMIN_ADDRESS ? null : machine.creator,
    lineup: onSale.map((p) => ({ ...p, name: art[p.key]?.name ?? null, image: art[p.key]?.image ?? null })),
    // Pieces whose sale has not opened yet, so the page can say "more when
    // their sales open". Only those: a sold-out, closed or withdrawn piece is
    // not coming, and counting it would promise a piece that cannot appear.
    waiting: lineup.filter((p) => p.status === 'upcoming').length,
    collections: machine.collections ?? [],
    recentWins: wins,
  })
}

/**
 * What came out of a machine lately, to whom — a capsule's prizes, a reveal
 * machine's collects — with each artwork's title, image and artist (from the
 * machine's pool: a curator's machine holds other artists' work), so the page
 * can show who won what. Empty, never an error, when it cannot be read.
 */
async function recentWins(machineId: string, pool: Promise<{ collection: string; tokenId: string; artist: string }[]>) {
  const [{ recent }, entries] = await Promise.all([
    prizesDelivered(machineId, 12).catch(() => ({ recent: [] as PrizeRecord[] })),
    pool.catch(() => []),
  ])
  const artistOf = new Map(entries.map((e) => [entryKey(e), e.artist]))
  const art = await hydrateArtworkMeta(recent).catch(() => ({}) as Record<string, ArtworkMeta>)
  return recent.map((w) => {
    const meta = art[`${w.collection.toLowerCase()}:${w.tokenId}`]
    return { ...w, artist: artistOf.get(entryKey(w)) ?? null, name: meta?.name ?? null, image: meta?.image ?? null }
  })
}

/**
 * The creator's own actions on their machine.
 *
 *   end       live → ended. Stops the LISTING; the capsule's on-chain sale is
 *             the creator's to close, which the profile does in the same step
 *             (an ended machine still honours every capsule minted, wherever).
 *   withdraw  take back a machine that has never been on sale, freeing its id,
 *             its capsule token and its pledged supply (store.withdrawMachine
 *             carries the guard).
 *   cover     a new cover, whatever state the machine is in once published:
 *             art is the creator's to change after it goes live.
 *   frames    its frames for the play, likewise; `{}` for none (the
 *             platform's capsule).
 *
 * Under the same state lock a curator's decision takes, so the two cannot
 * interleave.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await checkRateLimit(`xp-owner:${getClientIp(req)}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const { id } = await ctx.params
  if (!/^[a-z0-9-]{3,64}$/.test(id)) return errorResponse(400, 'Invalid id')
  const session = await getSessionAddress(req).catch(() => null)
  if (!session || !isAddress(session)) return errorResponse(401, 'Sign in to change your machine')
  const body = (await req.json().catch(() => null)) as { action?: string; cover?: unknown; frames?: unknown } | null
  const action = body?.action
  if (action !== 'end' && action !== 'withdraw' && action !== 'cover' && action !== 'frames') {
    return errorResponse(400, 'Invalid action')
  }
  const cover = action === 'cover' ? parseCover(body?.cover) : null
  if (action === 'cover' && !cover) return errorResponse(400, 'Invalid cover')

  const lock = await acquireLock(machineStateLockKey(id), 60).catch(() => ({ acquired: false, release: async () => {} }))
  if (!lock.acquired) return errorResponse(409, 'This machine is being changed — try again')
  try {
    const machine = await getMachine(id)
    if (!machine) return errorResponse(404, 'Machine not found')
    if (machine.creator !== session.toLowerCase()) return errorResponse(403, 'Only its creator can change this machine')
    if (cover || action === 'frames') {
      // A draft is a publish that never finished, not a machine to dress.
      if (machine.state === 'draft') return errorResponse(409, 'This machine was never published')
      if (cover) return NextResponse.json({ ok: true, machine: await setMachineArt(id, { cover }) })
      // Which stages a machine has depends on its kind, so they are read here.
      const frames = parseFrames(body?.frames, isReveal(machine) ? 'reveal' : 'capsule')
      if (!frames) return errorResponse(400, 'Invalid frames')
      const saved = await setMachineArt(id, { frames })
      after(() => screenMachineFrames(id).catch(() => {}))
      return NextResponse.json({ ok: true, machine: saved })
    }
    if (action === 'end') {
      if (machine.state !== 'live') return errorResponse(409, 'Only a live machine can end its season')
      return NextResponse.json({ ok: true, machine: await setMachineState(id, 'ended') })
    }
    const outcome = await withdrawMachine(id)
    if (outcome === 'missing') return errorResponse(404, 'Machine not found')
    if (outcome === 'refused') {
      return errorResponse(409, 'Only a machine that has never been on sale can be withdrawn')
    }
    return NextResponse.json({ ok: true, withdrawn: true })
  } finally {
    await lock.release()
  }
}
