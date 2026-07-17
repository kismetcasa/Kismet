import { randomUUID } from 'crypto'
import { redis } from './redis'

// Single-flight lock over Redis with a SAFE (token-CAS) release. Extracted from
// three byte-identical hand-rolled copies (the stats rebuild, the catalog
// census, and distribute-all) so the Lua and the acquire/release dance live in
// one place — a correctness fix to any one (a cluster hash-tag, a typed return)
// now lands everywhere instead of drifting across copies.
//
// Acquire writes a unique token under the key with NX + TTL. Release deletes
// ONLY when the stored token still matches, so a holder whose lock already
// lapsed (TTL expired mid-run) and was re-acquired by a successor can never
// delete the successor's lock. The TTL bounds a crashed holder that never
// releases.

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`

export interface RedisLock {
  /** True when THIS call won the lock — the caller must release it. */
  acquired: boolean
  /** Release iff we still hold it (token match). No-op when `acquired` is
   *  false. Best-effort and never throws — safe to call in a `finally`. */
  release: () => Promise<void>
}

/**
 * Try to take the single-flight lock at `key` for `ttlSeconds`. `acquired` is
 * false when another holder has it (NX fails). This does NOT swallow a Redis
 * error on acquire — it propagates, matching the rebuild/census callers that
 * abort-and-retry-next-cron on a Redis blip; a caller that must fail-closed to
 * a response (distribute-all) wraps the call in `.catch()` and treats a throw
 * the same as `!acquired`.
 */
export async function acquireLock(key: string, ttlSeconds: number): Promise<RedisLock> {
  const token = randomUUID()
  const acquired = (await redis.set(key, token, { nx: true, ex: ttlSeconds })) === 'OK'
  return {
    acquired,
    release: async () => {
      if (!acquired) return
      await redis.eval(RELEASE_LOCK_LUA, [key], [token]).catch(() => {})
    },
  }
}
