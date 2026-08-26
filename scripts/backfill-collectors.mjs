#!/usr/bin/env node
/*
 * backfill-collectors.mjs
 * ---------------------------------------------------------------------------
 * One-shot backfill of the per-artwork collector audience index
 * (kismetart:collectors:<collection>:<tokenId> + kismetart:cfile-refs:<addr>)
 * for artworks minted BEFORE the collector-file feature shipped — the index
 * is event-sourced from its mirror-write sites (collect / airdrop / listing
 * fill / Pass webhook) and knows nothing about history
 * (COLLECTOR_DOWNLOADS_DESIGN.md §6.1).
 *
 * Run it PER ARTWORK, on demand, when an artist first attaches a file to a
 * pre-feature artwork (not globally — the index only matters where a file
 * exists). It records every wallet that ever RECEIVED ≥1 unit of the token
 * (TransferSingle AND TransferBatch, any direction of acquisition — mint,
 * secondary, wallet-to-wallet), scored by first-seen block timestamp. The
 * fanout filters CURRENT holders live at notify time, so over-inclusion here
 * costs nothing; omission would silently skip real collectors.
 *
 * SAFE BY DEFAULT — dry-run unless --commit. IDEMPOTENT — ZADD NX + SADD.
 *
 * Usage:
 *   node scripts/backfill-collectors.mjs --collection 0xabc... --token-id 7
 *   node scripts/backfill-collectors.mjs --collection 0xabc... --token-id 7 --commit
 *
 * Env (same names the app reads):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   BASE_RPC_URL (or NEXT_PUBLIC_BASE_RPC_URL) — MUST be an Alchemy Base URL
 *   (uses alchemy_getAssetTransfers, like reconcile-pass-validity.mjs).
 */

const ZERO = '0x0000000000000000000000000000000000000000'

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const flagVal = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const COMMIT = hasFlag('--commit')
const COLLECTION = (flagVal('--collection') || '').toLowerCase()
const RAW_TOKEN_ID = flagVal('--token-id') || ''

// ---------------------------------------------------------------- env
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const RPC_URL = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL

if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('FATAL: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set')
  process.exit(1)
}
if (!RPC_URL) {
  console.error('FATAL: BASE_RPC_URL / NEXT_PUBLIC_BASE_RPC_URL not set (needs an Alchemy Base URL)')
  process.exit(1)
}
if (!/^0x[0-9a-f]{40}$/.test(COLLECTION)) {
  console.error(`FATAL: --collection ${COLLECTION || '(missing)'} is not a valid 0x-address`)
  process.exit(1)
}
if (!/^\d+$/.test(RAW_TOKEN_ID)) {
  console.error(`FATAL: --token-id ${RAW_TOKEN_ID || '(missing)'} is not a decimal tokenId`)
  process.exit(1)
}
// Canonical minimal-decimal form — the same rule every runtime key applies.
const TOKEN_ID = BigInt(RAW_TOKEN_ID).toString()
const REF = `${COLLECTION}:${TOKEN_ID}`

// ---------------------------------------------------------------- Upstash REST
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

// key builders — mirror lib/collectorFile.ts EXACTLY
const kCollectors = `kismetart:collectors:${REF}`
const kRefs = (a) => `kismetart:cfile-refs:${a}`

// ---------------------------------------------------------------- RPC
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
  return j.result
}

// Page through alchemy_getAssetTransfers for this contract. erc1155 entries
// carry erc1155Metadata: [{ tokenId (hex), value }] — TransferBatch arrives
// as multiple entries in that array, so iterating it covers batch transfers.
async function getAllTransfers() {
  const out = []
  let pageKey
  do {
    const params = {
      fromBlock: '0x0',
      toBlock: 'latest',
      category: ['erc1155'],
      contractAddresses: [COLLECTION],
      withMetadata: true, // blockTimestamp → first-seen score
      excludeZeroValue: false,
      maxCount: '0x3e8',
      order: 'asc',
    }
    if (pageKey) params.pageKey = pageKey
    const result = await rpc('alchemy_getAssetTransfers', [params])
    out.push(...(result.transfers || []))
    pageKey = result.pageKey
  } while (pageKey)
  return out
}

// ---------------------------------------------------------------- main
const transfers = await getAllTransfers()

/** addr -> first-seen ms (asc transfer order makes first write the earliest). */
const firstSeen = new Map()
let matchedEvents = 0
for (const t of transfers) {
  const to = (t.to || '').toLowerCase()
  if (!to || to === ZERO) continue
  const metas = t.erc1155Metadata || []
  for (const m of metas) {
    let id
    try {
      id = BigInt(m.tokenId).toString()
    } catch {
      continue
    }
    if (id !== TOKEN_ID) continue
    let units = 0
    try {
      units = Number(BigInt(m.value))
    } catch {
      units = 0
    }
    if (units <= 0) continue
    matchedEvents++
    if (!firstSeen.has(to)) {
      const ts = Date.parse(t.metadata?.blockTimestamp || '') || Date.now()
      firstSeen.set(to, ts)
    }
  }
}

console.log(
  `${COLLECTION} token ${TOKEN_ID}: ${transfers.length} contract transfers scanned, ` +
    `${matchedEvents} matching receipt events, ${firstSeen.size} distinct recipients`,
)

if (firstSeen.size === 0) process.exit(0)

if (!COMMIT) {
  for (const [addr, ts] of firstSeen) {
    console.log(`  would record ${addr} (first seen ${new Date(ts).toISOString()})`)
  }
  console.log('\nDry run — re-run with --commit to write.')
  process.exit(0)
}

const cmds = []
for (const [addr, ts] of firstSeen) {
  cmds.push(['ZADD', kCollectors, 'NX', String(ts), addr])
  cmds.push(['SADD', kRefs(addr), REF])
}
// Chunked pipelines — each command is tiny; 400/chunk stays far under the
// 10 MB request cap and keeps a failed chunk's blast radius small.
for (let i = 0; i < cmds.length; i += 400) {
  await redisPipeline(cmds.slice(i, i + 400))
}
console.log(`Recorded ${firstSeen.size} collectors into ${kCollectors} (+ per-address refs).`)
