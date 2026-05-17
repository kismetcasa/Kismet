import { type NextRequest } from 'next/server'
import { redis } from './redis'

export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

// Atomic INCR+EXPIRE. Splitting these into two REST round-trips meant a
// dropped EXPIRE left the counter TTL-less; once it crossed the limit
// the IP was rate-limited forever with no self-recovery. Bundling them
// in a Lua script makes the pair atomic server-side and keeps EXPIRE
// scoped to the first INCR (so the window stays fixed, not sliding).
const RATELIMIT_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n
`

// Fixed-window rate limiter. Fails open if Redis is unavailable.
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSecs: number,
): Promise<boolean> {
  try {
    const k = `kismetart:rl:${key}`
    const count = (await redis.eval(RATELIMIT_LUA, [k], [windowSecs])) as number
    return count <= limit
  } catch {
    return true
  }
}
