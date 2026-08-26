import 'server-only'
import { redis } from './redis'
import { safeRead } from './redisRead'
import { memoize } from './memoCache'

/**
 * Admin-run "turn notifications on" campaign (one Redis stamp).
 *
 * Farcaster hosts own the notification permission: the only sanctioned
 * prompt is sdk.actions.addMiniApp() (adding = enabling notifications on
 * Farcaster), and a user who added-then-disabled can only re-enable from the
 * host's own mini-app menu — there is no API to prompt for that. So the
 * campaign is client-side by construction: the admin sets a stamp here; the
 * Mini App bootstrap (FarcasterProvider) compares it against a per-device
 * localStorage marker and, once per campaign, shows the add-prompt toast to
 * users who never added, or menu instructions to users who added with
 * notifications off. Users who already have push see nothing.
 *
 * The stamp rides the /api/me response the Mini App already fetches on every
 * open (zero extra requests client-side) and is memoized 60s server-side, so
 * a campaign costs ~1 Redis read/minute platform-wide regardless of opens.
 */

const KEY = 'kismetart:notif-nudge-at'

async function _getNotifNudgeAt(): Promise<number | null> {
  const raw = await safeRead('notif-nudge-get', () => redis.get<number | string>(KEY), null)
  if (raw == null) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

export const getNotifNudgeAt = memoize(_getNotifNudgeAt, 60_000)

/** Start a new campaign (stamp = now) or clear the running one (null). */
export async function setNotifNudge(at: number | null): Promise<void> {
  if (at === null) await redis.del(KEY)
  else await redis.set(KEY, String(at))
  getNotifNudgeAt.invalidate()
}
