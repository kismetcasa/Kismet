import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { hydrateArtworkMeta } from '@/lib/experience/artwork'
import { historyOf, kismetOf } from '@/lib/experience/kismet'
import { getMachine } from '@/lib/experience/store'
import { isReveal } from '@/lib/experience/types'

export const dynamic = 'force-dynamic'

/** Machines shown on a profile, most kismet first. */
const MAX_MACHINES = 50
/** Recent plays and collects shown on a profile. */
const HISTORY_SHOWN = 30

/**
 * A person's kismet — one for each paid play, by machine — and what the
 * machines gave them, newest first (lib/experience/kismet). Public, as a
 * profile is: plays are on chain already, and this only counts them.
 */
export async function GET(req: NextRequest) {
  if (!(await checkRateLimit(`xp-kismet:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const raw = new URL(req.url).searchParams.get('account') ?? ''
  if (!isAddress(raw)) return errorResponse(400, 'Invalid account')
  const account = raw.toLowerCase()

  const [{ total, machines }, history] = await Promise.all([kismetOf(account), historyOf(account, HISTORY_SHOWN)])
  const ids = [...new Set([...machines.slice(0, MAX_MACHINES).map((m) => m.id), ...history.map((h) => h.m)])]
  const records = new Map(
    (await Promise.all(ids.map(async (id) => [id, await getMachine(id).catch(() => null)] as const))).filter(
      (r): r is readonly [string, NonNullable<Awaited<ReturnType<typeof getMachine>>>] => r[1] !== null,
    ),
  )
  const art = await hydrateArtworkMeta(history.map((h) => ({ collection: h.c, tokenId: h.t })))

  return NextResponse.json(
    {
      total,
      machines: machines.slice(0, MAX_MACHINES).flatMap((m) => {
        const r = records.get(m.id)
        return r ? [{ id: m.id, name: r.name, kind: isReveal(r) ? 'reveal' : 'capsule', state: r.state, cover: r.cover?.uri ?? null, kismet: m.kismet }] : []
      }),
      history: history.map((h) => {
        const r = records.get(h.m)
        const meta = art[`${h.c}:${h.t}`]
        return {
          machineId: h.m,
          machineName: r?.name ?? null,
          kind: h.k,
          collection: h.c,
          tokenId: h.t,
          name: meta?.name ?? null,
          image: meta?.image ?? null,
          txHash: h.tx,
          unitIndex: h.u,
          at: h.at,
        }
      }),
    },
    { headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=60' } },
  )
}
