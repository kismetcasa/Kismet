#!/usr/bin/env node
/*
 * reconcile-tracked-collections.mjs
 * ---------------------------------------------------------------------------
 * Repairs the "minted-through-Kismet but collection never tracked" gap.
 *
 * Every mint relayed through Kismet writes `<addr>:<tokenId>` into
 * kismetart:created-mints (lib/mint-proxy), but registration of an
 * auto-deployed wrapper collection into the tracked set
 * (kismetart:collections) was historically CLIENT-side only
 * (registerCollectionWithBackoff after the mint response) — and the agent
 * mint path has no browser at all. A lost registration makes every moment in
 * that collection invisible in EVERY feed, the artist's profile included:
 * the timeline fan-out only fetches tracked collections. Confirmed in
 * production 2026-08-12 (0x81c9052a…ace8 — created-mints member present,
 * collection absent from the tracked set). mint-proxy now registers
 * server-side, so the gap no longer grows; this script repairs the past.
 *
 * Detection is a pure Redis set-diff with no false positives: created-mints
 * is written only by Kismet's relay, the Create-Collection cover path, and
 * the timeline's off-platform admission — and admission only ever sees
 * moments in already-tracked collections. So a created-mints collection
 * absent from the tracked set can only be a lost registration. Nothing ever
 * removes from the tracked set (collection-hide is a separate axis), so
 * re-adding cannot resurrect something deliberately removed.
 *
 * The repair SADDs the collection into the MASTER tracked set only — never
 * the curated set (kismetart:created-collections), so nothing gains a
 * collection-shaped surface (same never-curate rule as auto-deploy
 * registration). No meta record is written: the epoch-based Mints admission
 * (lib/feedAdmission) needs none, and fabricating name/artist here would
 * launder feed-attributed data into trusted KV.
 *
 * SAFE BY DEFAULT — dry-run unless --commit. IDEMPOTENT — SADD of a present
 * member is a no-op; safe to re-run and to race the live server. Case
 * handling mirrors reconcile-curated-collections.mjs: the tracked set can
 * hold checksummed variants, so membership is compared case-insensitively
 * against the stored strings; repairs write the lowercase form.
 *
 * NOTE: the app memoizes the tracked set in-process for 15 min
 * (lib/kv.ts SET_CACHE_TTL_MS) and this script writes out-of-process, so
 * repaired collections appear in feeds within that window — no restart
 * needed.
 *
 * Usage:
 *   node scripts/reconcile-tracked-collections.mjs             # dry-run: report every lost registration
 *   node scripts/reconcile-tracked-collections.mjs --commit    # repair (SADD into the tracked set)
 *
 * Env (same names the app reads):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

// ---------------------------------------------------------------- args / env
const COMMIT = process.argv.includes('--commit')
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('FATAL: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set')
  process.exit(1)
}

// Baked-in platform collection (lib/config.ts PLATFORM_COLLECTION): tracked
// via code constant, so it is never "missing" even if absent from the set.
const PLATFORM_COLLECTION = '0x349d3da472bdd2fbeebf8e0bbaf4220160a62526'

const KEY_TRACKED = 'kismetart:collections'
const KEY_CREATED_MINTS = 'kismetart:created-mints'
const INPROCESS = 'https://api.inprocess.world/api'

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

// Tally created-mints members ("<addr>:<tokenId>") into per-collection
// counts. SSCAN (paged) — never SMEMBERS: the set grows one member per mint
// forever (same pattern as reconcile-curated-collections.mjs).
async function collectionsFromCreatedMints() {
  const counts = new Map()
  let cursor = '0'
  let scanned = 0
  do {
    const [next, chunk] = await redisCmd(['SSCAN', KEY_CREATED_MINTS, cursor, 'COUNT', '1000'])
    cursor = next
    if (Array.isArray(chunk)) {
      for (const m of chunk) {
        scanned++
        const s = String(m)
        const i = s.lastIndexOf(':')
        if (i <= 0) continue
        const coll = s.slice(0, i).toLowerCase()
        counts.set(coll, (counts.get(coll) || 0) + 1)
      }
    }
  } while (String(cursor) !== '0')
  return { counts, scanned }
}

// Best-effort context for the report: newest row of the collection's In
// Process timeline (name + creator + date make a lost wrapper recognizable).
async function describeCollection(lower) {
  try {
    const res = await fetch(
      `${INPROCESS}/timeline?collection=${lower}&limit=1&chain_id=8453`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) return null
    const data = await res.json()
    const m = Array.isArray(data?.moments) ? data.moments[0] : null
    if (!m) return null
    return {
      name: m.metadata?.name,
      creator: m.creator?.address?.toLowerCase(),
      newest: m.created_at,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- main
async function main() {
  console.log('='.repeat(78))
  console.log('reconcile-tracked-collections')
  console.log(`Mode: ${COMMIT ? 'COMMIT (writing to Redis)' : 'DRY-RUN (no writes)'}`)
  console.log('='.repeat(78))

  const [trackedRaw, mints] = await Promise.all([
    redisCmd(['SMEMBERS', KEY_TRACKED]),
    collectionsFromCreatedMints(),
  ])
  const trackedLower = new Set((trackedRaw || []).map((m) => String(m).toLowerCase()))
  trackedLower.add(PLATFORM_COLLECTION)
  const { counts, scanned } = mints
  console.log(
    `tracked: ${trackedLower.size} | created-mints: ${scanned} members across ${counts.size} collections\n`,
  )

  const missing = [...counts.keys()].filter((c) => !trackedLower.has(c)).sort()
  if (missing.length === 0) {
    console.log('No lost registrations — every created-mints collection is tracked. Nothing to do.')
    return
  }

  console.log(`${missing.length} collection(s) have Kismet mints but are NOT tracked (invisible in all feeds):\n`)
  for (const lower of missing) {
    const info = await describeCollection(lower)
    const desc = info
      ? `"${info.name ?? '?'}" creator=${info.creator ?? '?'} newest=${info.newest ?? '?'}`
      : '(In Process timeline unreachable — repair is still safe; detection is Redis-only)'
    console.log(`  ${lower}  mints=${counts.get(lower)}  ${desc}`)
    if (COMMIT) {
      const added = await redisCmd(['SADD', KEY_TRACKED, lower])
      console.log(`         ↳ SADD ${KEY_TRACKED} → ${added === 1 ? 'registered' : 'already present (raced the live server)'}`)
    } else {
      console.log(`         ↳ would run: SADD ${KEY_TRACKED} ${lower}`)
    }
  }
  console.log(
    COMMIT
      ? '\nDone. Feeds pick the repairs up within the 15-min tracked-set cache window.'
      : '\nDry-run only — re-run with --commit to repair.',
  )
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
