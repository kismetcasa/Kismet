#!/usr/bin/env node
/*
 * reconcile-collector-files.mjs
 * ---------------------------------------------------------------------------
 * Detects and repairs drift between the three things that must agree for the
 * collector-file store to be correct (COLLECTOR_DOWNLOADS_DESIGN.md):
 *
 *   1. records   kismetart:cfile:<ref>            — which versions exist and
 *                                                   which of them hold bytes
 *   2. chunks    kismetart:cfile-blob:<ref>:<seq>:<i>
 *   3. ledger    kismetart:cfile-bytes            — the storage-ceiling meter
 *
 * commitCfileMutation writes all three in one MULTI, so they agree by
 * construction in normal operation. They can still diverge:
 *   - a chunk EVICTED under a non-`noeviction` Upstash policy (blob chunks
 *     are the largest values in the DB, so they are evicted first) — the
 *     record survives pointing at bytes that are gone;
 *   - a record lost or hand-edited outside the app, stranding chunks that
 *     nothing references and that carry no TTL once PERSISTed;
 *   - a partial restore from backup.
 *
 * Without this tool none of those is detectable (chunks are only reachable
 * by SCAN) or repairable, and the ceiling silently meters the wrong number.
 *
 * SAFE BY DEFAULT — reports only unless --commit. Repairs are conservative:
 * it deletes ONLY chunks that no record references, and rewrites ledger
 * entries to the value recomputed from the records themselves. It never
 * deletes a record and never touches a chunk a live version points at, so a
 * missing-chunk record is REPORTED, not "fixed" — recovery there is an
 * artist re-upload.
 *
 * Usage:
 *   node scripts/reconcile-collector-files.mjs
 *   node scripts/reconcile-collector-files.mjs --commit
 *
 * Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */

const COMMIT = process.argv.includes('--commit')
const URL_ = process.env.UPSTASH_REDIS_REST_URL
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
if (!URL_ || !TOKEN) {
  console.error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are required')
  process.exit(2)
}

// Mirrors lib/collectorFileCore.cfileStoredBytes — the ledger is only
// meaningful if this matches the encoder byte-for-byte.
const CHUNK_BYTES = 4 * 1024 * 1024
function storedBytesFor(size) {
  let total = 0
  for (let off = 0; off < size; off += CHUNK_BYTES) {
    const len = Math.min(CHUNK_BYTES, size - off)
    total += 1 + 4 * Math.ceil(len / 3)
  }
  return total
}

async function cmd(...args) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) throw new Error(`redis ${res.status}: ${await res.text()}`)
  const body = await res.json()
  if (body.error) throw new Error(body.error)
  return body.result
}

async function scanAll(match) {
  const keys = []
  let cursor = '0'
  do {
    const [next, batch] = await cmd('SCAN', cursor, 'MATCH', match, 'COUNT', '500')
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  return keys
}

const main = async () => {
  console.log(`reconcile-collector-files: ${COMMIT ? 'COMMIT' : 'dry run'}\n`)

  const recordKeys = await scanAll('kismetart:cfile:*')
  const chunkKeys = await scanAll('kismetart:cfile-blob:*')
  const ledger = (await cmd('HGETALL', 'kismetart:cfile-bytes')) ?? []

  // HGETALL comes back as a flat [field, value, …] array over REST.
  const ledgerMap = new Map()
  for (let i = 0; i + 1 < ledger.length; i += 2) ledgerMap.set(ledger[i], Number(ledger[i + 1]))

  // What the records say SHOULD exist.
  const expectedChunks = new Set()
  const expectedBytes = new Map()
  const missing = []
  for (const key of recordKeys) {
    const ref = key.slice('kismetart:cfile:'.length)
    const raw = await cmd('GET', key)
    let record
    try {
      record = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch {
      console.log(`  ! UNPARSEABLE record ${key} — left untouched`)
      continue
    }
    const versions = [record?.current, ...(record?.history ?? [])].filter(Boolean)
    const seen = new Set()
    let bytes = 0
    for (const v of versions) {
      if (!v.stored || seen.has(v.blobSeq)) continue
      seen.add(v.blobSeq)
      bytes += storedBytesFor(v.size)
      for (let i = 0; i < v.chunks; i++) {
        expectedChunks.add(`kismetart:cfile-blob:${ref}:${v.blobSeq}:${i}`)
      }
    }
    if (bytes > 0) expectedBytes.set(ref, bytes)
  }

  // 1. Records pointing at chunks that are GONE (eviction / partial restore).
  const present = new Set(chunkKeys)
  for (const k of expectedChunks) if (!present.has(k)) missing.push(k)

  // 2. Chunks nothing references (leaked storage — no TTL, unreachable).
  const orphans = chunkKeys.filter((k) => !expectedChunks.has(k))

  // 3. Ledger drift in either direction.
  const drift = []
  for (const [ref, want] of expectedBytes) {
    const have = ledgerMap.get(ref)
    if (have !== want) drift.push({ ref, have: have ?? 0, want })
  }
  for (const [ref, have] of ledgerMap) {
    if (!expectedBytes.has(ref)) drift.push({ ref, have, want: 0 })
  }

  console.log(`records: ${recordKeys.length}   chunks: ${chunkKeys.length}   ledger rows: ${ledgerMap.size}`)
  console.log(`expected chunks: ${expectedChunks.size}`)
  console.log(`total stored bytes (from records): ${[...expectedBytes.values()].reduce((a, b) => a + b, 0).toLocaleString()}\n`)

  if (missing.length) {
    console.log(`MISSING CHUNKS (${missing.length}) — these records cannot serve. NOT auto-repairable:`)
    for (const k of missing.slice(0, 20)) console.log(`  - ${k}`)
    if (missing.length > 20) console.log(`  … ${missing.length - 20} more`)
    console.log('  → check the Upstash eviction policy is `noeviction`; recovery is artist re-upload.\n')
  }

  if (orphans.length) {
    console.log(`ORPHANED CHUNKS (${orphans.length}) — referenced by nothing, no TTL:`)
    for (const k of orphans.slice(0, 20)) console.log(`  - ${k}`)
    if (orphans.length > 20) console.log(`  … ${orphans.length - 20} more`)
    if (COMMIT) {
      for (const k of orphans) await cmd('DEL', k)
      console.log(`  → deleted ${orphans.length}\n`)
    } else {
      console.log('  → re-run with --commit to delete\n')
    }
  }

  if (drift.length) {
    console.log(`LEDGER DRIFT (${drift.length}):`)
    for (const d of drift) console.log(`  - ${d.ref}: ledger=${d.have.toLocaleString()} actual=${d.want.toLocaleString()}`)
    if (COMMIT) {
      for (const d of drift) {
        if (d.want > 0) await cmd('HSET', 'kismetart:cfile-bytes', d.ref, String(d.want))
        else await cmd('HDEL', 'kismetart:cfile-bytes', d.ref)
      }
      console.log(`  → rewrote ${drift.length} ledger entries\n`)
    } else {
      console.log('  → re-run with --commit to rewrite\n')
    }
  }

  if (!missing.length && !orphans.length && !drift.length) {
    console.log('OK — records, chunks and ledger all agree.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
