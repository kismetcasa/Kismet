#!/usr/bin/env node
// One-shot: write the missing per-moment KV creator record for a single
// cover-image mint deployed before the field-level fixes shipped (commits
// e438700 added kv.coverTokenId persistence; 2704bd0 added the
// instrumentation-time backfill — which still skips collections whose
// stored meta lacks coverTokenId, so the very first cover-mint slips
// through both nets).
//
// Without this record the timeline route's KV stitching has nothing to
// override the wrong creator inprocess returns for cover tokens (deploy
// runs through the factory, so creator.address comes back as the factory
// / smart-wallet address instead of the artist EOA), and the moment
// disappears from every creator-filtered feed.
//
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
//     node scripts/backfill-cover-moment.mjs <collection> [--creator 0x...] [--token 1]
//
// Idempotent: aborts if a moment-meta record already exists at the target
// key so an existing (possibly hand-corrected) entry isn't overwritten.

import { Redis } from '@upstash/redis'

const argv = process.argv.slice(2)
const positional = []
const flags = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--creator' || a === '--token' || a === '--name') {
    flags[a.slice(2)] = argv[++i]
  } else if (a.startsWith('--')) {
    console.error(`unknown flag: ${a}`)
    process.exit(1)
  } else {
    positional.push(a)
  }
}

const collectionArg = positional[0]
if (!collectionArg) {
  console.error(
    'usage: node scripts/backfill-cover-moment.mjs <collection> [--creator 0x...] [--token 1] [--name "..."]',
  )
  process.exit(1)
}
if (!/^0x[a-fA-F0-9]{40}$/.test(collectionArg)) {
  console.error('collection must be a 0x-prefixed 40-char address')
  process.exit(1)
}
const collection = collectionArg.toLowerCase()
const tokenId = flags.token ?? '1'
if (!/^\d+$/.test(tokenId)) {
  console.error('token must be a numeric token id')
  process.exit(1)
}

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN
if (!url || !token) {
  console.error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set')
  process.exit(1)
}
const redis = new Redis({ url, token })

const collectionMetaKey = `kismetart:collection-meta:${collection}`
const momentMetaKey = `kismetart:moment-meta:${collection}:${tokenId}`

const rawMeta = await redis.get(collectionMetaKey)
if (!rawMeta) {
  console.error(`no collection-meta found at ${collectionMetaKey}`)
  process.exit(1)
}
const meta = typeof rawMeta === 'string' ? JSON.parse(rawMeta) : rawMeta

const name = flags.name ?? meta?.name
if (!name) {
  console.error('collection-meta has no name and --name not provided; aborting')
  process.exit(1)
}

const creatorArg = flags.creator ?? meta?.artist
if (!creatorArg) {
  console.error(
    'collection-meta has no artist and --creator not provided; pass --creator 0x... (the artist EOA)',
  )
  process.exit(1)
}
if (!/^0x[a-fA-F0-9]{40}$/.test(creatorArg)) {
  console.error('creator must be a 0x-prefixed 40-char address')
  process.exit(1)
}
const creator = creatorArg.toLowerCase()

const existing = await redis.get(momentMetaKey)
if (existing) {
  console.log('moment-meta already exists; nothing to do', {
    key: momentMetaKey,
    existing,
  })
  process.exit(0)
}

const value = { creator, name }
await redis.set(momentMetaKey, JSON.stringify(value))

console.log('wrote moment-meta', { key: momentMetaKey, value })
