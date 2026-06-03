#!/usr/bin/env node
// Restore a backup-redis.mjs NDJSON export, re-applying each key's TTL.
//
// INTENDED FOR A SCRATCH / EMPTY DB. It does not flush, but a key of the same
// name is overwritten. Mirror of the dump in scripts/backup-redis.mjs. After
// restoring into a fresh DB, re-point the app at it (UPSTASH_REDIS_REST_URL).
//
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
//     node scripts/restore-redis.mjs backup-2026-06-03.ndjson
//   # or pipe:  cat backup.ndjson | node scripts/restore-redis.mjs
import { Redis } from '@upstash/redis'
import { createInterface } from 'node:readline'
import fs from 'node:fs'

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN
if (!url || !token) {
  console.error('[restore] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required')
  process.exit(1)
}
const redis = new Redis({ url, token })

const file = process.argv[2]
const input = file ? fs.createReadStream(file) : process.stdin
const rl = createInterface({ input, crlfDelay: Infinity })

let count = 0
for await (const line of rl) {
  if (!line.trim()) continue
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    continue
  }
  const { key, type, pttl, value } = rec
  if (value == null && type !== 'string') continue

  switch (type) {
    case 'string':
      await redis.set(key, value)
      break
    case 'set':
      if (Array.isArray(value) && value.length) await redis.sadd(key, ...value)
      break
    case 'zset': {
      // Reassemble [member, score, member, score, ...] into {score, member}.
      const members = []
      for (let i = 0; i + 1 < value.length; i += 2) {
        members.push({ member: value[i], score: Number(value[i + 1]) })
      }
      if (members.length) await redis.zadd(key, ...members)
      break
    }
    case 'hash':
      if (value && Object.keys(value).length) await redis.hset(key, value)
      break
    case 'list':
      if (Array.isArray(value) && value.length) await redis.rpush(key, ...value)
      break
    default:
      continue
  }
  if (typeof pttl === 'number' && pttl > 0) await redis.pexpire(key, pttl)
  count++
}

console.error(`[restore] restored ${count} keys`)
