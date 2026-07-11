import { redis } from '@/lib/redis'

/**
 * Scout kill-switch read with a fail-CLOSED cold-start default.
 *
 * The kill-switch (`kismetart:scout-killswitch`, toggled by
 * /api/admin/scout-killswitch) is the emergency stop for ALL autonomous
 * spending. The two spend paths (runScoutServer, runDropCoordination)
 * previously read it with a catch-and-proceed, so a Redis blip DURING an
 * incident would resume spending exactly when an operator was trying to halt it.
 *
 * This mirrors lib/gate.ts's fail-safe posture, applied to the one bit that
 * must fail closed:
 *   - Redis reachable                       → cache the live value, return it.
 *   - Redis THROWS but we have a cached value → return last-known-good.
 *   - Redis THROWS with NO cached value (cold start) → assume ENGAGED (halt).
 *
 * A missing key is a normal `null` read (NOT a throw) → not engaged → proceed,
 * so steady-state behavior and the verify harness are unchanged. The
 * fail-closed default only triggers on a genuine connection error, where
 * halting a background convenience for the brief window until the next
 * successful read is the safe, self-healing choice.
 */
let lastKnownEngaged: boolean | null = null

export async function isKillSwitchEngaged(): Promise<boolean> {
  try {
    const engaged = !!(await redis.get('kismetart:scout-killswitch'))
    lastKnownEngaged = engaged
    return engaged
  } catch {
    // Fail closed: last-known-good if we have one, else halt on cold start.
    return lastKnownEngaged ?? true
  }
}
