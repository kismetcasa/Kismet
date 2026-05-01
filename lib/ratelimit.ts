import { type NextRequest } from 'next/server'
import { redis } from './redis'

export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  )
}

// Fixed-window rate limiter. Fails open if Redis is unavailable.
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSecs: number
): Promise<boolean> {
  try {
    const k = `kismetart:rl:${key}`
    const count = await redis.incr(k)
    if (count === 1) await redis.expire(k, windowSecs)
    return count <= limit
  } catch {
    return true
  }
}
