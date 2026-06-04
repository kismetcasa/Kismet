import { randomHex } from './random'
import { redis } from './redis'

/**
 * Single-leader execution for periodic background work in a multi-pod
 * deployment. Each pod's tick races to SET NX with a unique token; only
 * the winner runs `fn`, and only the winner can release the lock — a
 * Lua compare-and-delete prevents a slow predecessor from releasing a
 * successor's lock if the TTL expired mid-execution.
 *
 * Returns `fn`'s result if this pod won the lock; `null` if another pod
 * holds it (normal, not an error); throws if `fn` throws (after release).
 *
 * Pattern: Sidekiq's reliable-fetcher leader election. Keep `fn`
 * idempotent — if `ttlSec` is exceeded by `fn`'s runtime, the lock
 * expires and a parallel runner can acquire (brief duplicate work).
 */

const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`

export async function withLeaderLock<T>(
  label: string,
  ttlSec: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lockKey = `kismetart:lock:${label}`
  const token = randomHex(16)
  const acquired = (await redis.set(lockKey, token, { nx: true, ex: ttlSec })) === 'OK'
  if (!acquired) return null
  try {
    return await fn()
  } finally {
    // Best-effort release. Lua compare-and-delete: only DEL if the value
    // still matches our token (i.e. our lease hasn't expired and been
    // re-acquired by another pod in the meantime).
    await redis.eval(RELEASE_LUA, [lockKey], [token]).catch(() => {})
  }
}
