#!/usr/bin/env node
/*
 * reconcile-fc-push-fids.mjs
 * ---------------------------------------------------------------------------
 * One-time backfill for the Farcaster push broadcast index.
 *
 * lib/farcasterNotifications.ts now maintains kismetart:fc:push-fids — the
 * SET of every FID holding a notification token — inline with registerToken /
 * clearTokens. Users who granted notifications BEFORE that change have a
 * kismetart:fc:tokens:<fid> SET but no index membership, so a broadcast
 * would silently skip them. This script closes that gap once:
 *
 *   1. SCAN the keyspace for kismetart:fc:tokens:*  (a one-off admin walk —
 *      the app itself never keyspace-SCANs; the index exists precisely so
 *      runtime code doesn't have to).
 *   2. SCARD each hit (pipelined) and keep only non-empty SETs.
 *   3. SADD the FIDs into kismetart:fc:push-fids.
 *
 * SAFE BY DEFAULT — dry-run unless --commit. IDEMPOTENT — SADD of an existing
 * member is a no-op, and racing the live webhook can't double-add. Re-run any
 * time; drift self-heals from then on (broadcast enumeration prunes stale
 * members, registerToken adds new ones atomically).
 *
 * Usage:
 *   node scripts/reconcile-fc-push-fids.mjs            # dry-run: report only
 *   node scripts/reconcile-fc-push-fids.mjs --commit   # write the index
 *
 * Where to run: the reconcile-*.mjs glob ships this file into the runtime
 * image (see Dockerfile), so the intended place is the Coolify container
 * console, where the env below is already set. Any shell with the prod env
 * vars works identically (self-contained — Node built-ins only).
 *
 * Env (same names the app reads):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

const TOKENS_PREFIX = 'kismetart:fc:tokens:'
const INDEX_KEY = 'kismetart:fc:push-fids'

// ---------------------------------------------------------------- args
const COMMIT = process.argv.slice(2).includes('--commit')

// ---------------------------------------------------------------- env
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('FATAL: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set')
  process.exit(1)
}

// ---------------------------------------------------------------- Upstash REST
async function redisCmd(cmd) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  })
  if (!res.ok) throw new Error(`redis ${cmd[0]} ${res.status}: ${await res.text()}`)
  return (await res.json()).result
}
async function redisPipeline(cmds) {
  if (cmds.length === 0) return []
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  })
  if (!res.ok) throw new Error(`redis pipeline ${res.status}: ${await res.text()}`)
  return (await res.json()).map((x) => x.result)
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`fc push-fids backfill — ${COMMIT ? 'COMMIT' : 'dry-run'} mode`)

  // 1. Walk the keyspace for token SETs. MATCH filters server-side; COUNT is
  //    a page-size hint. Cursor loop until 0, same contract as SSCAN.
  const tokenKeys = []
  let cursor = '0'
  let pages = 0
  do {
    const [next, keys] = await redisCmd(['SCAN', cursor, 'MATCH', `${TOKENS_PREFIX}*`, 'COUNT', '1000'])
    cursor = String(next)
    tokenKeys.push(...keys)
    pages++
  } while (cursor !== '0')
  console.log(`scanned keyspace: ${tokenKeys.length} token SET key(s) across ${pages} page(s)`)

  // 2. Parse FIDs and drop malformed keys (defensive — should not exist).
  const fidByKey = new Map()
  for (const key of tokenKeys) {
    const fid = Number(key.slice(TOKENS_PREFIX.length))
    if (Number.isInteger(fid) && fid > 0) fidByKey.set(key, fid)
    else console.warn(`  SKIP malformed key: ${key}`)
  }

  // 3. Keep only non-empty SETs (a DEL'd-then-recreated or TTL-lapsed key
  //    can linger in SCAN output as empty).
  const keys = [...fidByKey.keys()]
  const nonEmptyFids = []
  const CHUNK = 512 // stay well under Upstash's request-size cap, like mgetChunked
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK)
    const cards = await redisPipeline(slice.map((k) => ['SCARD', k]))
    slice.forEach((k, j) => {
      if (Number(cards[j]) > 0) nonEmptyFids.push(fidByKey.get(k))
    })
  }
  console.log(`${nonEmptyFids.length} fid(s) hold at least one token`)

  // 4. Diff against the current index so the report shows real drift.
  const already = new Set()
  if (nonEmptyFids.length > 0) {
    for (let i = 0; i < nonEmptyFids.length; i += CHUNK) {
      const slice = nonEmptyFids.slice(i, i + CHUNK)
      const flags = await redisCmd(['SMISMEMBER', INDEX_KEY, ...slice.map(String)])
      slice.forEach((fid, j) => {
        if (Number(flags[j]) === 1) already.add(fid)
      })
    }
  }
  const missing = nonEmptyFids.filter((fid) => !already.has(fid))
  console.log(`${already.size} already indexed, ${missing.length} missing`)

  if (missing.length === 0) {
    console.log('index is complete — nothing to do')
    return
  }
  if (!COMMIT) {
    console.log(`dry-run: would SADD ${missing.length} fid(s); re-run with --commit to apply`)
    return
  }

  // 5. Write in chunks; SADD is idempotent so a crash mid-way is re-runnable.
  let added = 0
  for (let i = 0; i < missing.length; i += CHUNK) {
    const slice = missing.slice(i, i + CHUNK)
    added += Number(await redisCmd(['SADD', INDEX_KEY, ...slice.map(String)]))
  }
  console.log(`done — ${added} fid(s) added to ${INDEX_KEY}`)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
