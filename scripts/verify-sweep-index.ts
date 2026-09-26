/**
 * Sweep index — builder integration on the REAL modules. lib/sweepIndex.ts
 * builds its own RPC client from the environment (lib/rpc serverBaseClient)
 * and persists through lib/redis, so this harness boots the fake chain of
 * scripts/_sweep-fake-chain.ts behind HTTP and the mock Upstash of
 * scripts/_mock-upstash.ts, points the environment at both BEFORE the modules
 * load, and then drives rebuildSweepIndex / getSweepIndex / the flag on them.
 *
 * WHAT IT GUARDS: every candidate rule of candidatesFromCatalog (hidden, the
 * pass contract, malformed address, non-decimal id, canonical id, duplicate),
 * both chain passes (free / ended / scheduled / sold-out rows never enter the
 * pool; a per-collection fee over the bound drops that collection; a
 * non-Zora getTokenInfo is "unreadable", not fatal; a single reverting sale
 * row is skipped), the chunking (200-row pass 1, 100-row pass 2, one fee read)
 * and the pool cut, the persisted blob's shape and its round trip through the
 * real Upstash client, ABORT-DON'T-OVERWRITE on an RPC failure, a corrupt or
 * unreadable blob reading as "no index", and the flag's '1' → number-1
 * round trip (the Upstash auto-deserialization pitfall lib/gateFlags exists for).
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-sweep-index.ts
 */

import { createMockUpstash } from './_mock-upstash.ts'
import { createFakeChain, liveSale, startFakeRpcServer, tokenKey } from './_sweep-fake-chain.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  }
}

const NOW = 1_800_000_000n
const FEE = 111_000_000_000_000n
const COL_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const COL_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const COL_C = '0xcccccccccccccccccccccccccccccccccccccccc'
const ART = '0x1111111111111111111111111111111111111111'

async function main() {
  const upstash = createMockUpstash()
  const chain = createFakeChain({ now: NOW })
  const [redisUrl, rpc] = await Promise.all([upstash.start(), startFakeRpcServer(chain)])
  process.env.UPSTASH_REDIS_REST_URL = redisUrl
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token'
  process.env.BASE_RPC_URL = rpc.url
  const stop = () => {
    upstash.close()
    rpc.close()
  }

  try {
    // The modules read the environment at load, so import AFTER it is set.
    const { candidatesFromCatalog, getSweepIndex, isSweepEnabled, rebuildSweepIndex, setSweepEnabled } = await import('../lib/sweepIndex.ts')
    const { SWEEP_ENABLED_KEY, SWEEP_INDEX_KEY } = await import('../lib/redis.ts')
    const { PATRON_COLLECTION_ADDRESS } = await import('../lib/patronCollection.ts')
    const { SWEEP_POOL_SIZE } = await import('../lib/sweepIndexCore.ts')
    type SweepIndex = import('../lib/sweepIndexCore.ts').SweepIndex
    type ResolvedCatalog = import('../lib/catalogCensus.ts').ResolvedCatalog
    type ResolvedCatalogItem = import('../lib/catalogCensus.ts').ResolvedCatalogItem

    const item = (addr: string, tokenId: string, over: Partial<ResolvedCatalogItem> = {}): ResolvedCatalogItem => ({
      m: {
        address: addr,
        token_id: tokenId,
        uri: '',
        creator: { address: ART, hidden: false },
        admins: [],
        created_at: '2026-01-01T00:00:00.000Z',
        metadata: { name: `Piece ${tokenId}`, image: 'ar://img' },
      },
      addr,
      creator: ART,
      artist: ART,
      hidden: false,
      meta: null,
      ...over,
    })
    const catalog = (items: ResolvedCatalogItem[]): ResolvedCatalog => ({
      items,
      collections: [...new Set(items.map((i) => i.addr))],
      possiblyTruncated: 0,
      pageFailures: 0,
    })
    const put = (col: string, id: bigint, t: Parameters<typeof chain.tokens.set>[1]) => chain.tokens.set(tokenKey(col, id), t)

    // ── 1. candidatesFromCatalog ──
    console.log('candidatesFromCatalog')
    {
      const cands = candidatesFromCatalog(
        catalog([
          item(COL_A, '1'),
          item(COL_A, '1'), // duplicate
          item(COL_A, '0012'), // canonicalizes to 12
          item(COL_A, '7', { hidden: true }),
          item(PATRON_COLLECTION_ADDRESS, '1'),
          item('not-an-address', '1'),
          item(COL_A, 'abc'),
          item(COL_A, '99', { artist: ART.toUpperCase() }),
        ]),
      )
      const keys = cands.map((c) => tokenKey(c.address, c.tokenId))
      check('hidden, pass-contract, malformed-address and non-decimal rows never become candidates; duplicates collapse', keys.join() === [tokenKey(COL_A, 1n), tokenKey(COL_A, 12n), tokenKey(COL_A, 99n)].join(), keys.join())
      check('token ids are canonical decimal', cands.some((c) => c.tokenId === '12') && !cands.some((c) => c.tokenId === '0012'))
      check('the artist identity is lowercased', cands.find((c) => c.tokenId === '99')?.artist === ART)
      check('preview fields ride along', cands[0].name === 'Piece 1' && cands[0].image === 'ar://img')
    }

    // ── 2. rebuildSweepIndex — both passes, persisted, read back ──
    console.log('rebuildSweepIndex')
    chain.fees.set(COL_A, FEE)
    chain.fees.set(COL_B, 20_000_000_000_000_000n) // 0.02 ETH: over the bound → the whole collection is dropped
    chain.fees.set(COL_C, FEE)
    put(COL_A, 1n, { sale: liveSale(1_000n) })
    put(COL_A, 2n, { sale: liveSale(0n) }) // free
    put(COL_A, 3n, { sale: { ...liveSale(1_000n), saleEnd: NOW - 1n } }) // ended
    put(COL_A, 4n, { sale: { ...liveSale(1_000n), saleStart: NOW + 1n } }) // scheduled
    put(COL_A, 5n, { sale: liveSale(1_000n), info: { maxSupply: 5n, totalMinted: 5n } }) // sold out
    put(COL_A, 6n, { sale: liveSale(2_000n), info: { maxSupply: 10n, totalMinted: 4n } }) // capped, room
    put(COL_A, 12n, { sale: liveSale(3_000n) })
    put(COL_A, 13n, { sale: 'revert' }) // a reverting sale row is skipped, never fatal
    put(COL_B, 1n, { sale: liveSale(10n) }) // cheapest of all — but its collection's fee is unreadable
    put(COL_C, 1n, { sale: liveSale(500n), info: 'revert' }) // non-Zora getTokenInfo → unreadable supply → open
    const cat = catalog([
      item(COL_A, '1'),
      item(COL_A, '2'),
      item(COL_A, '3'),
      item(COL_A, '4'),
      item(COL_A, '5'),
      item(COL_A, '6'),
      item(COL_A, '0012'),
      item(COL_A, '13'),
      item(COL_B, '1'),
      item(COL_C, '1'),
    ])
    const built = await rebuildSweepIndex(cat)
    const order = built.items.map((i) => tokenKey(i.address, i.tokenId))
    check('the pool holds exactly the live, paid, unsold rows of collections with a readable fee — cheapest outlay first', order.join() === [tokenKey(COL_C, 1n), tokenKey(COL_A, 1n), tokenKey(COL_A, 6n), tokenKey(COL_A, 12n)].join(), order.join())
    check('eligible counts the ranked rows', built.eligible === 4)
    const a6 = built.items.find((i) => i.tokenId === '6')!
    check('string-wei fields: price, fee and outlay = price + fee', a6.priceWei === '2000' && a6.feeWei === FEE.toString() && a6.outlayWei === (2_000n + FEE).toString())
    check('preview fields survive into the blob', a6.name === 'Piece 6' && a6.image === 'ar://img')
    check('chain traffic: 1 sale chunk, 1 supply chunk, 1 fee read', chain.ethCalls === 3, chain.ethCalls)
    const stored = upstash.store.get(SWEEP_INDEX_KEY)?.v
    check('the blob is persisted under SWEEP_INDEX_KEY as JSON', typeof stored === 'string' && (JSON.parse(stored) as SweepIndex).items.length === 4)
    const read = await getSweepIndex()
    check('getSweepIndex round-trips the blob through the real Upstash client', read !== null && read.updatedAt === built.updatedAt && read.items.map((i) => tokenKey(i.address, i.tokenId)).join() === order.join())

    // ── 3. abort-don't-overwrite ──
    console.log('abort-don\'t-overwrite')
    chain.failing = true
    let threw = false
    try {
      await rebuildSweepIndex(cat)
    } catch {
      threw = true
    }
    chain.failing = false
    check('an RPC failure makes the rebuild THROW', threw)
    const after = await getSweepIndex()
    check('…and the last good blob is untouched', after !== null && after.updatedAt === built.updatedAt && after.items.length === 4)

    // ── 4. chunking + pool cut ──
    console.log('chunking + pool cut')
    {
      const fresh = createFakeChain({ now: NOW })
      // Swap the HTTP server's state by mutating the shared object.
      Object.assign(chain, { tokens: fresh.tokens, fees: fresh.fees, ethCalls: 0, log: [] })
      chain.fees.set(COL_A, FEE)
      const items: ResolvedCatalogItem[] = []
      for (let id = 1; id <= 250; id++) {
        put(COL_A, BigInt(id), { sale: liveSale(BigInt(1_000 * id)) })
        items.push(item(COL_A, String(id)))
      }
      const big = await rebuildSweepIndex(catalog(items))
      check('250 candidates: 2 sale chunks (200) + 3 supply chunks (100) + 1 fee read', chain.ethCalls === 6, chain.ethCalls)
      check('the pool is cut to SWEEP_POOL_SIZE, eligible keeps the full count', big.items.length === SWEEP_POOL_SIZE && big.eligible === 250)
      check('the cut keeps the cheapest', big.items[0].tokenId === '1' && big.items[SWEEP_POOL_SIZE - 1].tokenId === String(SWEEP_POOL_SIZE))
    }

    // ── 5. unreadable blobs ──
    console.log('getSweepIndex on bad data')
    upstash.store.set(SWEEP_INDEX_KEY, { v: JSON.stringify({ nope: 1 }) })
    check('a blob without updatedAt/items reads as no index', (await getSweepIndex()) === null)
    upstash.store.set(SWEEP_INDEX_KEY, { v: '{not json' })
    check('a corrupt blob reads as no index (never throws)', (await getSweepIndex()) === null)
    upstash.setFailing(true)
    check('a Redis failure reads as no index (never throws)', (await getSweepIndex()) === null)
    upstash.setFailing(false)

    // ── 6. the flag ──
    console.log('isSweepEnabled / setSweepEnabled')
    check('unset → off', (await isSweepEnabled()) === false)
    await setSweepEnabled(true)
    check("on: stored as the string '1' (what the Upstash client hands back as the number 1)", upstash.store.get(SWEEP_ENABLED_KEY)?.v === '1')
    check('on: read back true through the memo (invalidated by the write)', (await isSweepEnabled()) === true)
    await setSweepEnabled(false)
    check('off: the key is deleted and the read is false at once', !upstash.store.has(SWEEP_ENABLED_KEY) && (await isSweepEnabled()) === false)
    upstash.setFailing(true)
    let flagThrew = false
    try {
      await setSweepEnabled(true)
    } catch {
      flagThrew = true
    }
    check('a Redis failure on the flag WRITE propagates (the admin route reports it, nothing is cached)', flagThrew)
    // A cached verdict legitimately outlives a blip for its TTL; the contract
    // under test is the MISS: a read that must hit Redis propagates the failure
    // so every caller fails closed, instead of manufacturing a false.
    isSweepEnabled.invalidate()
    let readThrew = false
    try {
      await isSweepEnabled()
    } catch {
      readThrew = true
    }
    upstash.setFailing(false)
    check('a Redis failure on a flag read (cache miss) PROPAGATES — callers fail closed, never a cached false', readThrew)

    console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — sweep index: ${failures === 0 ? 'all assertions passed' : `${failures} failed`}`)
    stop()
    process.exit(failures === 0 ? 0 : 1)
  } catch (e) {
    console.error('verify-sweep-index crashed:', e)
    stop()
    process.exit(1)
  }
}

main()
