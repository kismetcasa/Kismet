#!/usr/bin/env node
/*
 * diagnose-collect-notification.mjs
 * ---------------------------------------------------------------------------
 * Answers one question, from primary sources: "a collect shows in the artwork's
 * ACTIVITY list (and in the artist's sales figures) — why is there no bell
 * notification for it?"
 *
 * It exists because those surfaces have DIFFERENT sources of truth, and the UI
 * gives no hint of the split:
 *
 *   activity list  -> In Process /comments feed   (on-chain, frontend-agnostic)
 *   sales / $ card -> In Process /transfers feed  (on-chain, frontend-agnostic)
 *   bell + FC push -> POST /api/collect           (Kismet's own client ONLY)
 *   collected list -> POST /api/collect           (same; event-sourced)
 *   trending       -> POST /api/collect           (same)
 *
 * PRIMARY MINTS ONLY. Secondary sales are a different path with its own
 * source of truth: a Kismet listing is retired against Seaport's own
 * getOrderStatus (lib/listings resolveTerminalStatuses), so an off-platform
 * FILL is announced correctly and needs no diagnosis here.
 *
 * So a mint that never went through Kismet's client — or whose best-effort
 * `/api/collect` POST was lost — is fully visible in activity and stats and
 * fully absent from the bell. Nothing reconciles the two: the only webhook is
 * Pass-validity-scoped and writes no notifications (app/api/webhooks/
 * pass-transfer), and no cron backfills notifications.
 *
 * For every on-chain mint of one token this reports, per mint:
 *   1. Kismet's attribution on the tx calldata — the mint referral first
 *      (an ABI argument on every mint Kismet issues), then the ERC-8021
 *      builder code — did the mint originate in Kismet's client at all?
 *   2. the /api/collect idempotency key — did the recording endpoint ever
 *      complete for this mint? (30-day retention; older mints read "unknown")
 *   3. a matching entry in the artist's notification ZSET
 *   4. every suppression or retention rule that could have eaten it — ordered
 *      by EVIDENCE STRENGTH, not by the order lib/notifications.ts applies
 *      them: a definitive absent-idempotency-key result is tested before the
 *      retention heuristics (EXPIRED/EVICTED/COALESCED), which only qualify a
 *      mint the endpoint provably recorded
 * and prints a verdict naming the exact stage that dropped it.
 *
 * ORIGIN IS DECIDED ON-CHAIN, NOT ON THE COMMENT. The activity row's wording is
 * not evidence either way: isPlatformCollectComment('') is TRUE, so an EMPTY
 * on-chain comment renders as the literal "collected on kismet" — and empty is
 * produced BOTH by non-Kismet mints AND by Kismet's own agent paths, which pass
 * comment: '' (lib/agent/scout/dropCoordinator.ts, serverExecutor.ts, and the
 * prepare-collect routes' default). Only the interactive browser paths always
 * stamp a non-empty comment. Hence the two calldata fingerprints below.
 *
 * READ-ONLY. Writes nothing, to Redis or chain.
 *
 * Usage:
 *   node scripts/diagnose-collect-notification.mjs --collection 0xabc… --token-id 7
 *   node scripts/diagnose-collect-notification.mjs --collection 0xabc… --token-id 7 --artist 0xdef…
 *   node scripts/diagnose-collect-notification.mjs --collection 0xabc… --token-id 7 --collector 0x123…
 *   … --json      # machine-readable report
 *
 * Env (same names the app reads):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   BASE_RPC_URL (or NEXT_PUBLIC_BASE_RPC_URL) — MUST be an Alchemy Base URL
 *   (uses alchemy_getAssetTransfers, like reconcile-pass-validity.mjs).
 *   NEXT_PUBLIC_BUILDER_CODE — optional; defaults to Kismet's published code.
 */

const ZERO = '0x0000000000000000000000000000000000000000'

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const flagVal = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const JSON_OUT = hasFlag('--json')
const COLLECTION = (flagVal('--collection') || '').toLowerCase()
const RAW_TOKEN_ID = flagVal('--token-id') || ''
const ARTIST_ARG = (flagVal('--artist') || '').toLowerCase()
const COLLECTOR_ARG = (flagVal('--collector') || '').toLowerCase()

// ---------------------------------------------------------------- env
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const RPC_URL = process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL

const die = (msg) => {
  console.error(`FATAL: ${msg}`)
  process.exit(1)
}

if (!REDIS_URL || !REDIS_TOKEN) die('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set')
if (!RPC_URL) die('BASE_RPC_URL / NEXT_PUBLIC_BASE_RPC_URL not set (needs an Alchemy Base URL)')
if (!/^0x[0-9a-f]{40}$/.test(COLLECTION)) die(`--collection ${COLLECTION || '(missing)'} is not a valid 0x-address`)
if (!/^\d+$/.test(RAW_TOKEN_ID)) die(`--token-id ${RAW_TOKEN_ID || '(missing)'} is not a decimal tokenId`)
if (ARTIST_ARG && !/^0x[0-9a-f]{40}$/.test(ARTIST_ARG)) die(`--artist ${ARTIST_ARG} is not a valid 0x-address`)
if (COLLECTOR_ARG && !/^0x[0-9a-f]{40}$/.test(COLLECTOR_ARG)) die(`--collector ${COLLECTOR_ARG} is not a valid 0x-address`)

// Canonical minimal-decimal form — the same rule /api/collect applies before
// building any Redis key (leading zeros would miss every key otherwise).
const TOKEN_ID = BigInt(RAW_TOKEN_ID).toString()
const REF = `${COLLECTION}:${TOKEN_ID}`

// ---------------------------------------------------- constants mirrored from app
// Keep these in sync with their source of truth; each cite is the file that owns it.
const MAX_PER_USER = 200                       // lib/notifications.ts
const NOTIF_TTL_SECONDS = 60 * 24 * 60 * 60    // lib/notifications.ts (60 days)
const BURST_DEDUP_WINDOW_SECS = 60             // lib/notifications.ts
const IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 60 * 60 // app/api/collect/route.ts (30 days)
const ERC8021_MARKER = '80218021802180218021802180218021' // lib/builderCode.ts

/** Kismet's mint-referral recipient (lib/zoraMint.ts KISMET_REFERRAL). This is
 *  the STRONGER of the two origin fingerprints: buildEthMintCall pins it as
 *  `rewardsRecipients[0]` and buildUsdcMintCall as `mintReferral`, so it is an
 *  ABI ARGUMENT on every mint Kismet issues — web, collect-all, and agent alike.
 *  The builder-code suffix below can legitimately go missing (on the EIP-5792
 *  path it rides as an `optional: true` wallet capability, which a wallet may
 *  drop); the referral cannot, because Zora pays the mint-referral reward to it.
 *  Matched as a substring of the calldata, where it appears zero-padded to a
 *  32-byte word in both encodings. */
const KISMET_REFERRAL = '0xc6021d9f09e145a6297f64551aa2eca6d66f8f75'

/** ERC-8021 schema-0 suffix, byte-identical to lib/builderCode.ts's encoding:
 *  [code ASCII] ∥ [1-byte length] ∥ [schema 0x00] ∥ [16-byte marker]. */
function builderSuffix() {
  const code = process.env.NEXT_PUBLIC_BUILDER_CODE?.trim() || 'bc_p876wb1c'
  const codeHex = Buffer.from(code, 'utf8').toString('hex')
  const len = (codeHex.length / 2).toString(16).padStart(2, '0')
  return `${codeHex}${len}00${ERC8021_MARKER}`.toLowerCase()
}
const BUILDER_SUFFIX = builderSuffix()

// ---------------------------------------------------------------- Upstash REST
async function redisPipeline(cmds) {
  if (cmds.length === 0) return []
  let res
  try {
    res = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    })
  } catch (err) {
    die(`could not reach Upstash at ${REDIS_URL} — ${err.message}`)
  }
  if (!res.ok) die(`redis pipeline ${res.status}: ${await res.text()}`)
  return (await res.json()).map((x) => x.result)
}

// key builders — mirror lib/notifications.ts + app/api/collect/route.ts EXACTLY
const kNotif = (a) => `kismetart:notif:${a}`
const kMuted = (a) => `kismetart:notif-muted:${a}`
const kMutedTypes = (a) => `kismetart:notif-muted-types:${a}`
const kMomentMeta = `kismetart:moment-meta:${COLLECTION}:${TOKEN_ID}`
const kCollected = (a) => `kismetart:collected:${a}`
const kIdem = (tx, account) => `kismetart:collect-idem:${tx}:${COLLECTION}:${TOKEN_ID}:${account}`

/** Upstash JSON-parses stored values on read, so a member can come back as a
 *  string OR an already-parsed object — the same dual shape loadAndAnnotate
 *  handles. Returns null on anything unparseable. */
const parseMaybe = (raw) => {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- RPC
async function rpc(method, params) {
  let res
  try {
    res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  } catch (err) {
    die(`could not reach the Base RPC — ${err.message}`)
  }
  if (!res.ok) die(`RPC ${method} returned ${res.status}: ${await res.text()}`)
  const j = await res.json()
  // alchemy_getAssetTransfers is Alchemy-only; a non-Alchemy URL fails here
  // with "method not found" rather than anything about the diagnosis.
  if (j.error) die(`${method}: ${JSON.stringify(j.error)}`)
  return j.result
}

/** Every MINT of this collection: alchemy_getAssetTransfers from the zero
 *  address. erc1155Metadata carries [{tokenId, value}] — TransferBatch arrives
 *  as several entries in that array, so iterating it covers batch mints too. */
async function getMints() {
  const out = []
  let pageKey
  do {
    const params = {
      fromBlock: '0x0',
      toBlock: 'latest',
      category: ['erc1155'],
      contractAddresses: [COLLECTION],
      fromAddress: ZERO,
      withMetadata: true,
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

// ---------------------------------------------------------------- gather: chain
const rawMints = await getMints()

/** One row per (tx, recipient) mint of THIS token, oldest first. */
const mints = []
for (const t of rawMints) {
  const to = (t.to || '').toLowerCase()
  if (!to || to === ZERO) continue
  let units = 0
  for (const m of t.erc1155Metadata || []) {
    let id
    try {
      id = BigInt(m.tokenId).toString()
    } catch {
      continue
    }
    if (id !== TOKEN_ID) continue
    try {
      units += Number(BigInt(m.value))
    } catch {
      /* a malformed value contributes nothing */
    }
  }
  if (units <= 0) continue
  const tsMs = Date.parse(t.metadata?.blockTimestamp || '') || 0
  mints.push({
    txHash: (t.hash || '').toLowerCase(),
    collector: to,
    // Carried so burstSibling can exclude a mint from matching ITSELF in the
    // collection-wide list. Without it the comparison was '7' === undefined,
    // the exclusion never fired, and LOST/UNKNOWN were unreachable.
    tokenId: TOKEN_ID,
    units,
    tsMs,
    tsSec: Math.floor(tsMs / 1000),
  })
}

/** Every mint in the COLLECTION, not just this token — the burst-dedup lock is
 *  keyed (recipient, actor, collection) with no tokenId, so detecting
 *  coalescing needs the wider set. */
const collectionMints = []
for (const t of rawMints) {
  const to = (t.to || '').toLowerCase()
  if (!to || to === ZERO) continue
  const tsMs = Date.parse(t.metadata?.blockTimestamp || '') || 0
  for (const meta of t.erc1155Metadata || []) {
    let id
    try {
      id = BigInt(meta.tokenId).toString()
    } catch {
      continue
    }
    collectionMints.push({
      txHash: (t.hash || '').toLowerCase(),
      collector: to,
      tokenId: id,
      tsSec: Math.floor(tsMs / 1000),
    })
  }
}

if (mints.length === 0) {
  console.error(`No on-chain mints found for ${REF}. Nothing to diagnose.`)
  process.exit(0)
}

// Builder-code stamp + payer, per distinct tx. Kismet appends the ERC-8021
// suffix to every mint it signs (lib/builderCode.ts), so its PRESENCE proves
// the mint originated in Kismet's client. Its ABSENCE is strong but not
// conclusive: the EIP-5792 path carries attribution as an `optional: true`
// wallet capability, so a wallet that ignores the capability produces an
// unstamped Kismet mint.
const txCache = new Map()
for (const tx of new Set(mints.map((m) => m.txHash))) {
  if (!tx) continue
  try {
    const t = await rpc('eth_getTransactionByHash', [tx])
    const input = (t?.input || '').toLowerCase()
    // No tx, or no calldata to read, is UNKNOWN — never "not Kismet". A pruned
    // node, a reorged hash or an RPC pointed at the wrong chain all land here,
    // and reporting absence of attribution as proof of foreign origin is the
    // one wrong answer this script must not give.
    if (!t || !input || input === '0x') {
      txCache.set(tx, { stamped: null, referral: null, from: (t?.from || '').toLowerCase() })
    } else {
      txCache.set(tx, {
        stamped: input.endsWith(BUILDER_SUFFIX),
        referral: input.includes(KISMET_REFERRAL.slice(2)),
        from: (t?.from || '').toLowerCase(),
      })
    }
  } catch {
    txCache.set(tx, { stamped: null, referral: null, from: '' })
  }
}

// ---------------------------------------------------------------- gather: Redis
const [metaRaw] = await redisPipeline([['GET', kMomentMeta]])
const meta = parseMaybe(metaRaw)
const metaCreator = (meta?.creator || '').toLowerCase()
const artist = ARTIST_ARG || metaCreator

if (!artist) {
  console.error(
    `No --artist given and no moment-meta at ${kMomentMeta} to derive one from.\n` +
      `That absence is itself a finding: /api/collect returns at its \`if (!meta) return\`\n` +
      `gate, so NO collect of this artwork can ever produce a notification.`,
  )
  process.exit(1)
}

// Airdropped editions are minted from 0x0 exactly like a collect, but they are
// recorded by /api/airdrop/notify — which writes type:'airdrop' to the
// RECIPIENT and never touches kismetart:collect-idem or the artist's collect
// inbox. Without this set every airdrop reads as a lost collect POST.
const kAirdropsByMoment = `kismetart:airdrops:moment:${COLLECTION}:${TOKEN_ID}`
const idemCmds = mints.map((m) => ['GET', kIdem(m.txHash, m.collector)])
const [notifRaw, mutedRaw, mutedTypesRaw, airdropRaw, ...idemResults] = await redisPipeline([
  ['ZRANGE', kNotif(artist), '0', '-1'],
  ['SMEMBERS', kMuted(artist)],
  ['SMEMBERS', kMutedTypes(artist)],
  ['ZRANGE', kAirdropsByMoment, '0', '-1'],
  ...idemCmds,
])

const notifs = (notifRaw || []).map(parseMaybe).filter(Boolean)
// Keyed on the airdrop's OWN txHash, not on the recipient: an address that was
// airdropped this artwork once may well buy another edition later, and keying
// on the address swallowed that paid collect as "nothing is missing".
const airdropTxs = new Set(
  (airdropRaw || [])
    .map(parseMaybe)
    .filter(Boolean)
    .map((a) => String(a?.txHash ?? '').toLowerCase())
    .filter(Boolean),
)
const mutedActors = new Set((mutedRaw || []).map((a) => String(a).toLowerCase()))
const mutedTypes = new Set((mutedTypesRaw || []).map(String))
const idemByIdx = idemResults.map((r) => r != null)

// Corroborating signal: the collector's own "collected" list shares /api/collect
// as its ONLY writer, so it is missing in exactly the same cases as the bell.
const collectorList = await redisPipeline(
  [...new Set(mints.map((m) => m.collector))].map((a) => ['ZSCORE', kCollected(a), REF]),
)
const collectors = [...new Set(mints.map((m) => m.collector))]
const inCollectedList = new Map(collectors.map((a, i) => [a, collectorList[i] != null]))

// Oldest surviving notification — the eviction horizon for the 200-entry cap.
const oldestNotifTs = notifs.length ? Math.min(...notifs.map((n) => Number(n.timestamp) || 0)) : 0
const atCap = notifs.length >= MAX_PER_USER
const nowSec = Math.floor(Date.now() / 1000)

/** The notification /api/collect would have written for this mint, if any.
 *  Matched on the tuple writeNotification persists — actor + token — not on
 *  timestamp, which drifts from block time by the after() delay. */
function findNotif(m) {
  // The actor is "whoever bought the edition from the creator's point of view"
  // — app/api/collect writes `actor: giftedBy ?? account`. On a COLLECT-AND-GIFT
  // those differ: the notification names the payer while the on-chain transfer
  // names the recipient. Matching only the recipient reported a correctly
  // delivered gift as LOST. The payer match is corroborating, not
  // authoritative: on a 4337 path receipt.from is the bundler.
  const payer = (txCache.get(m.txHash) || {}).from || ''
  return notifs.find(
    (n) =>
      n.type === 'collect' &&
      (n.tokenAddress || '').toLowerCase() === COLLECTION &&
      String(n.tokenId) === TOKEN_ID &&
      ((n.actor || '').toLowerCase() === m.collector ||
        (!!payer && (n.actor || '').toLowerCase() === payer)),
  )
}

/** Did another mint by the same collector, in the same collection, land inside
 *  the 60s burst-dedup window before this one? That lock key carries no
 *  tokenId (lib/notifications.ts), so a collect-all across several artworks in
 *  ONE collection legitimately yields exactly one notification. */
function burstSibling(m) {
  // Searches the COLLECTION-wide list, not the token-filtered one. The lock key
  // carries no tokenId, so the case that actually coalesces is a collector
  // taking several DIFFERENT artworks from one collection inside 60s — which a
  // token-filtered search can never see. `<=` because a bundled collect-all
  // lands every mint in one block, hence one identical timestamp.
  return collectionMints.find(
    (o) =>
      !(o.txHash === m.txHash && o.tokenId === m.tokenId) &&
      o.collector === m.collector &&
      o.tsSec <= m.tsSec &&
      m.tsSec - o.tsSec < BURST_DEDUP_WINDOW_SECS,
  )
}

// ---------------------------------------------------------------- verdicts
const rows = mints.map((m, i) => {
  const tx = txCache.get(m.txHash) || { stamped: null, referral: null, from: '' }
  // Kismet origin, strongest signal first. The referral is an ABI argument on
  // every Kismet mint; the builder suffix is trailing calldata that the
  // EIP-5792 path may legitimately omit. Either one present ⇒ Kismet-issued.
  const kismetOrigin = tx.referral === true || tx.stamped === true
    ? true
    : tx.referral === null && tx.stamped === null
      ? null
      : false
  const notif = findNotif(m)
  const idem = idemByIdx[i]
  const ageSec = nowSec - m.tsSec
  const idemExpired = ageSec > IDEMPOTENCY_TTL_SECONDS

  let status, reason
  // Muting is evaluated on the NOTIFICATION's actor, exactly as
  // loadAndAnnotate does — not on the on-chain recipient. On a gift those are
  // different wallets, so the recipient test produced both false OKs and
  // fabricated HIDDENs.
  if (notif && mutedActors.has((notif.actor || '').toLowerCase())) {
    status = 'HIDDEN'
    reason =
      `written, but ${m.collector} is in the artist's muted-actor set and 'collect' is not ` +
      `actor-mute-exempt — loadAndAnnotate drops it at READ time, so it exists in Redis and ` +
      `never renders.`
  } else if (notif) {
    status = 'OK'
    reason = `notification ${notif.id} present (${new Date(Number(notif.timestamp) * 1000).toISOString()}).`
  } else if (!meta) {
    status = 'MISSING'
    reason = `no moment-meta at ${kMomentMeta} — /api/collect returns at its \`if (!meta) return\` gate before writing.`
  } else if (metaCreator && metaCreator !== artist) {
    status = 'MISROUTED'
    reason = `moment-meta creator is ${metaCreator}, so the notification was written to THAT inbox, not ${artist}.`
  } else if (m.collector === artist) {
    status = 'BY DESIGN'
    reason = `self-collect — writeNotification suppresses actor === recipient.`
  } else if (mutedTypes.has('collect')) {
    status = 'MUTED'
    reason = `the artist has muted the 'collect' type — suppressed at WRITE time, never stored.`
  } else if (airdropTxs.has(m.txHash)) {
    status = 'AIRDROP'
    reason =
      `this edition was AIRDROPPED to ${m.collector}, not collected — /api/airdrop/notify records it ` +
      `(type:'airdrop' to the recipient) and never writes a collect notification or a collect-idem key. ` +
      `Nothing is missing.`
  } else if (!idem && !idemExpired) {
    // Tested BEFORE the retention rules: those explain why a notification that
    // WAS written is gone, and are silent about one that was never attempted.
    // Below the cap check, a prolific artist's never-recorded mint read as a
    // benign eviction and landed in the accounted-for bucket.
    status = 'MISSING'
    reason =
      `/api/collect NEVER completed for this mint (no idempotency key, and the mint is inside the ` +
      `${IDEMPOTENCY_TTL_SECONDS / 86400}d key retention, so the absence is definitive). ` +
      (kismetOrigin === true
        ? `The tx DOES carry Kismet's attribution (${tx.referral ? 'mint referral' : ''}${tx.referral && tx.stamped ? ' + ' : ''}${tx.stamped ? 'builder code' : ''}), ` +
          `so the mint was issued by Kismet and the best-effort recording POST was lost — tab closed ` +
          `mid-flight (only useDirectCollect sends keepalive), or the retries were exhausted against a ` +
          `lagging server RPC (useCollectAll does not retry at all).`
        : kismetOrigin === false
          ? `The tx carries NEITHER Kismet's mint referral NOR its builder code — this mint was not ` +
            `issued by Kismet, so nothing ever called /api/collect. Nothing backfills it, which is why ` +
            `the sale still counts in the artist's stats (those are read from the chain) while no ` +
            `notification exists.`
          : `The tx could not be fetched, so origin is undetermined.`)
  } else if (!idem) {
    // Reached only when the key has aged out (the definitive case above already
    // returned). Every arm below therefore HAS the key, which is what lets them
    // say "/api/collect ran" without overstating.
    status = 'UNKNOWN'
    reason =
      `no notification, and the mint is older than the ${IDEMPOTENCY_TTL_SECONDS / 86400}d idempotency-key ` +
      `retention, so whether /api/collect ever ran can no longer be established. NOT an explanation — ` +
      `the evidence is simply gone.`
  } else if (ageSec > NOTIF_TTL_SECONDS) {
    status = 'EXPIRED'
    reason = `/api/collect ran, but the mint is ${Math.floor(ageSec / 86400)}d old — past the ${NOTIF_TTL_SECONDS / 86400}d retention, so any entry was dropped by the lazy ZREMRANGEBYSCORE.`
  } else if (atCap && m.tsSec < oldestNotifTs) {
    status = 'EVICTED'
    reason = `/api/collect ran, and the inbox is at the ${MAX_PER_USER}-entry cap with this mint predating the oldest surviving entry — consistent with eviction.`
  } else if (burstSibling(m)) {
    const sib = burstSibling(m)
    status = 'COALESCED'
    reason =
      `the same collector also minted token ${sib.tokenId} of this collection ` +
      `${m.tsSec - sib.tsSec}s earlier (tx ${sib.txHash}); the burst-dedup lock is keyed ` +
      `(recipient, actor, collection) with NO tokenId, so this mint was folded into that ` +
      `one notification.`
  } else {
    status = 'LOST'
    reason =
      `/api/collect DID complete (idempotency key present) but no notification exists — the write ` +
      `was lost inside the after() block, downstream of the key that now makes every retry a no-op.`
  }

  return {
    txHash: m.txHash,
    collector: m.collector,
    units: m.units,
    at: m.tsMs ? new Date(m.tsMs).toISOString() : null,
    kismetOrigin,
    kismetMintReferral: tx.referral,
    kismetBuilderCode: tx.stamped,
    payer: tx.from,
    collectRecorded: idem,
    inCollectedList: inCollectedList.get(m.collector) ?? false,
    notificationId: notif?.id ?? null,
    status,
    reason,
  }
})

const scope = COLLECTOR_ARG ? rows.filter((r) => r.collector === COLLECTOR_ARG) : rows

// ---------------------------------------------------------------- report
if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        ref: REF,
        artist,
        momentMeta: meta ?? null,
        artistNotifications: notifs.length,
        atCap,
        mutedActors: [...mutedActors],
        mutedTypes: [...mutedTypes],
        builderSuffix: `0x${BUILDER_SUFFIX}`,
        mints: scope,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const label = (s) =>
  ({
    OK: '  ok      ',
    MISSING: '  MISSING ',
    LOST: '  LOST    ',
    HIDDEN: '  HIDDEN  ',
    MUTED: '  MUTED   ',
    AIRDROP: '  airdrop ',
    COALESCED: '  COALESCD',
    EVICTED: '  EVICTED ',
    EXPIRED: '  EXPIRED ',
    MISROUTED: '  MISROUTE',
    UNKNOWN: '  unknown ',
    'BY DESIGN': '  by-design',
  })[s] || `  ${s}`

console.log(`\nartwork   ${REF}${meta?.name ? `  "${meta.name}"` : ''}`)
console.log(`artist    ${artist}${ARTIST_ARG && metaCreator && metaCreator !== ARTIST_ARG ? `  (moment-meta creator: ${metaCreator})` : ''}`)
console.log(`inbox     ${notifs.length} notifications${atCap ? ` (AT the ${MAX_PER_USER} cap — oldest ${new Date(oldestNotifTs * 1000).toISOString()})` : ''}`)
console.log(`muted     actors: ${mutedActors.size ? [...mutedActors].join(', ') : 'none'} | types: ${mutedTypes.size ? [...mutedTypes].join(', ') : 'none'}`)
console.log(`on-chain  ${mints.length} mint(s) of this token${COLLECTOR_ARG ? `, ${scope.length} by ${COLLECTOR_ARG}` : ''}\n`)

for (const r of scope) {
  console.log(`${label(r.status)}  ${r.at ?? 'unknown time'}  ${r.collector}  ${r.units}x`)
  console.log(`             tx ${r.txHash}`)
  console.log(
    `             kismet-origin: ${r.kismetOrigin === null ? 'undetermined' : r.kismetOrigin ? `yes (referral:${r.kismetMintReferral ? 'y' : 'n'} builder-code:${r.kismetBuilderCode ? 'y' : 'n'})` : 'NO (neither referral nor builder code)'}` +
      ` | /api/collect ran: ${r.collectRecorded ? 'yes' : 'no'}` +
      ` | in collector list: ${r.inCollectedList ? 'yes' : 'no'}`,
  )
  console.log(`             ${r.reason}\n`)
}

const EXPLAINED = ['OK', 'BY DESIGN', 'AIRDROP', 'COALESCED']
const missing = scope.filter((r) => ['MISSING', 'LOST', 'HIDDEN', 'MISROUTED'].includes(r.status))
const inconclusive = scope.filter((r) => !EXPLAINED.includes(r.status) && !missing.includes(r))
console.log(
  missing.length === 0 && inconclusive.length === 0
    ? 'Every on-chain mint in scope is accounted for.'
    : `${missing.length} of ${scope.length} mint(s) produced no visible notification` +
      (inconclusive.length ? `; ${inconclusive.length} inconclusive (retention/eviction/expired key) — NOT the same as accounted for.` : '.'),
)
console.log(
  '\nReminder: the activity list and the sales/$ figures are read from In Process\'s on-chain\n' +
    'feeds, while the bell is written only by POST /api/collect. A row can therefore be real,\n' +
    'paid, and correctly counted in earnings while never having existed as a notification.\n',
)
