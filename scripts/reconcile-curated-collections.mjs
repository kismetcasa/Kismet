#!/usr/bin/env node
/*
 * reconcile-curated-collections.mjs
 * ---------------------------------------------------------------------------
 * Repairs auto-deploy wrappers mis-filed as curated collections.
 *
 * An "individual mint" (no collection picked) auto-deploys a single-token Zora
 * 1155 wrapper. It is SUPPOSED to join only the master tracked set
 * (kismetart:collections) for moment fan-out, and NEVER the curated set
 * (kismetart:created-collections) that every collection-shaped surface reads
 * (profile Collections tab, mint picker, discovery feed, search, sitemap,
 * collection page). If a wrapper leaks into the curated set — historically via
 * the registration endpoint's fail-OPEN source default, now closed in
 * app/api/collections/route.ts — it masquerades as a public collection with no
 * in-app way to remove it (there is no un-curate path; hiding the moment is the
 * wrong axis, and collection-hide is bypassed for the owner's own view).
 *
 * This script is the removal path. It NEVER touches the master set or the meta
 * record — the mint stays a tracked contract and still appears in Mints; it
 * only SREMs the mis-classification from the curated set, after which every
 * collection surface self-corrects (they all derive from that one set).
 *
 * SAFE BY DEFAULT — dry-run unless --commit. IDEMPOTENT — SREM of an
 * already-removed member is a no-op; safe to re-run and safe to race the (now
 * fail-closed) live endpoint. It NEVER auto-removes in scan mode: classifying a
 * one-token collection as wrapper-vs-deliberate is inherently ambiguous, so scan
 * only REPORTS evidence + a verdict and removal is always operator-confirmed by
 * explicit --address.
 *
 * CASE HANDLING: the curated/master sets store the raw (often checksummed)
 * address exactly as registered, and can even hold case-variant duplicates of
 * one contract. Membership and removal therefore match case-INSENSITIVELY
 * against the actual stored strings and SREM every stored variant — a
 * lowercased SREM alone would silently miss a checksummed member.
 *
 * Signals (Redis-only; no RPC needed):
 *   - meta.coverTokenId present     → deliberate Create-Collection cover → KEEP
 *   - created-mints count > 1       → multiple tokens minted → KEEP (real collection)
 *   - else (<=1 token, no cover)    → REVIEW (likely a first-mint wrapper)
 *
 * Usage:
 *   node scripts/reconcile-curated-collections.mjs                       # dry-run scan: report every curated member + verdict
 *   node scripts/reconcile-curated-collections.mjs --address 0xabc...     # inspect one (or comma-separated many)
 *   node scripts/reconcile-curated-collections.mjs --address 0xabc... --commit   # un-curate it (SREM created-collections)
 *
 * Env (same names the app reads):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *
 * Note: the app memoizes getUserCollections for 15 min with an own-pod
 * invalidate on write. This script writes out-of-process, so a removed wrapper
 * can linger in a running pod's cache for up to that TTL before the surfaces
 * reflect the change. It self-heals; no restart required.
 */

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const flagVal = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const COMMIT = hasFlag('--commit')
const ADDRESSES = (flagVal('--address') || '')
  .split(',')
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean)

// ---------------------------------------------------------------- env
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('FATAL: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set')
  process.exit(1)
}
for (const a of ADDRESSES) {
  if (!/^0x[0-9a-f]{40}$/.test(a)) {
    console.error(`FATAL: --address ${a} is not a valid 0x-address`)
    process.exit(1)
  }
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

// key builders — mirror lib/kv.ts + lib/hiddenCollections.ts EXACTLY
const KEY_MASTER = 'kismetart:collections'
const KEY_CURATED = 'kismetart:created-collections'
const KEY_CREATED_MINTS = 'kismetart:created-mints'
const KEY_HIDDEN_COLLECTIONS = 'kismetart:hidden-collections'
const kMeta = (addrLower) => `kismetart:collection-meta:${addrLower}`

// ---------------------------------------------------------------- helpers
// Group a set's raw members by lowercase key, preserving the exact stored
// strings (there can be case-variant duplicates of one contract). SMEMBERS is
// safe on the curated/master sets — both are bounded by contract count, and the
// app itself SMEMBERS them (getUserCollections / getTrackedCollections).
async function membersByLower(key) {
  const raw = (await redisCmd(['SMEMBERS', key])) || []
  const byLower = new Map()
  for (const m of raw) {
    const lower = String(m).toLowerCase()
    const arr = byLower.get(lower)
    if (arr) arr.push(String(m))
    else byLower.set(lower, [String(m)])
  }
  return byLower
}

// Tally created-mints members ("<addr>:<tokenId>") into per-collection counts.
// SSCAN (paged) — never SMEMBERS: this set grows one member per mint forever,
// so the app dropped SMEMBERS on it (Upstash 10MB reply cap).
async function buildMintCounts() {
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

function parseMeta(raw) {
  if (!raw) return null
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}

// Verdict from Redis-only signals. Conservative: only flags REVIEW when there
// is no positive keep-signal, and removal is still operator-confirmed.
function classify({ meta, mintCount }) {
  if (meta && meta.coverTokenId) return { verdict: 'KEEP', why: 'has coverTokenId (deliberate cover mint)' }
  if (mintCount > 1) return { verdict: 'KEEP', why: `${mintCount} tokens minted (multi-token collection)` }
  return { verdict: 'REVIEW', why: `${mintCount} token(s), no cover — looks like a first-mint wrapper` }
}

function evidence({ lower, curatedByLower, masterByLower, hiddenLowers, meta, counts }) {
  const curatedVariants = curatedByLower.get(lower) || []
  const mintCount = counts.get(lower) || 0
  return {
    lower,
    curatedVariants,
    inCurated: curatedVariants.length > 0,
    inMaster: masterByLower.has(lower),
    inHidden: hiddenLowers.has(lower),
    meta,
    mintCount,
    ...classify({ meta, mintCount }),
  }
}

function printRow(e) {
  const name = e.meta?.name ? `"${e.meta.name}"` : '(no meta)'
  const artist = e.meta?.artist ? ` artist=${e.meta.artist}` : ''
  const cover = e.meta?.coverTokenId ? ` cover=#${e.meta.coverTokenId}` : ''
  const hidden = e.inHidden ? ' [collection-hidden]' : ''
  const variants = e.curatedVariants.length > 1 ? ` (${e.curatedVariants.length} case-variants)` : ''
  console.log(`  ${e.verdict.padEnd(6)} ${e.lower}${variants}  ${name}${artist}${cover}  mints=${e.mintCount}${hidden}`)
  console.log(`         ↳ ${e.why}`)
}

// ---------------------------------------------------------------- main
async function main() {
  console.log('='.repeat(78))
  console.log('reconcile-curated-collections')
  console.log(`Mode  : ${COMMIT ? 'COMMIT (writing to Redis)' : 'DRY-RUN (no writes)'}`)
  console.log(`Scope : ${ADDRESSES.length ? `targeted (${ADDRESSES.length} address${ADDRESSES.length > 1 ? 'es' : ''})` : 'scan (all curated members)'}`)
  console.log('='.repeat(78))

  const [curatedByLower, masterByLower, hiddenByLower, mints] = await Promise.all([
    membersByLower(KEY_CURATED),
    membersByLower(KEY_MASTER),
    membersByLower(KEY_HIDDEN_COLLECTIONS),
    buildMintCounts(),
  ])
  const hiddenLowers = new Set(hiddenByLower.keys())
  const { counts, scanned } = mints
  console.log(`curated: ${curatedByLower.size} | master: ${masterByLower.size} | created-mints: ${scanned} members across ${counts.size} collections\n`)

  // Batch-load meta for whichever addresses we're about to report on.
  const targetLowers = ADDRESSES.length ? ADDRESSES : Array.from(curatedByLower.keys())
  const metaRaws = targetLowers.length ? await redisCmd(['MGET', ...targetLowers.map(kMeta)]) : []
  const metaByLower = new Map()
  targetLowers.forEach((lower, i) => metaByLower.set(lower, parseMeta(metaRaws[i])))

  const build = (lower) =>
    evidence({ lower, curatedByLower, masterByLower, hiddenLowers, meta: metaByLower.get(lower), counts })

  // ---------- targeted removal (operator-confirmed) ----------
  if (ADDRESSES.length) {
    let removed = 0
    for (const lower of ADDRESSES) {
      const e = build(lower)
      printRow(e)
      if (!e.inCurated) {
        console.log('         ↳ not in the curated set — nothing to remove (no-op).\n')
        continue
      }
      if (!e.inMaster) {
        console.log('         ↳ WARNING: not in the master set either — unusual; verify this address.')
      }
      if (e.verdict === 'KEEP') {
        console.log('         ↳ WARNING: this looks like a REAL collection (keep-signal present).')
        console.log('           Proceeding only because you named it explicitly.')
      }
      if (COMMIT) {
        // Remove every stored case-variant of the address from the curated set.
        await redisCmd(['SREM', KEY_CURATED, ...e.curatedVariants])
        removed++
        console.log(`         ↳ REMOVED ${e.curatedVariants.length} member(s) from curated set (master + meta untouched).\n`)
      } else {
        console.log(`         ↳ would SREM ${e.curatedVariants.length} member(s) from curated set (re-run with --commit).\n`)
      }
    }
    console.log('-'.repeat(78))
    console.log(COMMIT ? `Done. Un-curated ${removed} address(es).` : 'Dry-run complete. Re-run with --commit to apply.')
    if (COMMIT && removed > 0) {
      console.log('Note: running pods memoize the curated set for up to 15 min; surfaces self-heal after TTL.')
    }
    return
  }

  // ---------- scan / report (never auto-removes) ----------
  const rows = Array.from(curatedByLower.keys()).map(build)
  // REVIEW first, so likely-wrappers are easy to spot.
  rows.sort((a, b) => (a.verdict === b.verdict ? a.mintCount - b.mintCount : a.verdict === 'REVIEW' ? -1 : 1))
  for (const e of rows) printRow(e)

  const review = rows.filter((e) => e.verdict === 'REVIEW')
  console.log('\n' + '-'.repeat(78))
  console.log(`Summary: ${rows.length} curated, ${review.length} flagged REVIEW (likely first-mint wrappers).`)
  if (review.length) {
    console.log('\nRemove a confirmed wrapper with:')
    console.log(`  node scripts/reconcile-curated-collections.mjs --address ${review[0].lower} --commit`)
    console.log('(comma-separate multiple addresses; verdicts are advisory — confirm before removing.)')
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
