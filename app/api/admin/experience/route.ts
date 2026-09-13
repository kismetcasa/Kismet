import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { recordAdminAction } from '@/lib/adminAudit'
import { deriveOdds, entryKey } from '@/lib/experience/draw'
import { checkSolvency } from '@/lib/experience/solvency'
import { resolveCapsulePayees } from '@/lib/experience/payees'
import { checkCapsuleControl, readCapsuleSupply, readHeadroom } from '@/lib/experience/authority'
import { getGateConfig } from '@/lib/gate'
import {
  buildSnapshot,
  getMachine,
  getPool,
  getRemaining,
  listMachines,
  otherPledges,
  releaseCapsule,
  releasePledge,
  setMachineState,
} from '@/lib/experience/store'
import type { MachineState } from '@/lib/experience/types'

/**
 * The curator review queue.
 *
 * Machines created by non-admins land in `review` by design — open publishing
 * behind a moderation gate. Until this route existed that was a dead end: the
 * create route was the ONLY caller of setMachineState, so a reviewed machine
 * could never be promoted and the review state was a black hole. This is the
 * other half of that design.
 *
 * A reviewer needs to judge the machine, not just its name, so the GET returns
 * each queued machine WITH the pool, its derived odds and a re-run of the
 * publish-time solvency check against live on-chain headroom. Solvency is
 * re-evaluated at review rather than trusted from creation because headroom and
 * other machines' pledges both move in between — a machine that was solvent
 * when submitted can be insolvent by the time anyone looks at it.
 */

const TRANSITIONS: MachineState[] = ['live', 'ended', 'delisted', 'review']

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`admin-xp-get:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const url = new URL(req.url)
  const wanted = url.searchParams.get('state')
  const states: MachineState[] | undefined =
    wanted && TRANSITIONS.includes(wanted as MachineState)
      ? [wanted as MachineState]
      : (['review', 'live', 'ended', 'delisted', 'draft'] as MachineState[])

  const machines = await listMachines(states)
  const gate = await getGateConfig()

  const detailed = await Promise.all(
    machines.slice(0, 50).map(async (m) => {
      const [pool, remaining, capsule, payees] = await Promise.all([
        getPool(m.id),
        getRemaining(m.id),
        readCapsuleSupply(m.capsule.collection, m.capsule.tokenId),
        resolveCapsulePayees({
          collection: m.capsule.collection,
          tokenId: m.capsule.tokenId,
          creator: m.creator,
        }),
      ])

      // Live re-check, not the verdict stored at creation: headroom and rival
      // pledges both move, so a machine can go insolvent while it waits.
      const headroom: Record<string, number | null> = {}
      const pledges: Record<string, number> = {}
      await Promise.all(
        pool.map(async (e) => {
          const key = entryKey(e)
          const h = await readHeadroom(e.collection, e.tokenId)
          if (h !== undefined) headroom[key] = h
          pledges[key] = await otherPledges(e.collection, e.tokenId, m.id).catch(() => 0)
        }),
      )

      const problems = checkSolvency({
        capsuleMaxSupply: capsule?.maxSupply ?? m.capsuleMaxSupply,
        capsuleMinted: capsule?.minted ?? 0,
        entries: pool,
        // Re-resolved from the capsule, not read back from the machine and not
        // defaulted to the pool's own artists — either shortcut makes
        // 'artist-not-in-split' pass by construction, which is the vacuous check
        // lib/experience/payees exists to end. A capsule whose payees cannot be
        // named yields an empty set, so every foreign artist is flagged.
        splitRecipients: payees.ok ? payees.recipients : [],
        creator: m.creator,
        passCollection: gate.passCollection?.toLowerCase() ?? null,
        headroom,
        otherPledges: pledges,
      })

      return {
        machine: m,
        pool,
        odds: deriveOdds(buildSnapshot(pool, remaining)).map((o) => ({ ...o, key: entryKey(o) })),
        capsule,
        problems,
      }
    }),
  )

  return NextResponse.json({ machines: detailed })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`admin-xp:${ip}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { id?: string; state?: string } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const id = typeof body.id === 'string' ? body.id.toLowerCase() : ''
  const state = body.state as MachineState
  if (!/^[a-z0-9-]{3,64}$/.test(id)) return errorResponse(400, 'Invalid id')
  if (!TRANSITIONS.includes(state)) return errorResponse(400, 'Invalid state')

  const machine = await getMachine(id)
  if (!machine) return errorResponse(404, 'Machine not found')

  // Promoting to `live` re-runs the publish gate. A reviewer approving a
  // machine that has gone insolvent while queued would put a machine on sale
  // that cannot honour its own capsules — the one thing the solvency model
  // exists to prevent, and the moment it is easiest to let through.
  if (state === 'live') {
    const [pool, capsule, gate, payees] = await Promise.all([
      getPool(id),
      readCapsuleSupply(machine.capsule.collection, machine.capsule.tokenId),
      getGateConfig(),
      resolveCapsulePayees({
        collection: machine.capsule.collection,
        tokenId: machine.capsule.tokenId,
        creator: machine.creator,
      }),
    ])
    const control = await checkCapsuleControl({
      collection: machine.capsule.collection,
      tokenId: machine.capsule.tokenId,
      creator: machine.creator,
    })
    if (!control.ok) {
      return NextResponse.json(
        { ok: false, problems: [{ code: `capsule-${control.code}`, detail: control.detail }] },
        { status: 400 },
      )
    }
    if (!payees.ok) {
      return NextResponse.json(
        { ok: false, problems: [{ code: 'capsule-split-unverifiable', detail: payees.reason }] },
        { status: 400 },
      )
    }
    const headroom: Record<string, number | null> = {}
    const pledges: Record<string, number> = {}
    await Promise.all(
      pool.map(async (e) => {
        const key = entryKey(e)
        const h = await readHeadroom(e.collection, e.tokenId)
        if (h !== undefined) headroom[key] = h
        pledges[key] = await otherPledges(e.collection, e.tokenId, id).catch(() => 0)
      }),
    )
    const problems = checkSolvency({
      capsuleMaxSupply: capsule?.maxSupply ?? machine.capsuleMaxSupply,
      capsuleMinted: capsule?.minted ?? 0,
      entries: pool,
      splitRecipients: payees.recipients,
      creator: machine.creator,
      passCollection: gate.passCollection?.toLowerCase() ?? null,
      headroom,
      otherPledges: pledges,
    })
    if (problems.length > 0) {
      return NextResponse.json({ ok: false, problems }, { status: 400 })
    }
  }

  // Rejecting outright frees the edition headroom this machine was holding, so
  // a declined submission stops blocking every other machine that wants the
  // same pieces. `ended` deliberately does NOT release: an ended season still
  // owes its outstanding capsules.
  if (state === 'delisted') {
    const pool = await getPool(id)
    await Promise.all([
      ...pool.map((e) => releasePledge(e.collection, e.tokenId, id).catch(() => {})),
      // The capsule token too: a delisted machine no longer honours plays (the
      // play route refuses it), so holding its reservation would strand the
      // token forever. Released together with the pledges so the two halves of
      // "this machine no longer claims anything" cannot drift apart.
      releaseCapsule(machine.capsule.collection, machine.capsule.tokenId, id).catch(() => {}),
    ])
  }

  const next = await setMachineState(id, state)
  await recordAdminAction('experience-state', {
    actor: auth.signer,
    target: id,
    meta: { from: machine.state, to: state },
  })

  return NextResponse.json({ ok: true, machine: next })
}
