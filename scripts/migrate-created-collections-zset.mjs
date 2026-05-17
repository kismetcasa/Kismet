#!/usr/bin/env node
// One-time SET→ZSET migration for the curated collections set. Idempotent
// (ZADD NX). Run with UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
// After verifying ZRANGE looks right, drop the old SET with:
//   redis-cli DEL kismetart:created-collections

import { Redis } from '@upstash/redis'

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN
if (!url || !token) {
  console.error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set')
  process.exit(1)
}

const SRC = 'kismetart:created-collections'
const DST = 'kismetart:created-collections-z'

const redis = new Redis({ url, token })

const members = await redis.smembers(SRC)
if (members.length === 0) {
  console.log('[migrate] nothing to copy')
  process.exit(0)
}

// Anchor 24h back so legacy entries sort below live writes that may
// land during cutover.
const anchor = Date.now() - 24 * 60 * 60 * 1000
const pairs = members.map((member) => ({ score: anchor, member }))

const added = await redis.zadd(DST, { nx: true }, ...pairs)
console.log(`[migrate] ZADD NX: ${added} new members into ${DST} (src had ${members.length})`)
