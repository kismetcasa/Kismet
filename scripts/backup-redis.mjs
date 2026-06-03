#!/usr/bin/env node
// Logical export of the Upstash Redis keyspace to NDJSON on stdout — one
// record per line: { key, type, pttl, value }.
//
// SECONDARY backup. The PRIMARY is Upstash's native Daily Backup (Console →
// the DB's Backups tab, or the enable_dailybackup Developer API) — available
// on every plan. This script complements it with an OFF-Upstash, longer-
// retention, cross-provider copy (native restore flushes the destination and
// retention is 1 day on free / 3 on Prod Pack). See REMEDIATION_PLAYBOOK.md §B2.
//
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
//     node scripts/backup-redis.mjs > backup-$(date +%F).ndjson
//   # then store it wherever, e.g.:  ... | aws s3 cp - s3://bucket/redis/$(date +%F).ndjson
//
// Notes:
//  - SCAN can return the same key more than once; we dedupe via a Set.
//  - Values are read whole. A single key whose value exceeds Upstash's 10 MB
//    per-request cap will error here — but such a key already breaks the app's
//    own reads and should be redesigned, so failing loudly is correct.
import { Redis } from '@upstash/redis'

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN
if (!url || !token) {
  console.error('[backup] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required')
  process.exit(1)
}
const redis = new Redis({ url, token })

async function dumpValue(key, type) {
  switch (type) {
    case 'string':
      return await redis.get(key)
    case 'set':
      return await redis.smembers(key)
    case 'zset':
      // Interleaved [member, score, member, score, ...] — restore reassembles.
      return await redis.zrange(key, 0, -1, { withScores: true })
    case 'hash':
      return await redis.hgetall(key)
    case 'list':
      return await redis.lrange(key, 0, -1)
    default:
      return null // stream / unknown — skipped
  }
}

let cursor = '0'
const seen = new Set()
let count = 0
do {
  const [next, keys] = await redis.scan(cursor, { count: 1000 })
  cursor = next
  for (const key of keys) {
    if (seen.has(key)) continue
    seen.add(key)
    const type = await redis.type(key)
    if (type === 'none') continue
    const value = await dumpValue(key, type)
    if (value === null && type !== 'string') continue
    const pttl = await redis.pttl(key) // ms; -1 = no expiry, -2 = no key
    process.stdout.write(JSON.stringify({ key, type, pttl, value }) + '\n')
    count++
  }
} while (cursor !== '0')

console.error(`[backup] exported ${count} keys`)
