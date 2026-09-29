import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { getGateConfig, holdsValidPass, isPlatformPausedFor } from '@/lib/gate'
import { isBlacklisted } from '@/lib/blacklist'
import { ADMIN_ADDRESS } from '@/lib/config'
import { entryKey, MAX_POOL_ENTRIES } from '@/lib/experience/draw'
import { linkedPieces, MAX_LINKED_COLLECTIONS, readNextTokenIds } from '@/lib/experience/linked'
import { checkLineup, checkSolvency } from '@/lib/experience/solvency'
import { resolveCapsulePayees } from '@/lib/experience/payees'
import { checkCapsuleControl, readCapsuleSupply, readPoolState } from '@/lib/experience/authority'
import { experienceOperator } from '@/lib/experience/delivery'
import { isDeliverableEntry } from '@/lib/experience/eligibility'
import { readLineup } from '@/lib/experience/lineup'
import { noticeFeaturedArtists, noticeReview } from '@/lib/experience/notices'
import { getMomentMetaBatch } from '@/lib/notifications'
import { paidTo } from '@/lib/referralPayouts'
import {
  createMachine,
  getMachine,
  getPool,
  listMachines,
  listMachinesByCreator,
  machinesFeaturing,
  openEpochSeeds,
  optedOutPieces,
  playCount,
  pledgeSupply,
  prizesDelivered,
  linkCollections,
  putLineup,
  addCurator,
  releaseCapsule,
  reserveCapsule,
  putPoolEntry,
  setMachineState,
} from '@/lib/experience/store'
import { serverBaseClient } from '@/lib/rpc'
import { epochFor } from '@/lib/experience/fairness'
import { isReveal } from '@/lib/experience/types'
import type { CapsuleMachine, Machine, MachineCover, PoolEntry, Rarity, RevealMachine } from '@/lib/experience/types'
import { parseCover } from '@/lib/experience/cover'
import { machineCards } from '@/lib/experience/cards'

/**
 * The Capsule Studio backend: list live machines, and create one.
 *
 * ── Who may create ──
 *
 * The floor is a valid Pass — the credential that is earned on-platform and,
 * by the gate's design, cannot be bought or laundered. That is deliberately
 * stricter than "anyone", because the two controlled experiments in open
 * publishing both ended badly: OpenSea admitted >80% of its free mints were
 * plagiarism or spam (and its remedy, a per-account cap, was reversed within a
 * day after backlash — caps annoy everyone and stop no one), and permissionless
 * token launchpads have seen abuse rates in the high 90s. A credential works
 * where a cap does not.
 *
 * Machines are created in `review`, not `live`. A curator promotes them. That
 * is the fx(hash) shape — open publishing behind a moderation gate — chosen
 * with the knowledge that fx(hash) itself wound down in 2026: the moderation
 * design is worth copying, the business model is not evidence of anything.
 */

export async function GET(req: NextRequest) {
  const creatorParam = new URL(req.url).searchParams.get('creator')
  if (creatorParam !== null) return creatorMachines(req, creatorParam)
  const machines = await listMachines(['live', 'ended'])
  return NextResponse.json(
    { machines: await machineCards(machines) },
    // The same for everyone, and read by the home page's "play" tab. Cacheable
    // like the timeline routes, for a CDN in front (OPS_RUNBOOK §3); without
    // one, each read is an index read plus one MGET per 500 machines
    // (store.listMachines), then the cards' one price multicall and a cached
    // metadata read per machine without a cover (lib/experience/cards).
    { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' } },
  )
}

/**
 * One creator's machines, for their profile. Everyone sees the ones on the
 * shelves (live and ended); the creator, signed in, also sees drafts, queued
 * and delisted machines — the ones nothing else would ever show them — with
 * whether each can still be withdrawn. Read from the creator's own index.
 */
async function creatorMachines(req: NextRequest, raw: string): Promise<NextResponse> {
  if (!(await checkRateLimit(`xp-creator:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  if (!isAddress(raw)) return errorResponse(400, 'Invalid creator')
  const creator = raw.toLowerCase()
  const session = await getSessionAddress(req).catch(() => null)
  const owner = !!session && session.toLowerCase() === creator
  const all = await listMachinesByCreator(creator)
  const visible = owner ? all : all.filter((m) => m.state === 'live' || m.state === 'ended')
  const machines = await Promise.all(
    visible.map(async (m) => {
      const common = {
        id: m.id,
        name: m.name,
        state: m.state,
        createdAt: m.createdAt,
        ...(owner ? { withdrawable: !m.listedAt && (m.state === 'draft' || m.state === 'review') } : {}),
      }
      if (isReveal(m)) {
        return { ...common, kind: 'reveal' as const, pieces: (await getPool(m.id).catch(() => [])).length }
      }
      const [capsules, plays, prizes] = await Promise.all([
        readCapsuleSupply(m.capsule.collection, m.capsule.tokenId),
        playCount(m.id).catch(() => 0),
        prizesDelivered(m.id, 3).catch(() => ({ count: 0, recent: [] })),
      ])
      return { ...common, kind: 'capsule' as const, capsule: m.capsule, plays, capsules, prizes }
    }),
  )
  // A curator's own view also says what their reveal machines have earned
  // them: the mint referral on every collect, paid out to their wallet by
  // the daily run (lib/referralPayouts), counted once the chain confirms it.
  // Where this address's own work appears in OTHER people's reveal machines,
  // on the shelves — "featured in", public like a Spotify "appears on". The
  // pieces are listed so the artist can reach each one's switch.
  const featuredIn = (
    await Promise.all(
      (await machinesFeaturing(creator).catch(() => [] as string[])).slice(0, 50).map(async (mid) => {
        const m = await getMachine(mid).catch(() => null)
        if (!m || !isReveal(m) || m.creator === creator || (m.state !== 'live' && m.state !== 'ended')) return null
        const pieces = (await getPool(mid).catch(() => [])).filter((e) => e.artist === creator).map((e) => ({ collection: e.collection, tokenId: e.tokenId }))
        return pieces.length ? { id: m.id, name: m.name, state: m.state, curator: m.creator, pieces } : null
      }),
    )
  ).filter((f) => f !== null)
  const curates = owner && all.some(isReveal)
  const referralPaid = curates ? (await paidTo(creator).catch(() => 0n)).toString() : undefined
  return NextResponse.json({ owner, machines, featuredIn, ...(referralPaid !== undefined ? { referralPaid } : {}) })
}

/** The pages beside the machines under /play (app/play/*): a machine with one
 *  of these ids would sit behind that page, unreachable. */
const PAGE_IDS = new Set(['create', 'create-capsule', 'create-reveal'])

export async function POST(req: NextRequest) {
  // A flood guard per IP, before anything is authenticated. The real budgets
  // are per wallet, below, once the request says whether it is a check.
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`xp-create:${ip}`, 30, 300))) {
    return errorResponse(429, 'Too many requests')
  }

  // Creation is a platform write, so it stops when the platform stops.
  const session = await getSessionAddress(req).catch(() => null)
  if (!session || !isAddress(session)) return errorResponse(401, 'Sign in to create a machine')
  const creator = session.toLowerCase()
  if (await isPlatformPausedFor(creator)) return errorResponse(503, 'Platform is paused')
  if (await isBlacklisted(creator).catch(() => true)) return errorResponse(403, 'Not permitted')

  const gate = await getGateConfig()
  const isAdmin = creator === ADMIN_ADDRESS
  if (!isAdmin && gate.enabled) {
    // holdsValidPass, not hasGateAccess. The latter answers "may this wallet mint
    // into THAT collection" and returns true unconditionally when the target IS
    // the Pass collection — so passing the Pass collection to it, as this did,
    // made the credential check a no-op that never rejected anyone.
    const ok = await holdsValidPass(creator).catch(() => false)
    if (!ok) return errorResponse(403, 'A Kismet Pass is required to build a gachapon')
  }

  const body = (await req.json().catch(() => null)) as {
    id?: string
    name?: string
    /** 'capsule' (the default) or 'reveal'. */
    kind?: string
    /** Capsule machines: 'manual' (the default) or 'supply'. */
    rarity?: string
    capsule?: { collection?: string; tokenId?: string }
    entries?: PoolEntry[]
    /** Reveal machines: collections whose Kismet-minted pieces join by
     *  themselves (lib/experience/linked). */
    collections?: string[]
    /** The cover its card shows (lib/experience/cover). */
    cover?: unknown
    /** Validate everything and write nothing. The Capsule Studio calls this on
     *  every edit so a creator sees the REAL verdict — live on-chain headroom
     *  and rival machines' pledges included — before committing. Re-using the
     *  publish path rather than approximating it client-side is the point: a
     *  preview that can disagree with the gate is worse than no preview. */
    dryRun?: boolean
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const id = typeof body.id === 'string' ? body.id.toLowerCase() : ''
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  const kind = body.kind ?? 'capsule'
  const rarity = body.rarity ?? 'manual'
  const capsuleCollection = body.capsule?.collection
  const rawCapsuleToken = body.capsule?.tokenId

  if (!/^[a-z0-9-]{3,64}$/.test(id)) return errorResponse(400, 'Invalid id')
  if (PAGE_IDS.has(id)) return errorResponse(400, 'That id is taken by one of Kismet’s own pages — choose another')
  if (!name) return errorResponse(400, 'A machine needs a name')
  if (kind !== 'capsule' && kind !== 'reveal') return errorResponse(400, 'Invalid kind')
  if (rarity !== 'manual' && rarity !== 'supply') return errorResponse(400, 'Invalid rarity')
  const cover = body.cover === undefined ? undefined : parseCover(body.cover)
  if (cover === null) return errorResponse(400, 'Invalid cover')
  const dryRun = body.dryRun === true
  // Separate budgets, because the two are different acts. A check is how a
  // creator iterates on a lineup — sharing one five-per-five-minutes budget
  // with publishing locked them out a few edits in. A publish writes a machine.
  // Both are per wallet, not per IP, so a creator behind a shared address is
  // not throttled by strangers; the platform admin seeding a season is exempt.
  if (!isAdmin) {
    const [bucket, limit] = dryRun ? ['xp-check', 20] as const : ['xp-publish', 5] as const
    if (!(await checkRateLimit(`${bucket}:${creator}`, limit, 300))) {
      return errorResponse(429, dryRun ? 'Too many checks — wait a few minutes' : 'Too many publishes — wait a few minutes')
    }
  }
  if (await getMachine(id)) return errorResponse(409, 'That machine id is taken')

  const rawEntries = Array.isArray(body.entries) ? body.entries : []
  const rawCollections = kind === 'reveal' && Array.isArray(body.collections) ? body.collections : []
  if (rawCollections.length > MAX_LINKED_COLLECTIONS) return errorResponse(400, 'Too many linked collections')
  if (rawCollections.some((c) => typeof c !== 'string' || !isAddress(c))) return errorResponse(400, 'Invalid collection')
  // A linked collection is a lineup in itself, even before anything is minted
  // into it.
  if (rawEntries.length === 0 && rawCollections.length === 0) return errorResponse(400, 'A machine needs at least one artwork')
  if (rawEntries.length > MAX_POOL_ENTRIES) return errorResponse(400, 'Too many artworks')
  for (const e of rawEntries) {
    if (!e || !isAddress(e.collection ?? '') || !/^\d+$/.test(String(e.tokenId ?? ''))) {
      return errorResponse(400, 'Invalid pool entry')
    }
  }

  if (kind === 'reveal') {
    return publishReveal({
      id,
      name,
      creator,
      isAdmin,
      dryRun,
      pieces: rawEntries,
      collections: [...new Set(rawCollections.map((c) => c.toLowerCase()))],
      passCollection: gate.passCollection?.toLowerCase() ?? null,
      cover,
    })
  }

  if (!capsuleCollection || !isAddress(capsuleCollection)) return errorResponse(400, 'Invalid capsule collection')
  if (!rawCapsuleToken || !/^\d+$/.test(String(rawCapsuleToken))) return errorResponse(400, 'Invalid capsule tokenId')
  // Same canonicalisation the collect path applies, for the same reason: the
  // literal string becomes part of Redis keys, so '01' and '1' must not be able
  // to address different machines.
  const capsuleTokenId = BigInt(rawCapsuleToken).toString()

  // One capsule token, one machine, FOR LIFE — delisted machines included.
  // Claims are keyed per (machineId, txHash, unit), so two machines sharing a
  // capsule would let every capsule buyer draw from BOTH pools on one payment,
  // a double-spend the per-machine claim key cannot see. Exempting delisted
  // machines looked like courtesy (their listing is over, why hold the token
  // hostage?) but their SALE is not over — delisting is a Redis state, the Zora
  // sale stays open — and neither are the capsules already bought. See
  // store.reserveCapsule, which is the authoritative version of this rule; this
  // scan exists to give the same answer early, so a dry run cannot tell an
  // artist a token is free that the reservation is about to refuse.
  const capsuleTaken = (await listMachines()).some(
    (m) =>
      !isReveal(m) &&
      m.capsule.collection === capsuleCollection.toLowerCase() &&
      m.capsule.tokenId === capsuleTokenId,
  )
  if (capsuleTaken) {
    return NextResponse.json(
      {
        ok: false,
        problems: [
          {
            code: 'capsule-in-use',
            detail: 'another machine already uses this capsule token — mint a fresh capsule for this one',
          },
        ],
      },
      { status: 400 },
    )
  }

  // Nothing about a pool can be judged without the account that delivers it:
  // every grant check reads it. Refused whole rather than reported per entry.
  if (!(await experienceOperator())) {
    return errorResponse(503, 'Capsule machines are unavailable right now — try again shortly')
  }

  // THE CREATOR'S OWN WORK, and nobody else's. A capsule's price pays only its
  // split and a prize is minted without its own sale, so a capsule machine of
  // someone else's work sells it at a price they never set. The artist is
  // therefore not something a request can name: it is the creator, and the
  // ownership read below holds them to it — a piece they do not hold admin on
  // is refused. Curating other artists' work is what reveal machines are for.
  // By supply, a piece's total copies ARE its weight, stored here once and read
  // by every draw after, so a typed weight is ignored.
  const entries: PoolEntry[] = rawEntries.map((e) => {
    const supply = Number(e.supply)
    return {
      collection: e.collection.toLowerCase(),
      tokenId: BigInt(e.tokenId).toString(),
      artist: creator,
      weight: rarity === 'supply' ? supply : Number(e.weight),
      supply,
    }
  })

  // WHO THE CAPSULE ACTUALLY PAYS — resolved from what Kismet recorded when the
  // capsule was minted, never from this request. Taking it from the body made
  // the 'artist-not-in-split' check below circular (the creator supplied both
  // the pool and the list it was checked against), so a machine could promise
  // artists a share of revenue that went entirely elsewhere.
  // The capsule must be one this creator actually controls, and it must charge
  // for a play. Both are preconditions for the payee resolution below meaning
  // anything: an uncontrolled capsule resolves to a fabricated "creator keeps
  // 100%", and an unpriced one pays nobody whatever the split says.
  // The prize side is defended against Pass laundering; the COIN-SLOT side was
  // not, and it is the side the player mints with their own wallet. A capsule in
  // the Pass collection turns "pay to play" into "buy a Kismet Pass" —
  // lib/pass-validity credits validity on any mint — which is the one credential
  // the gate exists to make unpurchasable.
  if (gate.passCollection && capsuleCollection.toLowerCase() === gate.passCollection) {
    return NextResponse.json(
      {
        ok: false,
        problems: [{ code: 'capsule-is-pass', detail: 'the capsule cannot be a Pass artwork — playing would mint the credential itself' }],
      },
      { status: 400 },
    )
  }

  const control = await checkCapsuleControl({
    collection: capsuleCollection.toLowerCase(),
    tokenId: capsuleTokenId,
    creator,
  })
  if (!control.ok) {
    return NextResponse.json(
      { ok: false, problems: [{ code: `capsule-${control.code}`, detail: control.detail }] },
      { status: 400 },
    )
  }

  const payees = await resolveCapsulePayees({
    collection: capsuleCollection.toLowerCase(),
    tokenId: capsuleTokenId,
    creator,
  })
  if (!payees.ok) {
    return NextResponse.json(
      { ok: false, problems: [{ code: 'capsule-split-unverifiable', detail: payees.reason }] },
      { status: 400 },
    )
  }
  const splitRecipients = payees.recipients

  // The capsule's on-chain maxSupply IS the liability ceiling — immutable, and
  // therefore a real bound rather than a promise. The block number is recorded
  // alongside so capsule discovery can bound its log scan to the season
  // (capsules cannot be minted before the machine exists); best-effort because
  // discovery has a lookback fallback and paste-a-hash behind that.
  const [capsuleSupply, createdBlock] = await Promise.all([
    readCapsuleSupply(capsuleCollection.toLowerCase(), capsuleTokenId),
    serverBaseClient().getBlockNumber().then(Number).catch(() => undefined),
  ])
  if (!capsuleSupply) return errorResponse(400, 'Could not read the capsule token on-chain')
  // REQUIRED, not best-effort. `createdBlock` is the bound the play route uses to
  // refuse capsules minted before the machine opened; a machine published
  // without it has no bound at all, permanently, and nothing backfills it.
  // Publishing is a deliberate, retryable act — fail it rather than ship a
  // machine every historical holder of the capsule token can play.
  if (!createdBlock) return errorResponse(503, 'Could not read the chain head — try publishing again')

  // Live headroom per entry net of what OTHER machines have already pledged
  // against the same edition, whether each declared artist owns their piece,
  // and whether the delivery account may mint it. Without the pledges two
  // machines can each promise the same last copy; without the ownership read
  // the split check is only as honest as the name it checks; without the grant
  // a machine can sell capsules for pieces nothing can deliver.
  const poolState = await readPoolState(entries, id)

  const problems = checkSolvency({
    capsuleMaxSupply: capsuleSupply.maxSupply,
    capsuleMinted: capsuleSupply.minted,
    entries,
    splitRecipients,
    creator,
    passCollection: gate.passCollection?.toLowerCase() ?? null,
    ...poolState,
    rarity,
  })
  if (problems.length > 0) {
    // Return ALL problems, not the first — a creator fixing a machine should
    // see the whole list rather than discovering them one submit at a time.
    return NextResponse.json({ ok: false, problems }, { status: 400 })
  }

  // A dry run stops here, having proved exactly what a real publish would
  // prove. Nothing has been written, no id is reserved and no supply is
  // pledged, so a creator can iterate without leaving debris behind.
  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      problems: [],
      capsule: {
        maxSupply: capsuleSupply.maxSupply,
        minted: capsuleSupply.minted,
        pricePerToken: control.pricePerToken.toString(),
        currency: control.currency,
      },
      // So a creator sees who their capsule really pays before publishing,
      // rather than the list they think they are declaring.
      payees: { recipients: splitRecipients, source: payees.source },
    })
  }

  // Admin-created machines go live directly (that is the v1 platform season);
  // everyone else queues for curator review.
  const finalState: Machine['state'] = isAdmin ? 'live' : 'review'
  const machine: CapsuleMachine = {
    id,
    creator,
    name,
    state: finalState,
    capsule: { collection: capsuleCollection.toLowerCase(), tokenId: capsuleTokenId },
    capsuleMaxSupply: capsuleSupply.maxSupply,
    createdBlock,
    splitRecipients,
    createdAt: Date.now(),
    ...(rarity === 'supply' ? { rarity: 'supply' as Rarity } : {}),
    ...(cover ? { cover } : {}),
  }

  // The capsule reservation is the AUTHORITATIVE one-machine-per-capsule guard;
  // the index scan above is a cheap early answer that a dry run can rely on but
  // that cannot see machines trimmed out of the index window.
  if (!(await reserveCapsule(capsuleCollection.toLowerCase(), capsuleTokenId, id))) {
    return NextResponse.json(
      {
        ok: false,
        problems: [{ code: 'capsule-in-use', detail: 'another machine already uses this capsule token — mint a fresh capsule for this one' }],
      },
      { status: 400 },
    )
  }

  // PUBLISH LAST. The machine is reserved as a `draft` first, its pool is
  // written, and only then does it take its real state.
  //
  // The ordering is the safety property. Writing the record first and the pool
  // second means an interruption in between leaves a machine that is visible and
  // — for an admin — PLAYABLE, over a partial pool that the solvency check never
  // saw. Reserving as `draft` makes that window inert instead: `draft` is 404 on
  // the public read and 403 on play, so a half-built machine can never be drawn
  // from. The reservation is also what makes the id claim atomic (see
  // createMachine); `getMachine` above only turns the common case into a clean
  // 409 rather than a race.
  if (!(await createMachine({ ...machine, state: 'draft' }))) {
    // Compensate: this publish took the capsule reservation a moment ago and is
    // now abandoning it, so hand it straight back rather than stranding the
    // token behind a machine that does not exist.
    await releaseCapsule(capsuleCollection.toLowerCase(), capsuleTokenId, id)
    return errorResponse(409, 'That machine id is taken')
  }

  for (const e of entries) {
    await putPoolEntry(id, e)
    // Pledged BEFORE the machine is visible, on purpose. The opposite order
    // would let a machine go live in the window before its claim on those copies
    // is recorded, and another machine could promise the same last copy in the
    // meantime — the exact over-promise the ledger exists to prevent. The cost
    // is that a publish dying mid-loop leaves a draft holding headroom it will
    // never use, and nothing reclaims it. That is the accepted side: unused
    // headroom is a machine that has to pick different pieces, while an
    // over-promised edition is an artist's supply spent without their consent,
    // which nothing can undo.
    await pledgeSupply(e.collection, e.tokenId, id, e.supply)
  }

  // Open the epoch seeds at publish, so a machine's very first visitor is shown
  // a commitment that already existed — see store.openEpochSeeds. Best effort:
  // the read path opens them too, so a blip here costs nothing.
  await openEpochSeeds(id, epochFor(Date.now())).catch(() => null)

  const published = await setMachineState(id, finalState)
  if (published?.state === 'review') await noticeReview(published)

  return NextResponse.json({ ok: true, machine: published ?? machine })
}

/**
 * Publish a reveal machine: a name and a lineup, nothing else. No capsule, no
 * payees, no supply to reserve and no mint rights to check — a pull costs
 * nothing, and a player buys what it reveals through that piece's own sale.
 *
 * Anyone's work may go in. Each piece's artist is who Kismet recorded minting
 * it, and a piece whose artist turned reveal machines off is refused here and
 * dropped from every machine it is already in (lib/experience/lineup).
 */
async function publishReveal(input: {
  id: string
  name: string
  creator: string
  isAdmin: boolean
  dryRun: boolean
  pieces: { collection: string; tokenId: string }[]
  collections: string[]
  passCollection: string | null
  cover: MachineCover | undefined
}): Promise<NextResponse> {
  const pieces = input.pieces.map((e) => ({
    collection: e.collection.toLowerCase(),
    tokenId: BigInt(e.tokenId).toString(),
  }))
  const metas = await getMomentMetaBatch(pieces.map((e) => ({ address: e.collection, tokenId: e.tokenId })))
  const entries: PoolEntry[] = pieces.map((e, i) => ({
    ...e,
    artist: metas[i]?.creator?.toLowerCase() ?? '',
    weight: 1,
    supply: 0,
  }))
  const artists: Record<string, string | null> = {}
  entries.forEach((e) => { artists[`${e.collection}:${e.tokenId}`] = e.artist || null })

  // Fail closed: an unreadable choice is not a yes.
  const optedOut = await optedOutPieces(entries).catch(() => null)
  if (!optedOut) return errorResponse(503, 'Could not check artists’ choices just now — try again')
  const unavailable = new Set(optedOut)
  await Promise.all(
    entries.map(async (e) => {
      if (e.artist && !(await isDeliverableEntry(e, input.passCollection))) unavailable.add(`${e.collection}:${e.tokenId}`)
    }),
  )

  const linking = input.collections.length > 0
  const problems = checkLineup({ entries, artists, unavailable, linked: linking })
  if (linking && entries.length >= MAX_POOL_ENTRIES) {
    problems.push({ code: 'too-many-entries', detail: `a machine with a linked collection can hand-pick at most ${MAX_POOL_ENTRIES - 1} artworks, to leave room for new work` })
  }
  // A linked collection must be one the chain answers nextTokenId for — a Zora
  // collection — and never the Pass collection, whose tokens are credentials.
  const nextTokenIds = await readNextTokenIds(input.collections)
  input.collections.forEach((c, i) => {
    if (c === input.passCollection) {
      problems.push({ code: 'collection-invalid', detail: `${c} is the Pass collection — it can't be linked` })
    } else if (nextTokenIds[i] === null) {
      problems.push({ code: 'collection-invalid', detail: `${c} isn't a collection Kismet could read just now` })
    }
  })
  if (problems.length > 0) return NextResponse.json({ ok: false, problems }, { status: 400 })

  const linked = await linkedPieces({
    collections: input.collections,
    nextTokenIds: nextTokenIds as bigint[],
    room: MAX_POOL_ENTRIES - entries.length,
    exclude: new Set(entries.map(entryKey)),
    passCollection: input.passCollection,
  }).catch(() => null)
  if (!linked) return errorResponse(503, 'Could not read the linked collections just now — try again')
  const lineup = [...entries, ...linked]

  if (input.dryRun) {
    // What each piece would show as today, so the studio can say which are on
    // sale now and which will appear when their sale opens.
    return NextResponse.json({ ok: true, dryRun: true, problems: [], lineup: await readLineup(lineup, input.passCollection) })
  }

  const machine: RevealMachine = {
    id: input.id,
    kind: 'reveal',
    creator: input.creator,
    name: input.name,
    state: 'draft',
    createdAt: Date.now(),
    ...(linking ? { collections: input.collections } : {}),
    ...(input.cover ? { cover: input.cover } : {}),
  }
  // Reserved as a draft and filled before it takes its real state, as a
  // capsule machine is: a half-written lineup is never public.
  if (!(await createMachine(machine))) return errorResponse(409, 'That machine id is taken')
  await putLineup(input.id, lineup)
  if (linking) await linkCollections(input.id, input.collections)
  // Collects through this machine will name its curator as the mint referral
  // (Kismet's own machines name Kismet), so the payout run must know them.
  if (!input.isAdmin) await addCurator(input.creator)
  const published = await setMachineState(input.id, input.isAdmin ? 'live' : 'review')
  if (published?.state === 'live') await noticeFeaturedArtists(input.id).catch(() => {})
  if (published?.state === 'review') await noticeReview(published)
  return NextResponse.json({ ok: true, machine: published ?? machine })
}
