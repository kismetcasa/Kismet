import { type NextRequest } from 'next/server'
import { redis } from './redis'

export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

// Atomic INCR+EXPIRE via Lua. Two REST calls let a dropped EXPIRE
// leave the counter TTL-less, locking the IP out forever once the
// limit was crossed. EXPIRE stays scoped to the first INCR so the
// window remains fixed, not sliding.
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
  windowSecs: number
): Promise<boolean> {
  try {
    const k = `kismetart:rl:${key}`
    const count = (await redis.eval(RATELIMIT_LUA, [k], [windowSecs])) as number
    return count <= limit
  } catch {
    return true
  }
}
