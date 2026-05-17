import { Redis } from '@upstash/redis'

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN

// Warn-and-continue rather than throw: Next.js's `Collecting page data`
// pass loads route modules during build and top-level env reads can
// happen before the build environment is fully populated. Throwing here
// would kill the build; a placeholder lets it complete, and any actual
// Redis call at runtime will surface the misconfig via Upstash's own
// error path.
if (!url || !token) {
  console.warn(
    '[redis] UPSTASH_REDIS_REST_URL/TOKEN not set — Redis calls will fail at runtime',
  )
}

export const redis = new Redis({
  url: url ?? 'https://placeholder.upstash.io',
  token: token ?? 'placeholder',
})

export const FEATURED_KEY = 'kismetart:featured'
export const FEATURED_COLLECTIONS_KEY = 'kismetart:featured-collections'
export const TRENDING_KEY = 'kismetart:trending'
