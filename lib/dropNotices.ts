import 'server-only'
import { redis } from './redis'
import { bestEffort } from './bestEffort'
import { writeNotification } from './notifications'
import { countClaims, getSettlements, listDropsClosedBetween } from './arkiv/drops'
import { isDropsEnabled } from './dropsStore'
import { EXPIRY_WARNING_SECONDS, recordExpiresAt, SETTLE_GRACE_SECONDS, type DropRecord } from './drops'

/**
 * What a drop's artist is told that nothing else would tell them — run by the
 * background tick (lib/backgroundTasks). A closed drop waits on its artist,
 * and if they never come back its claims expire with its Arkiv records
 * (SETTLE_GRACE_SECONDS after closing) and the collectors never get the art.
 *
 *   closed    the drop closed with claims: deliver it.
 *   expiring  two days before the records expire, still not delivered.
 *
 * Each is sent at most once per drop (a SET NX that expires with the drop's
 * records), never for a drop nobody claimed or one already delivered. The
 * scan windows are bounded: drops that closed in the last day, and drops
 * whose records expire within EXPIRY_WARNING_SECONDS — so a missed tick (a
 * deploy) is caught up on the next one.
 */
const CLOSED_LOOKBACK_SECONDS = 24 * 60 * 60

type Stage = 'closed' | 'expiring'

const noticeKey = (dropKey: string, stage: Stage) => `kismetart:drops:notice:${dropKey}:${stage}`

export async function sendDropNotices(nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  if (!isDropsEnabled()) return 0
  const expiringFrom = nowSec - SETTLE_GRACE_SECONDS
  const [closed, expiring] = await Promise.all([
    listDropsClosedBetween(nowSec - CLOSED_LOOKBACK_SECONDS, nowSec),
    listDropsClosedBetween(expiringFrom, expiringFrom + EXPIRY_WARNING_SECONDS),
  ])
  const candidates: [DropRecord, Stage][] = [
    ...closed.filter((d) => d.closesAt <= nowSec).map((d): [DropRecord, Stage] => [d, 'closed']),
    ...expiring.map((d): [DropRecord, Stage] => [d, 'expiring']),
  ]
  // Cheap first: drops already noticed for this stage cost one EXISTS each.
  const due: [DropRecord, Stage][] = []
  for (const [drop, stage] of candidates) {
    if ((await redis.exists(noticeKey(drop.key, stage))) === 0) due.push([drop, stage])
  }
  if (due.length === 0) return 0

  const delivered = await getSettlements([...new Set(due.map(([d]) => d.key))])
  let sent = 0
  for (const [drop, stage] of due) {
    if (delivered.has(drop.key)) continue
    const claims = await countClaims(drop.key)
    // Marked either way, so a drop nobody claimed isn't recounted every tick.
    const first = await redis.set(noticeKey(drop.key, stage), '1', { nx: true, exat: recordExpiresAt(drop.closesAt) })
    if (first !== 'OK' || claims === 0) continue
    const ok = await writeNotification({
      type: 'drop_status',
      recipient: drop.artist,
      tokenName: drop.title,
      note: stage,
      amount: claims,
      dropKey: drop.key,
    }).catch(bestEffort('drops.notice', { dropKey: drop.key, stage }))
    if (ok) sent++
  }
  return sent
}
