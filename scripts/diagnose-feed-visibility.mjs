#!/usr/bin/env node
/*
 * diagnose-feed-visibility.mjs
 * ---------------------------------------------------------------------------
 * Answers "why is this mint not in the home / trending feeds?" for a specific
 * artwork or artist, by checking every gate a moment must pass to surface,
 * in the exact order the timeline route applies them.
 *
 * A moment reaches Kismet's cross-collection feeds only when ALL of these
 * hold (each check below cites the code that enforces it):
 *
 *   G1  its collection is in the tracked set `kismetart:collections`
 *       (app/api/timeline/route.ts fan-out via lib/kv.getTrackedCollections —
 *       an untracked collection is never even fetched, so the moment is
 *       invisible in EVERY feed surface including the artist's profile)
 *   G2  In Process's per-collection GET /timeline returns the row
 *       (fetchCollection in app/api/timeline/route.ts — Kismet builds every
 *       feed from that endpoint; /moment resolving is NOT enough)
 *   G3  it is not hidden: moment (kismetart:hidden-moments), collection
 *       (kismetart:hidden-collections), or creator (kismetart:hidden-users)
 *       (timeline route hidden-filter block)
 *   G4  for the HOME tab (mints) and the TRENDING tab — both request
 *       scope=standalone (components/DiscoverPage.tsx) — the member
 *       `<addr>:<tokenId>` must be in `kismetart:created-mints`
 *       (timeline route standalone filter via lib/kv.getCreatedMintsMembership;
 *       written ONLY by lib/mint-proxy.ts after() on a successful relayed
 *       mint, and by the Create-Collection cover path)
 *   G5  for LATEST/MOST SALES sorts additionally: the member must not be in
 *       the free census `kismetart:sale-free` (free mints are dropped), and
 *       its rank comes from `kismetart:trending-latest` / `kismetart:trending`
 *       — zsets written ONLY by Kismet's own /api/collect. A priced moment
 *       nobody has collected through Kismet sorts below every ranked row.
 *   G6  ordering: newest-first uses the KV moment-meta createdAt pin when
 *       present, else In Process's created_at (timeline stitch) — a missing
 *       pin plus an old upstream created_at sinks the row pages deep.
 *
 * READ-ONLY: this script never writes. It prints the exact remedy command
 * for each failed gate but leaves execution to the operator (mirror of the
 * reconcile-*.mjs safety posture).
 *
 * Usage:
 *   node scripts/diagnose-feed-visibility.mjs --creator 0xabc...            # newest works of an artist
 *   node scripts/diagnose-feed-visibility.mjs --artwork 0xCOLL:TOKENID      # one specific artwork
 *   node scripts/diagnose-feed-visibility.mjs --artwork https://kismet.art/artwork/0xCOLL/1
 *   ...combine both; --artwork accepts comma-separated values.
 *
 * Options:
 *   --site https://kismet.art     base URL for surface-truth checks (default)
 *   --limit N                     newest creator works to diagnose (default 10)
 *   --pages N                     home/latest-sales pages (x100 rows) to scan (default 3)
 *
 * Env (optional but strongly recommended — same names the app reads):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *     Without them the Redis gates report UNKNOWN and the verdict falls back
 *     to what the public APIs alone can prove.
 */

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
const flagVal = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const SITE = (flagVal('--site') || 'https://kismet.art').replace(/\/$/, '')
const INPROCESS = (flagVal('--inprocess') || 'https://api.inprocess.world/api').replace(/\/$/, '')
const CREATOR = (flagVal('--creator') || '').toLowerCase()
const LIMIT = Math.max(1, Number(flagVal('--limit')) || 10)
const PAGES = Math.max(1, Number(flagVal('--pages')) || 3)

function parseArtworkArg(raw) {
  const s = raw.trim()
  // URL forms: /artwork/0x…/<id> or /moment/0x…/<id>
  const url = s.match(/\/(?:artwork|moment)\/(0x[0-9a-fA-F]{40})\/(\d+)/)
  if (url) return { address: url[1].toLowerCase(), tokenId: url[2] }
  const pair = s.match(/^(0x[0-9a-fA-F]{40})[:/](\d+)$/)
  if (pair) return { address: pair[1].toLowerCase(), tokenId: pair[2] }
  return null
}
const ARTWORKS = (flagVal('--artwork') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const p = parseArtworkArg(s)
    if (!p) {
      console.error(`FATAL: --artwork "${s}" is not 0xADDR:TOKENID or an artwork URL`)
      process.exit(1)
    }
    return p
  })

if (!CREATOR && ARTWORKS.length === 0) {
  console.error('Usage: node scripts/diagnose-feed-visibility.mjs --creator 0x… | --artwork 0xCOLL:TOKENID[,…]')
  process.exit(1)
}
if (CREATOR && !/^0x[0-9a-f]{40}$/.test(CREATOR)) {
  console.error(`FATAL: --creator ${CREATOR} is not a valid 0x-address`)
  process.exit(1)
}

// ---------------------------------------------------------------- Upstash REST
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const HAS_REDIS = !!(REDIS_URL && REDIS_TOKEN)

async function redisCmd(cmd) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  })
  if (!res.ok) throw new Error(`redis ${cmd[0]} ${res.status}: ${await res.text()}`)
  return (await res.json()).result
}

// keys — mirror lib/kv.ts, lib/redis.ts, lib/notifications.ts, lib/hidden*.ts
const KEY_TRACKED = 'kismetart:collections'
const KEY_CURATED = 'kismetart:created-collections'
const KEY_CREATED_MINTS = 'kismetart:created-mints'
const KEY_HIDDEN_MOMENTS = 'kismetart:hidden-moments'
const KEY_HIDDEN_COLLECTIONS = 'kismetart:hidden-collections'
const KEY_HIDDEN_USERS = 'kismetart:hidden-users'
const KEY_TRENDING = 'kismetart:trending'
const KEY_TRENDING_LATEST = 'kismetart:trending-latest'
const KEY_SALE_FREE = 'kismetart:sale-free'
const KEY_SALE_ENDS = 'kismetart:sale-ends'
const KEY_FEATURED = 'kismetart:featured'
const kMomentMeta = (lower, tokenId) => `kismetart:moment-meta:${lower}:${tokenId}`

// The sets can hold case-variant members (see reconcile-curated-collections.mjs);
// membership must be case-insensitive against the stored strings.
async function setLowerMembers(key) {
  const raw = (await redisCmd(['SMEMBERS', key])) || []
  return new Set(raw.map((m) => String(m).toLowerCase()))
}

// ---------------------------------------------------------------- fetch helpers
async function getJson(url, timeoutMs = 15000) {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, data: await res.json() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const canonId = (t) => {
  try {
    return BigInt(t).toString()
  } catch {
    return String(t)
  }
}
const keyOf = (addr, tokenId) => `${addr.toLowerCase()}:${canonId(tokenId)}`

// Mirror lib/media/resolveMomentMedia's text rule; coarse for the rest — this
// is a label for the report, not a render decision.
function mediaKind(meta) {
  if (!meta) return 'unknown'
  const mime = meta.content?.mime
  if (mime === 'text/plain') return 'text'
  if (mime?.startsWith('video/') || meta.animation_url) return 'video/anim'
  if (mime === 'image/gif') return 'gif'
  if (meta.image || meta.content?.uri) return 'image'
  return 'none'
}

const fmt = (v) => (v === undefined || v === null ? '—' : String(v))
const YES = 'PASS'
const NO = 'FAIL'
const UNK = '????'

// ---------------------------------------------------------------- gate checks
async function diagnoseMoment({ address, tokenId }, ctx) {
  const lower = address.toLowerCase()
  const id = canonId(tokenId)
  const member = keyOf(address, tokenId)
  const lines = []
  const say = (s) => lines.push(s)
  const gate = (label, verdict, detail) =>
    say(`  ${verdict.padEnd(5)} ${label}${detail ? ` — ${detail}` : ''}`)

  say(`\n─── ${lower} #${id} ${'─'.repeat(Math.max(0, 30))}`)

  // Upstream truth (G2 + metadata): the per-collection timeline is what every
  // Kismet feed is built from.
  const tl = await getJson(`${INPROCESS}/timeline?collection=${lower}&limit=200&chain_id=8453`)
  let row
  if (tl.ok) {
    const moments = Array.isArray(tl.data?.moments) ? tl.data.moments : []
    row = moments.find((m) => canonId(m?.token_id) === id && String(m?.address).toLowerCase() === lower)
  }
  const detail = await getJson(`${INPROCESS}/moment?collectionAddress=${lower}&tokenId=${id}&chainId=8453`)
  const detailOk = detail.ok && detail.data && typeof detail.data === 'object'

  if (row) {
    const kind = mediaKind(row.metadata)
    say(`  name: ${fmt(row.metadata?.name)}  media: ${kind}  upstream created_at: ${fmt(row.created_at)}`)
    say(`  upstream creator: ${fmt(row.creator?.address?.toLowerCase())}`)
    gate('G2 In Process /timeline lists it', YES)
  } else if (tl.ok) {
    gate('G2 In Process /timeline lists it', NO, 'not in the newest 200 rows of its collection timeline')
  } else {
    gate('G2 In Process /timeline lists it', UNK, `timeline fetch failed (${tl.status ?? tl.error})`)
  }
  gate(
    'In Process /moment resolves it',
    detailOk ? YES : detail.status === 404 ? NO : UNK,
    detailOk ? undefined : `status ${fmt(detail.status ?? detail.error)}`,
  )
  const saleConfig = detailOk ? detail.data.saleConfig : undefined
  let free = null // null = unknown (mirror lib/inprocess.isZeroPrice)
  if (saleConfig?.pricePerToken != null && saleConfig.pricePerToken !== '') {
    try {
      free = BigInt(saleConfig.pricePerToken) === 0n
    } catch {}
  }
  say(
    `  saleConfig: ${saleConfig ? `${fmt(saleConfig.type)} price=${fmt(saleConfig.pricePerToken)} (${free === true ? 'FREE' : free === false ? 'priced' : 'unknown'})` : '— (absent upstream; feed price falls back on-chain)'}`,
  )

  // Redis gates
  let tracked, curated, createdMint, hiddenMoment, hiddenCollection, hiddenUser
  let meta, zLatest, zTrend, zFree, zEnds, zFeatured
  if (HAS_REDIS) {
    ;[createdMint, hiddenMoment, meta, zLatest, zTrend, zFree, zEnds, zFeatured] = await Promise.all([
      redisCmd(['SISMEMBER', KEY_CREATED_MINTS, member]),
      redisCmd(['SISMEMBER', KEY_HIDDEN_MOMENTS, member]),
      redisCmd(['GET', kMomentMeta(lower, id)]),
      redisCmd(['ZSCORE', KEY_TRENDING_LATEST, member]),
      redisCmd(['ZSCORE', KEY_TRENDING, member]),
      redisCmd(['ZSCORE', KEY_SALE_FREE, member]),
      redisCmd(['ZSCORE', KEY_SALE_ENDS, member]),
      redisCmd(['ZSCORE', KEY_FEATURED, member]),
    ])
    tracked = ctx.trackedLower.has(lower)
    curated = ctx.curatedLower.has(lower)
    hiddenCollection = ctx.hiddenCollectionsLower.has(lower)
    const metaObj = (() => {
      if (!meta) return null
      try {
        return typeof meta === 'string' ? JSON.parse(meta) : meta
      } catch {
        return null
      }
    })()
    // Creator precedence mirror (lib/statsMath.resolveMomentCreator): KV outranks feed.
    const effectiveCreator = (metaObj?.creator || row?.creator?.address || '').toLowerCase()
    hiddenUser = effectiveCreator ? ctx.hiddenUsersLower.has(effectiveCreator) : false

    gate(
      'G1 collection tracked (kismetart:collections)',
      tracked ? YES : NO,
      tracked
        ? curated
          ? 'also in curated created-collections'
          : 'tracked (auto-deploy wrapper / non-curated)'
        : 'NOT tracked — timeline fan-out never fetches this collection: invisible in every feed incl. profile',
    )
    gate(
      'G3 not hidden (moment / collection / user)',
      hiddenMoment || hiddenCollection || hiddenUser ? NO : YES,
      hiddenMoment
        ? 'moment is in kismetart:hidden-moments'
        : hiddenCollection
          ? 'parent collection is hidden'
          : hiddenUser
            ? `creator ${effectiveCreator} is admin-hidden (note: app also hides FID-sibling addresses)`
            : undefined,
    )
    gate(
      'G4 created-mints member (home + trending scope=standalone)',
      createdMint ? YES : NO,
      createdMint
        ? undefined
        : 'missing from kismetart:created-mints — the strict Mints filter drops it from the home and trending tabs (profile/collection pages unaffected)',
    )
    say(
      `  moment-meta: ${metaObj ? `creator=${fmt(metaObj.creator)} createdAt-pin=${fmt(metaObj.createdAt)}` : 'ABSENT — mint-proxy after() hooks never ran for this piece (off-platform mint, or the write was lost)'}`,
    )
    if (row && !metaObj?.createdAt) {
      say('         ↳ G6 ordering: no pin — the feed sorts on In Process created_at; a reindex-on-edit can move it')
    }
    say(
      `  latest-sales inputs: lastKismetCollect=${zLatest ? new Date(Number(zLatest)).toISOString() : 'never (unranked → sorts below every ranked row)'}  collectCount=${fmt(zTrend)}  free-census=${zFree ? 'IN (dropped from sales feeds)' : 'not indexed'}  sale-ends=${zEnds ? new Date(Number(zEnds) * 1000).toISOString() : '—'}  featured=${zFeatured ? 'yes' : 'no'}`,
    )
  } else {
    gate('G1 collection tracked', UNK, 'set UPSTASH_REDIS_REST_URL/TOKEN for Redis gates')
    gate('G3 not hidden', UNK, '')
    gate('G4 created-mints member', UNK, '')
  }

  // Surface truth from the public site APIs
  const inHome = ctx.homeKeys.has(member)
  const inLatest = ctx.latestKeys.has(member)
  gate(`home tab shows it (first ${ctx.homeKeys.size} rows)`, inHome ? YES : NO)
  gate(`trending "latest sales" shows it (first ${ctx.latestKeys.size} rows)`, inLatest ? YES : NO)

  // ---- verdict --------------------------------------------------------------
  say('  VERDICT:')
  if (HAS_REDIS && !tracked) {
    say('    ✗ The collection was never registered in the tracked set, so no Kismet feed can ever fetch it.')
    say('      Likely cause: the auto-deploy wrapper registration (client-side registerCollectionWithBackoff')
    say('      after /api/mint | /api/write, or absent entirely on the agent mint path) never landed.')
    say(`      Remedy (registers for fan-out only, NOT curated): SADD ${KEY_TRACKED} ${lower}`)
  } else if (row === undefined && tl.ok) {
    say('    ✗ In Process\'s /timeline does not return this token for its collection — Kismet feeds are built')
    say('      from that endpoint, so nothing downstream can show it. If /moment resolves it, this is an')
    say('      upstream indexer gap (cf. cover-mint synthesis in lib/coverMomentSynthesis.ts, which only')
    say('      rescues registered Create-Collection covers).')
  } else if (HAS_REDIS && (hiddenMoment || hiddenCollection || hiddenUser)) {
    say('    ✗ Hidden by a moderation/creator hide — working as designed for public feeds.')
  } else if (HAS_REDIS && !createdMint) {
    say('    ✗ ROOT CAUSE for home + trending: not a member of kismetart:created-mints.')
    say('      The strict Mints scope (scope=standalone) only shows moments minted through Kismet\'s relay')
    say('      (lib/mint-proxy.ts after() → markCreatedMint) or Create-Collection covers. This piece shows on')
    say('      profile/collection surfaces but is filtered from the home + trending tabs.')
    say('      Possible causes: minted off-platform (inprocess.world or another client), or the after() write')
    say('      was lost (deploy restart / Redis blip / upstream response missing contractAddress|tokenId).')
    say(`      Remedy (one-off): SADD ${KEY_CREATED_MINTS} ${member}`)
  } else {
    if (inHome) say('    ✓ Passes every home-feed gate and is present in the home rows scanned.')
    else if (HAS_REDIS)
      say('    ~ Passes every home-feed gate but was not in the scanned home rows — check ordering (G6): an old')
    if (!inHome && HAS_REDIS)
      say('      created_at / missing pin sorts it deep; increase --pages to locate it.')
    if (free === true || (HAS_REDIS && zFree)) {
      say('    ✗ latest/most sales: FREE mint — excluded from the sales feeds by design (free ≠ sale;')
      say('      lib/saleEnds free census + the timeline latest-sales filter).')
    } else if (HAS_REDIS && !zLatest) {
      say('    ~ latest sales: eligible but UNRANKED — no collect has been recorded through Kismet\'s /api/collect')
      say('      yet, so it sorts below every ranked row (page-deep). It surfaces the moment someone collects it')
      say('      on Kismet. Collects made on other clients never rank it (the zset is Kismet-write-only).')
    }
  }
  console.log(lines.join('\n'))
  return { member, inHome, inLatest }
}

// ---------------------------------------------------------------- main
async function main() {
  console.log('='.repeat(78))
  console.log('diagnose-feed-visibility')
  console.log(`site: ${SITE}   inprocess: ${INPROCESS}   redis: ${HAS_REDIS ? 'yes' : 'NO (gates limited)'}`)
  console.log('='.repeat(78))

  // Shared context: tracked/curated/hidden sets + the current home/latest rows.
  const ctx = {
    trackedLower: new Set(),
    curatedLower: new Set(),
    hiddenCollectionsLower: new Set(),
    hiddenUsersLower: new Set(),
    homeKeys: new Set(),
    latestKeys: new Set(),
  }
  if (HAS_REDIS) {
    ;[ctx.trackedLower, ctx.curatedLower, ctx.hiddenCollectionsLower, ctx.hiddenUsersLower] = await Promise.all([
      setLowerMembers(KEY_TRACKED),
      setLowerMembers(KEY_CURATED),
      setLowerMembers(KEY_HIDDEN_COLLECTIONS),
      setLowerMembers(KEY_HIDDEN_USERS),
    ])
    console.log(
      `tracked collections: ${ctx.trackedLower.size} (curated: ${ctx.curatedLower.size})  hidden: collections=${ctx.hiddenCollectionsLower.size} users=${ctx.hiddenUsersLower.size}`,
    )
  }

  // Surface truth — the exact URLs the tabs request (components/DiscoverPage.tsx).
  for (let p = 1; p <= PAGES; p++) {
    const [home, latest] = await Promise.all([
      getJson(`${SITE}/api/timeline?scope=standalone&limit=100&page=${p}`),
      getJson(`${SITE}/api/timeline?sort=latest-sales&scope=standalone&limit=100&page=${p}`),
    ])
    for (const [res, set] of [
      [home, ctx.homeKeys],
      [latest, ctx.latestKeys],
    ]) {
      if (res.ok && Array.isArray(res.data?.moments)) {
        for (const m of res.data.moments) {
          if (m?.address && m?.token_id != null) set.add(keyOf(m.address, m.token_id))
        }
      }
    }
  }
  console.log(`home rows scanned: ${ctx.homeKeys.size}   latest-sales rows scanned: ${ctx.latestKeys.size}`)

  const targets = [...ARTWORKS]

  if (CREATOR) {
    // What the profile "created" tab actually renders (/api/timeline?creator=…,
    // scope defaults to 'all' → NO created-mints filter — the load-bearing
    // difference from the home tab).
    const prof = await getJson(`${SITE}/api/timeline?creator=${CREATOR}&limit=50`)
    const moments = prof.ok && Array.isArray(prof.data?.moments) ? prof.data.moments : []
    console.log(`\ncreator ${CREATOR}: profile feed returns ${moments.length} moment(s)`)
    if (!prof.ok) console.log(`  (profile feed fetch failed: ${fmt(prof.status ?? prof.error)})`)
    const missingHome = []
    for (const m of moments) {
      const k = keyOf(m.address, m.token_id)
      const inHome = ctx.homeKeys.has(k)
      const kind = mediaKind(m.metadata)
      console.log(
        `  ${inHome ? ' ' : '»'} ${k}  ${fmt(m.created_at)}  [${kind}]  ${fmt(m.metadata?.name)}${m.hidden ? '  [hidden]' : ''}${inHome ? '' : '   ← NOT in home rows'}`,
      )
      if (!inHome) missingHome.push(m)
    }
    if (moments.length === 0) {
      console.log('  ↳ empty profile feed: if the artist definitely minted, the collection is likely untracked (G1)')
      console.log('    or In Process attributes the moment to a different address — diagnose the piece directly')
      console.log('    with --artwork <collection>:<tokenId> from its artwork-page URL.')
    }
    // Diagnose the newest works missing from home first, then the remainder up to LIMIT.
    const ordered = [...missingHome, ...moments.filter((m) => !missingHome.includes(m))]
    for (const m of ordered.slice(0, LIMIT)) {
      targets.push({ address: String(m.address), tokenId: String(m.token_id) })
    }
  }

  const seen = new Set()
  for (const t of targets) {
    const k = keyOf(t.address, t.tokenId)
    if (seen.has(k)) continue
    seen.add(k)
    await diagnoseMoment(t, ctx)
  }

  console.log('\nDone. Every remedy printed above is a manual operator action — this script wrote nothing.')
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
