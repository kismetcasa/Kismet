#!/usr/bin/env node
/*
 * reconcile-pass-validity.mjs
 * ---------------------------------------------------------------------------
 * Repairs the "minted-but-never-credited" gap.
 *
 * A Pass buyer whose on-chain mint succeeded but whose validity (and
 * collected-list entry) was never written — because the client-driven
 * /api/collect never ran (hung waitForTransactionReceipt, POST dropped on
 * tab-close) — is left unable to mint and unable to see what they collected.
 * The webhook now closes this going forward via Fix A (`if (platform || isMint)`
 * in lib/pass-validity.ts). This script applies that same credit RETROACTIVELY
 * to mints that predate the fix, and surfaces every wallet that was affected.
 *
 * It mirrors the app's own logic exactly:
 *   - validity: claim the same per-(collection,address,tx,tokenId) credited-key
 *     the app uses, then INCRBY the valid-balance ledger + SADD known-tokens.
 *   - collected: ZADD "<collection>:<tokenId>" into the buyer's collected zset,
 *     scored by the mint's block timestamp.
 *
 * SAFE BY DEFAULT — dry-run unless --commit. IDEMPOTENT — the credited-key and
 * ZADD NX guards mean re-running (or racing the live webhook) never double-
 * credits. It never sets an admin-grant, so hasValidPass's live on-chain
 * reconciliation still clamps a credited balance down if the holder later moved
 * the Pass. Tainted tokenIds are respected (skipped) and reported with the
 * admin remedy, never silently laundered.
 *
 * Usage:
 *   node scripts/reconcile-pass-validity.mjs                       # dry-run, whole Pass collection
 *   node scripts/reconcile-pass-validity.mjs --commit              # apply repairs
 *   node scripts/reconcile-pass-validity.mjs --address 0xabc...    # scope + deep-repair one buyer
 *   node scripts/reconcile-pass-validity.mjs --address 0xabc... --commit
 *   node scripts/reconcile-pass-validity.mjs --no-collected        # validity only
 *   node scripts/reconcile-pass-validity.mjs --collection 0xdef... # override the Pass collection
 *
 * Env (same names the app reads):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   BASE_RPC_URL (or NEXT_PUBLIC_BASE_RPC_URL) — MUST be an Alchemy Base URL
 *   (uses alchemy_getAssetTransfers).
 */

const ZERO = '0x0000000000000000000000000000000000000000'
const CREDITED_TTL = 90 * 24 * 60 * 60 // matches CREDITED_TTL in lib/pass-validity.ts

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const flagVal = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const COMMIT = hasFlag('--commit')
const DO_COLLECTED = !hasFlag('--no-collected')
const ONLY_ADDRESS = (flagVal('--address') || '').toLowerCase() || null
const COLLECTION_OVERRIDE = (flagVal('--collection') || '').toLowerCase() || null

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
if (ONLY_ADDRESS && !/^0x[0-9a-f]{40}$/.test(ONLY_ADDRESS)) {
  console.error(`FATAL: --address ${ONLY_ADDRESS} is not a valid 0x-address`)
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

// key builders — mirror lib/pass-validity.ts + lib/collected.ts EXACTLY
const kValidBalance = (c, a) => `kismetart:pass:valid-balance:${c}:${a}`
const kCredited = (c, a, tx, id) => `kismetart:pass:credited:${c}:${a}:${tx}:${id}`
const kKnownTokens = (c) => `kismetart:pass:tokenids:${c}`
const kTainted = (c) => `kismetart:pass:tainted:${c}`
const kCollected = (a) => `kismetart:collected:${a}`
const collectedMember = (c, id) => `${c}:${id}`

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

// Page through alchemy_getAssetTransfers (max 1000/page). Either fromAddress
// (mint enumeration: from == 0x0) or toAddress (a buyer's acquisitions).
async function getAllTransfers({ fromAddress, toAddress, contractAddresses }) {
  const out = []
  let pageKey
  do {
    const params = {
      fromBlock: '0x0',
      toBlock: 'latest',
      category: ['erc1155', 'erc721'],
      withMetadata: true, // for blockTimestamp → collected score
      excludeZeroValue: false,
      maxCount: '0x3e8',
      order: 'asc',
    }
    if (fromAddress) params.fromAddress = fromAddress
    if (toAddress) params.toAddress = toAddress
    if (contractAddresses && contractAddresses.length) params.contractAddresses = contractAddresses
    if (pageKey) params.pageKey = pageKey
    const result = await rpc('alchemy_getAssetTransfers', [params])
    out.push(...(result.transfers || []))
    pageKey = result.pageKey
  } while (pageKey)
  return out
}

// ---------------------------------------------------------------- helpers
const hexToDec = (hex) => {
  if (hex == null) return null
  try {
    return BigInt(hex).toString()
  } catch {
    return null
  }
}
const hexToInt = (hex) => {
  if (hex == null) return 0
  try {
    return Number(BigInt(hex))
  } catch {
    return 0
  }
}
const tsToMs = (t) => {
  const ms = t?.metadata?.blockTimestamp ? Date.parse(t.metadata.blockTimestamp) : NaN
  return Number.isFinite(ms) ? ms : Date.now()
}

// Flatten a transfer list into per-token MINT records (from == 0x0).
function mintRecords(transfers, { onlyTo, onlyCollections } = {}) {
  const records = []
  for (const t of transfers) {
    if ((t.from || '').toLowerCase() !== ZERO) continue // mints only
    const to = (t.to || '').toLowerCase()
    if (!to) continue
    if (onlyTo && to !== onlyTo) continue
    const collection = (t.rawContract?.address || '').toLowerCase()
    if (!collection) continue
    if (onlyCollections && !onlyCollections.has(collection)) continue
    const txHash = (t.hash || '').toLowerCase()
    const ts = tsToMs(t)
    if (t.category === 'erc1155' && Array.isArray(t.erc1155Metadata)) {
      for (const m of t.erc1155Metadata) {
        const tokenId = hexToDec(m.tokenId)
        if (tokenId == null) continue
        records.push({ to, collection, txHash, tokenId, amount: hexToInt(m.value) || 1, ts })
      }
    } else if (t.category === 'erc721') {
      const tokenId = hexToDec(t.tokenId ?? t.erc721TokenId)
      if (tokenId == null) continue
      records.push({ to, collection, txHash, tokenId, amount: 1, ts })
    }
  }
  return records
}

// ---------------------------------------------------------------- main
async function main() {
  const passCollection =
    COLLECTION_OVERRIDE ||
    (await redisCmd(['GET', 'kismetart:gate:pass-collection']).then((v) =>
      typeof v === 'string' ? v.toLowerCase() : null,
    ))
  if (!passCollection) {
    console.error('FATAL: no Pass collection configured (kismetart:gate:pass-collection empty) and no --collection override')
    process.exit(1)
  }

  console.log('='.repeat(72))
  console.log(`Pass collection : ${passCollection}`)
  console.log(`Mode            : ${COMMIT ? 'COMMIT (writing to Redis)' : 'DRY-RUN (no writes)'}`)
  console.log(`Collected repair: ${DO_COLLECTED ? 'on' : 'off'}`)
  if (ONLY_ADDRESS) console.log(`Scoped address  : ${ONLY_ADDRESS}`)
  console.log('='.repeat(72))

  const blacklist = new Set(
    ((await redisCmd(['SMEMBERS', 'kismetart:pass-blacklist'])) || []).map((s) => String(s).toLowerCase()),
  )
  const tainted = new Set(((await redisCmd(['SMEMBERS', kTainted(passCollection)])) || []).map(String))

  // ---- enumerate mints -----------------------------------------------------
  // Deep single-address repair: pull every mint TO that address across all
  // Kismet collections (validity for the Pass ones, collected for all).
  // Collection-wide: pull every mint of the Pass collection.
  let mints
  let kismetCollections = null
  if (ONLY_ADDRESS) {
    // "Kismet collections" for the collected backfill = the MASTER tracked set
    // (kismetart:collections), the exact set the timeline fan-out uses — NOT
    // kismetart:created-collections, which is only the curated Create-Collection
    // subset. The master set includes every registered contract AND the shared
    // PLATFORM_COLLECTION where all standalone mints land, so it captures the
    // artworks a buyer collected outside a curated collection — precisely the
    // "can't see collected" symptom. Filtering to Kismet collections (rather
    // than every 1155/721 the wallet ever received) keeps non-Kismet NFTs out
    // of the collected zset, whose members drive the Collected tab's fan-out.
    const platformCollection = (
      process.env.NEXT_PUBLIC_PLATFORM_COLLECTION ||
      '0x349D3DA472BDD2FBeebf8e0bBAF4220160A62526'
    ).toLowerCase()
    kismetCollections = new Set(
      ((await redisCmd(['SMEMBERS', 'kismetart:collections'])) || []).map((s) => String(s).toLowerCase()),
    )
    kismetCollections.add(platformCollection)
    kismetCollections.add(passCollection)
    const transfers = await getAllTransfers({ toAddress: ONLY_ADDRESS })
    mints = mintRecords(transfers, { onlyTo: ONLY_ADDRESS, onlyCollections: kismetCollections })
  } else {
    const transfers = await getAllTransfers({ fromAddress: ZERO, contractAddresses: [passCollection] })
    mints = mintRecords(transfers)
  }

  const passMints = mints.filter((m) => m.collection === passCollection)
  console.log(`\nScanned ${mints.length} Kismet mint(s); ${passMints.length} into the Pass collection.\n`)

  // ---- validity gaps (Pass only) ------------------------------------------
  // A gap = an uncredited Pass mint. Batch the credited-key reads.
  const eligible = passMints.filter((m) => {
    if (blacklist.has(m.to)) return false
    if (tainted.has(m.tokenId)) return false
    return true
  })
  const taintBlocked = passMints.filter((m) => tainted.has(m.tokenId) && !blacklist.has(m.to))

  const creditedFlags = await redisPipeline(
    eligible.map((m) => ['GET', kCredited(passCollection, m.to, m.txHash, m.tokenId)]),
  )
  const gaps = eligible.filter((_, i) => !creditedFlags[i])

  // group gaps by address
  const byAddr = new Map()
  for (const g of gaps) {
    if (!byAddr.has(g.to)) byAddr.set(g.to, [])
    byAddr.get(g.to).push(g)
  }

  console.log(`VALIDITY — ${gaps.length} uncredited Pass mint(s) across ${byAddr.size} wallet(s):`)
  if (gaps.length === 0) console.log('  (none — every Pass mint already credited)')
  for (const [addr, gs] of byAddr) {
    const bal = await redisCmd(['GET', kValidBalance(passCollection, addr)])
    const total = gs.reduce((n, g) => n + g.amount, 0)
    console.log(`  ${addr}  ledger=${bal ?? 0}  missing +${total}  (tokens: ${gs.map((g) => `#${g.tokenId}×${g.amount}`).join(', ')})`)
    for (const g of gs) console.log(`      tx ${g.txHash}`)
  }
  if (taintBlocked.length > 0) {
    console.log(`\n  ⚠ ${taintBlocked.length} mint(s) skipped — tokenId is TAINTED. If these are legitimate current`)
    console.log('    holders, remedy is an admin override (setValidBalance) or removeTaint, not this script:')
    for (const t of taintBlocked) console.log(`      ${t.to}  tokenId #${t.tokenId}  tx ${t.txHash}`)
  }

  // ---- collected gaps ------------------------------------------------------
  // Collection-wide: repair only the Pass into each affected wallet's list.
  // Single-address: repair EVERY Kismet mint TO that wallet (the artworks too).
  const collectedTargets = ONLY_ADDRESS ? mints : gaps
  let collectedMissing = []
  if (DO_COLLECTED && collectedTargets.length > 0) {
    const scores = await redisPipeline(
      collectedTargets.map((m) => ['ZSCORE', kCollected(m.to), collectedMember(m.collection, m.tokenId)]),
    )
    collectedMissing = collectedTargets.filter((_, i) => scores[i] == null)
    console.log(`\nCOLLECTED — ${collectedMissing.length} missing entr(y/ies)${ONLY_ADDRESS ? ` for ${ONLY_ADDRESS}` : ' (Pass) across affected wallets'}:`)
    for (const m of collectedMissing) console.log(`  ${m.to}  ${m.collection}:#${m.tokenId}`)
    if (collectedMissing.length === 0) console.log('  (none)')
  }

  // ---- commit --------------------------------------------------------------
  if (!COMMIT) {
    console.log('\nDRY-RUN complete. Re-run with --commit to apply the repairs above.')
    return
  }

  console.log('\nApplying repairs…')
  let creditsApplied = 0
  let creditsRaced = 0
  for (const g of gaps) {
    // Same claim the webhook/collect use: SET NX. If the live webhook credited
    // in the meantime, the claim fails and we skip — never double-credit.
    const claimed = await redisCmd([
      'SET', kCredited(passCollection, g.to, g.txHash, g.tokenId), '1', 'NX', 'EX', String(CREDITED_TTL),
    ])
    if (claimed !== 'OK') {
      creditsRaced++
      continue
    }
    await redisPipeline([
      ['INCRBY', kValidBalance(passCollection, g.to), String(g.amount)],
      ['SADD', kKnownTokens(passCollection), g.tokenId],
    ])
    creditsApplied++
  }

  let collectedApplied = 0
  if (DO_COLLECTED && collectedMissing.length > 0) {
    // ZADD NX: add the member only if absent, so a re-run never rewrites a
    // score the live app may have set more accurately.
    const results = await redisPipeline(
      collectedMissing.map((m) => [
        'ZADD', kCollected(m.to), 'NX', String(m.ts), collectedMember(m.collection, m.tokenId),
      ]),
    )
    collectedApplied = results.filter((r) => Number(r) > 0).length
  }

  console.log('\n' + '='.repeat(72))
  console.log(`Validity credits applied : ${creditsApplied}${creditsRaced ? ` (${creditsRaced} already credited by the live webhook — skipped)` : ''}`)
  console.log(`Collected entries added  : ${collectedApplied}`)
  console.log('Note: no admin-grant was set, so hasValidPass live-reconciles each balance against on-chain holdings on next access.')
  console.log('='.repeat(72))
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
