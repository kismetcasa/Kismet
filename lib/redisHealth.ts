/**
 * Passive Redis liveness signal for the readiness probe.
 *
 * Upstash bills per command, so a readiness probe that PINGs Redis on every
 * external probe interval (often every 5-30s, 24/7) is a pure constant drain —
 * thousands of commands/day independent of traffic. But under real traffic the
 * app is already exercising Redis constantly (rate-limit EVAL on ~every
 * request, session GET, feed reads), and a successful real op is itself proof
 * that Redis is reachable. So instead of a dedicated PING, the readiness probe
 * checks "did any real Redis op succeed recently?" and only falls through to an
 * actual PING when Redis hasn't been exercised within the freshness window
 * (genuinely idle, or genuinely down). Outage-detection latency is unchanged
 * (a down Redis stops updating this timestamp within the window, then the probe
 * pings and fails); the steady-state PING cost under load drops to ~zero.
 *
 * Updated from the highest-coverage hot paths (checkRateLimit, safeRead/
 * strictRead). Module-scoped, so it is per-process — correct for the single
 * long-lived server; each pod would track its own under multi-pod (fine, the
 * probe is per-pod too).
 */
let lastRedisSuccessAt = 0

export function markRedisSuccess(): void {
  lastRedisSuccessAt = Date.now()
}

/** Milliseconds since the last observed successful Redis op (Infinity if none yet). */
export function msSinceRedisSuccess(): number {
  return lastRedisSuccessAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastRedisSuccessAt
}
