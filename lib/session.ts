import { redis } from './redis'
import { randomUUID } from 'crypto'

const SESSION_TTL = 7 * 24 * 60 * 60 // 7 days in seconds
const key = (token: string) => `kismetart:session:${token}`

export async function createSession(address: string): Promise<string> {
  const token = randomUUID()
  await redis.setex(key(token), SESSION_TTL, address.toLowerCase())
  return token
}

export async function verifySession(token: string): Promise<string | null> {
  return redis.get<string>(key(token))
}

export async function revokeSession(token: string): Promise<void> {
  await redis.del(key(token))
}
