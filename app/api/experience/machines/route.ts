import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { getGateConfig, hasGateAccess, isPlatformPausedFor } from '@/lib/gate'
import { isBlacklisted } from '@/lib/blacklist'
import { ADMIN_ADDRESS } from '@/lib/config'
import { MAX_POOL_ENTRIES, entryKey } from '@/lib/experience/draw'
import { checkSolvency } from '@/lib/experience/solvency'
import { readCapsuleSupply, readHeadroom } from '@/lib/experience/authority'
import {
  createMachine,
  getMachine,
  listMachines,
  otherPledges,
  pledgeSupply,
  putPoolEntry,
  setMachineState,
} from '@/lib/experience/store'
import type { Machine, PoolEntry } from '@/lib/experience/types'

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

export async function GET() {
  const machines = await listMachines(['live', 'ended'])
  return NextResponse.json({
    machines: machines.map((m) => ({
      id: m.id,
      name: m.name,
      state: m.state,
      creator: m.creator,
      capsule: m.capsule,
      createdAt: m.createdAt,
    })),
  })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`xp-create:${ip}`, 5, 300))) {
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
    const ok = await hasGateAccess(gate.passCollection ?? '', creator).catch(() => false)
    if (!ok) return errorResponse(403, 'A Kismet Pass is required to create a machine')
  }

  const body = (await req.json().catch(() => null)) as {
    id?: string
    name?: string
    capsule?: { collection?: string; tokenId?: string }
    entries?: PoolEntry[]
    splitRecipients?: string[]
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const id = typeof body.id === 'string' ? body.id.toLowerCase() : ''
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  const capsuleCollection = body.capsule?.collection
  const rawCapsuleToken = body.capsule?.tokenId

  if (!/^[a-z0-9-]{3,64}$/.test(id)) return errorResponse(400, 'Invalid id')
  if (!name) return errorResponse(400, 'A machine needs a name')
  if (!capsuleCollection || !isAddress(capsuleCollection)) return errorResponse(400, 'Invalid capsule collection')
  if (!rawCapsuleToken || !/^\d+$/.test(String(rawCapsuleToken))) return errorResponse(400, 'Invalid capsule tokenId')
  // Same canonicalisation the collect path applies, for the same reason: the
  // literal string becomes part of Redis keys, so '01' and '1' must not be able
  // to address different machines.
  const capsuleTokenId = BigInt(rawCapsuleToken).toString()

  if (await getMachine(id)) return errorResponse(409, 'That machine id is taken')

  const rawEntries = Array.isArray(body.entries) ? body.entries : []
  if (rawEntries.length === 0) return errorResponse(400, 'A machine needs at least one artwork')
  if (rawEntries.length > MAX_POOL_ENTRIES) return errorResponse(400, 'Too many artworks')

  const entries: PoolEntry[] = []
  for (const e of rawEntries) {
    if (!e || !isAddress(e.collection ?? '') || !/^\d+$/.test(String(e.tokenId ?? ''))) {
      return errorResponse(400, 'Invalid pool entry')
    }
    if (!isAddress(e.artist ?? '')) return errorResponse(400, 'Invalid artist address')
    entries.push({
      collection: e.collection.toLowerCase(),
      tokenId: BigInt(e.tokenId).toString(),
      artist: e.artist.toLowerCase(),
      weight: Number(e.weight),
      supply: Number(e.supply),
    })
  }

  const splitRecipients = (Array.isArray(body.splitRecipients) ? body.splitRecipients : [])
    .filter((a): a is string => typeof a === 'string' && isAddress(a))
    .map((a) => a.toLowerCase())

  // The capsule's on-chain maxSupply IS the liability ceiling — immutable, and
  // therefore a real bound rather than a promise.
  const capsuleSupply = await readCapsuleSupply(capsuleCollection.toLowerCase(), capsuleTokenId)
  if (!capsuleSupply) return errorResponse(400, 'Could not read the capsule token on-chain')

  // Live headroom per entry, plus what OTHER machines have already pledged
  // against the same edition. Without the second half, two machines can each
  // promise the same last copy and only one can be honoured.
  const headroom: Record<string, number | null> = {}
  const pledges: Record<string, number> = {}
  await Promise.all(
    entries.map(async (e) => {
      const key = entryKey(e)
      const h = await readHeadroom(e.collection, e.tokenId)
      if (h !== undefined) headroom[key] = h
      pledges[key] = await otherPledges(e.collection, e.tokenId, id).catch(() => 0)
    }),
  )

  const problems = checkSolvency({
    capsuleMaxSupply: capsuleSupply.maxSupply,
    capsuleMinted: capsuleSupply.minted,
    entries,
    splitRecipients,
    creator,
    passCollection: gate.passCollection?.toLowerCase() ?? null,
    headroom,
    otherPledges: pledges,
  })
  if (problems.length > 0) {
    // Return ALL problems, not the first — a creator fixing a machine should
    // see the whole list rather than discovering them one submit at a time.
    return NextResponse.json({ ok: false, problems }, { status: 400 })
  }

  // Admin-created machines go live directly (that is the v1 platform season);
  // everyone else queues for curator review.
  const finalState: Machine['state'] = isAdmin ? 'live' : 'review'
  const machine: Machine = {
    id,
    creator,
    name,
    state: finalState,
    capsule: { collection: capsuleCollection.toLowerCase(), tokenId: capsuleTokenId },
    capsuleMaxSupply: capsuleSupply.maxSupply,
    createdAt: Date.now(),
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
    return errorResponse(409, 'That machine id is taken')
  }

  for (const e of entries) {
    await putPoolEntry(id, e)
    // Pledged BEFORE the machine is visible, on purpose. The opposite order
    // would let a machine go live in the window before its claim on those copies
    // is recorded, and another machine could promise the same last copy in the
    // meantime — the exact over-promise the ledger exists to prevent. The cost
    // is that an abandoned draft keeps holding headroom, which is recoverable by
    // deleting the draft; an over-promised edition is not recoverable at all.
    await pledgeSupply(e.collection, e.tokenId, id, e.supply)
  }

  const published = await setMachineState(id, finalState)

  return NextResponse.json({ ok: true, machine: published ?? machine })
}
