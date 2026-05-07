import { Redis } from '@upstash/redis'

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN
if (!url || !token) {
  // Redis powers sessions, profiles, hidden state, featured feeds,
  // listings, and rate limits — the app cannot meaningfully boot
  // without it. Fail fast with a clear message.
  throw new Error(
    'UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required',
  )
}

export const redis = new Redis({ url, token })

export const FEATURED_KEY = 'kismetart:featured'
export const FEATURED_COLLECTIONS_KEY = 'kismetart:featured-collections'
