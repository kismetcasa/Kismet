/**
 * The collection page's Authorize-creators panel, server side — the merge in
 * lib/authorizedCreatorsCore.ts driven directly, then lib/authorizedCreators.ts
 * on the REAL modules against a mock Upstash (scripts/_mock-upstash.ts), a
 * mock Base JSON-RPC (Multicall3 aggregate3, eth_getLogs, eth_getCode) and a
 * mock inprocess API, all pointed at BEFORE the modules load.
 *
 * WHAT IT GUARDS — the 2026-11-17 Patron grant: ADMIN went to an artist's EOA
 * and inprocess wallet in one multicall, the panel's post-receipt save never
 * landed, and with a KV-only GET the grant was invisible, unrevocable and
 * unannounced. So:
 *   - every token-0 ADMIN holder without a record comes back `unmapped`; an EOA
 *     and its wallet pair into one row (reverse index, or a forward lookup of
 *     EOAs only); holders found only in the UpdatedPermissions logs count; a
 *     refused log scan falls back to inprocess's admin list;
 *   - the collection's own wallets (owner, deployer, their inprocess wallets,
 *     the operator) are never listed — not even when the owner's wallet lookup
 *     fails; revoked and MINTER-only addresses aren't either;
 *   - a started grant the chain confirms is recorded by the GET (and its
 *     creator notified), however old; one already recorded, or expired without
 *     landing, is dropped; one whose wallet lacks ADMIN waits unseen;
 *   - a chain outage lists the records as live and nothing else; a Redis
 *     outage throws (the route's 503) rather than relabel everyone unmapped;
 *     an address nobody knows spends no log query;
 *   - writes: only an admin starts a grant, the mapping is verified when it
 *     starts, a save trusts a started grant's mapping when inprocess is down,
 *     a duplicate save notifies once, and a drop clears both records.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-authorized-creators.ts
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { decodeFunctionData, encodeEventTopics, encodeFunctionResult, parseAbi, type Hex } from 'viem'
import { createMockUpstash } from './_mock-upstash.ts'
import {
  buildCreatorRows,
  isEoaCode,
  latestPerEoa,
  pairUnmapped,
  planPendingGrants,
  unmappedHolders,
} from '../lib/authorizedCreatorsCore.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  }
}

/** A 20-byte address made of one repeated byte, lowercase. */
const addr = (byte: string) => `0x${byte.repeat(20)}`
const PROXY_CODE = `0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc${'00'.repeat(10)}` as Hex
const delegated = (to: string) => `0xef0100${to.slice(2)}` as Hex

// ───────────────────────── part 1: the pure merge ─────────────────────────
console.log('merge (pure)')
{
  const rows = latestPerEoa([
    { eoa: addr('A1').toUpperCase().replace('0X', '0x'), smartWallet: addr('b1'), grantedBy: addr('99'), grantedAt: 100 },
    { eoa: addr('a1'), smartWallet: addr('C1'), grantedBy: addr('99'), grantedAt: 200 },
    { eoa: undefined, smartWallet: addr('d1'), grantedBy: '', grantedAt: 300 } as never,
    { eoa: addr('e1'), smartWallet: addr('f1'), grantedBy: addr('99'), grantedAt: 150, label: 'e.eth' },
  ])
  check('latestPerEoa: one row per EOA (case-insensitive), the newest wins', rows.length === 2 && rows[0].eoa === addr('a1') && rows[0].smartWallet === addr('c1'))
  check('latestPerEoa: newest first, label kept, a member without an EOA skipped', rows[1].eoa === addr('e1') && rows[1].label === 'e.eth')
}
{
  const now = 1_000_000
  const p = (b: string, createdAt = now - 10) => ({ eoa: addr(b), smartWallet: addr(b.replace(/^./, 'f')), grantedBy: addr('99'), createdAt })
  // a7's smart wallet holds ADMIN but its EOA doesn't: the shape a CANCELLED
  // panel grant leaves when that wallet already held ADMIN (the prompt only
  // asked for the EOA's bit). It must wait, never be recorded.
  const admin = new Map([
    [addr('f2'), true], [addr('a2'), true],
    [addr('f3'), false],
    [addr('f5'), true], [addr('a5'), true],
    [addr('f6'), false],
    [addr('f7'), true], [addr('a7'), false],
  ])
  const plan = planPendingGrants(
    [p('a1'), p('a2'), p('a3'), p('a4'), p('a5', now - 5_000), p('a6', now - 5_000), p('a7')],
    new Set([addr('a1')]),
    (a) => admin.get(a),
    now,
    1_000,
  )
  const eoas = (xs: { eoa: string }[]) => xs.map((x) => x.eoa).sort().join(',')
  check('pending: already recorded → dropped, even though its wallet holds ADMIN', plan.drop.some((x) => x.eoa === addr('a1')))
  check('pending: past the TTL and never landed → dropped', eoas(plan.drop) === [addr('a1'), addr('a6')].join(','))
  check('pending: wallet holds ADMIN → promoted, however old (a landed grant is never forgotten)', eoas(plan.promote) === [addr('a2'), addr('a5')].join(','))
  check('pending: wallet lacks ADMIN, or its read failed → left waiting', !eoas([...plan.drop, ...plan.promote]).includes(addr('a3')) && !eoas([...plan.drop, ...plan.promote]).includes(addr('a4')))
  check('pending: smart wallet ADMIN without the EOA (a cancelled grant) → never promoted', !eoas([...plan.drop, ...plan.promote]).includes(addr('a7')))
}
{
  const loose = unmappedHolders([addr('C2'), addr('a2'), addr('b2'), addr('c2'), addr('d2')], new Set([addr('a2')]), new Set([addr('b2')]))
  check('unmappedHolders: minus known and the collection\'s own wallets, lowercased, deduped, sorted', JSON.stringify(loose) === JSON.stringify([addr('c2'), addr('d2')]))
}
{
  const g = pairUnmapped(
    [addr('e3'), addr('f3'), addr('f4'), addr('a3'), addr('f5')],
    new Map([
      [addr('f3'), addr('e3')], // wallet + its EOA, both loose → a pair
      [addr('f4'), addr('e4')], // its EOA isn't loose → stays single
      [addr('f5'), addr('e3')], // second wallet claiming an already paired EOA → single
      [addr('a3'), addr('a3')], // self-mapping ignored
    ]),
  )
  check('pairUnmapped: an EOA and its wallet, both holding ADMIN, become one row', g.pairs.length === 1 && g.pairs[0].eoa === addr('e3') && g.pairs[0].smartWallet === addr('f3'))
  check('pairUnmapped: a wallet whose EOA isn\'t a holder, a second claimant, a self-map stay single', JSON.stringify(g.singles) === JSON.stringify([addr('a3'), addr('f4'), addr('f5')].sort()))
}
{
  const admin = new Map([[addr('b6'), true], [addr('d6'), false]])
  const rows = buildCreatorRows(
    [
      { eoa: addr('a6'), smartWallet: addr('b6'), grantedBy: addr('99'), grantedAt: 2 },
      { eoa: addr('c6'), smartWallet: addr('d6'), grantedBy: addr('99'), grantedAt: 3 },
      { eoa: addr('e6'), smartWallet: addr('f6'), grantedBy: addr('99'), grantedAt: 1 },
    ],
    (a) => admin.get(a),
    { pairs: [{ eoa: addr('11'), smartWallet: addr('12') }], singles: [addr('13')] },
  )
  check('rows: recorded newest first, then unmapped pairs, then singles', rows.map((r) => r.eoa ?? r.smartWallet).join() === [addr('c6'), addr('a6'), addr('e6'), addr('11'), addr('13')].join())
  check('rows: a recorded wallet without ADMIN is stale; a failed read counts as live', rows[0].liveOnChain === false && rows[1].liveOnChain === true && rows[2].liveOnChain === true)
  check('rows: unmapped rows are flagged, live, unrecorded; a single has no EOA', rows[3].unmapped === true && rows[3].grantedBy === '' && rows[4].unmapped === true && rows[4].eoa === undefined && rows[4].liveOnChain === true)
  check('rows: recorded rows are not flagged unmapped', rows.slice(0, 3).every((r) => r.unmapped === undefined))
}
check('isEoaCode: no code, or an EIP-7702 delegation, is an EOA', isEoaCode(undefined) && isEoaCode('0x') && isEoaCode(delegated(addr('61'))))
check('isEoaCode: a proxy, or a malformed designator, is a contract', !isEoaCode(PROXY_CODE) && !isEoaCode(`0xef0100${'61'.repeat(19)}`))

// ───────────────────────── part 2: the real modules ─────────────────────────
const COLLECTION_ABI = parseAbi([
  'function owner() view returns (address)',
  'function permissions(uint256 tokenId, address user) view returns (uint256)',
])
const AGG3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
])
const EVENT_ABI = parseAbi([
  'event UpdatedPermissions(uint256 indexed tokenId, address indexed user, uint256 indexed permissions)',
])
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'

const chain = {
  owner: new Map<string, string>(),
  perms: new Map<string, Map<string, bigint>>(),
  logs: [] as { address: string; user: string; perms: bigint }[],
  code: new Map<string, Hex>(),
  logsRefused: false,
  down: false,
  getLogs: 0,
  ethCalls: 0,
}
const setPerms = (collection: string, entries: [string, bigint][]) => chain.perms.set(collection, new Map(entries))

function answerCollection(target: string, data: Hex): Hex {
  const { functionName, args } = decodeFunctionData({ abi: COLLECTION_ABI, data })
  const t = target.toLowerCase()
  if (functionName === 'owner') {
    const o = chain.owner.get(t)
    if (!o) throw new Error('mock: no owner')
    return encodeFunctionResult({ abi: COLLECTION_ABI, functionName: 'owner', result: o as Hex })
  }
  const [tokenId, user] = args as readonly [bigint, string]
  const bits = tokenId === 0n ? (chain.perms.get(t)?.get(user.toLowerCase()) ?? 0n) : 0n
  return encodeFunctionResult({ abi: COLLECTION_ABI, functionName: 'permissions', result: bits })
}

function rpc(method: string, params: unknown[]): unknown {
  if (method === 'eth_chainId') return '0x2105'
  if (method === 'eth_blockNumber') return '0x100'
  if (method === 'eth_call') {
    if (chain.down) throw new Error('mock: rpc down')
    chain.ethCalls++
    const { to, data } = params[0] as { to: string; data: Hex }
    if (to.toLowerCase() !== MULTICALL3) return answerCollection(to, data)
    const { args } = decodeFunctionData({ abi: AGG3_ABI, data })
    const calls = args[0] as readonly { target: string; callData: Hex }[]
    const result = calls.map((c) => {
      try {
        return { success: true, returnData: answerCollection(c.target, c.callData) }
      } catch {
        return { success: false, returnData: '0x' as Hex }
      }
    })
    return encodeFunctionResult({ abi: AGG3_ABI, functionName: 'aggregate3', result })
  }
  if (method === 'eth_getLogs') {
    chain.getLogs++
    if (chain.logsRefused) throw new Error('mock: eth_getLogs refused for this range')
    const f = params[0] as { address?: string; topics?: (Hex | null)[] }
    return chain.logs
      .filter((l) => !f.address || l.address === f.address.toLowerCase())
      .map((l, i) => ({
        address: l.address,
        // Every argument is given, so every topic is a single hash.
        topics: encodeEventTopics({ abi: EVENT_ABI, eventName: 'UpdatedPermissions', args: { tokenId: 0n, user: l.user as Hex, permissions: l.perms } }) as Hex[],
        data: '0x',
        blockNumber: '0x10',
        blockHash: `0x${'ab'.repeat(32)}`,
        transactionHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
        transactionIndex: '0x0',
        logIndex: `0x${i.toString(16)}`,
        removed: false,
      }))
      .filter((log) => (f.topics ?? []).every((t, i) => t == null || t.toLowerCase() === log.topics[i]?.toLowerCase()))
  }
  if (method === 'eth_getCode') {
    const [a] = params as [string]
    return chain.code.get(a.toLowerCase()) ?? '0x'
  }
  throw new Error(`mock: unsupported ${method}`)
}

function startRpc(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      const one = (m: { id: number; method: string; params?: unknown[] }) => {
        try {
          return { jsonrpc: '2.0', id: m.id, result: rpc(m.method, m.params ?? []) }
        } catch (e) {
          return { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }
        }
      }
      const parsed = JSON.parse(body)
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }))
  })
}

const inprocess = {
  admins: new Map<string, string[]>(),
  wallets: new Map<string, string>(),
  failing: new Set<string>(),
  walletLookups: new Map<string, number>(),
}
function startInprocess(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'application/json')
    const prefix = '/api/collections/eip155:8453/erc1155:'
    if (url.pathname.startsWith(prefix)) {
      const admins = inprocess.admins.get(url.pathname.slice(prefix.length).toLowerCase())
      if (!admins) {
        res.statusCode = 500 // what inprocess answers for a collection it doesn't know
        return res.end('')
      }
      return res.end(JSON.stringify({ admins }))
    }
    if (url.pathname === '/api/smartwallet') {
      const w = (url.searchParams.get('walletAddress') ?? '').toLowerCase()
      inprocess.walletLookups.set(w, (inprocess.walletLookups.get(w) ?? 0) + 1)
      if (inprocess.failing.has(w)) {
        res.statusCode = 503
        return res.end('{}')
      }
      // Like the real endpoint, every address gets SOME wallet back.
      return res.end(JSON.stringify({ address: inprocess.wallets.get(w) ?? `0x${w.slice(2).split('').reverse().join('')}` }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }))
  })
}

async function waitFor(cond: () => boolean, ms = 1500): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return cond()
}

// The cast: the collection, its own wallets, and the creators.
const OPERATOR = addr('0f')
const OWNER = addr('01')
const OWNER_SW = addr('02')
const ARTIST = addr('03') // the deployer the page names (KV meta), ≠ owner here
const ARTIST_SW = addr('04')
const T_EOA = addr('11'), T_SW = addr('12') // recorded, live
const N_EOA = addr('21'), N_SW = addr('22') // recorded, wallet revoked on etherscan
const D_EOA = addr('d1'), D_SW = addr('d2') // the lost save: both ADMIN, no record
const X = addr('e1') // ADMIN, found only in the logs
const R = addr('31') // in inprocess's list, ADMIN since revoked
const M = addr('41') // MINTER only
const P_EOA = addr('51'), P_SW = addr('52') // started grant that landed
const Q_EOA = addr('61'), Q_SW = addr('62') // started grant still in flight
const E_EOA = addr('71'), E_SW = addr('72') // started grant past its TTL that DID land
const O_EOA = addr('73'), O_SW = addr('74') // started grant past its TTL that never landed
const DAY = 24 * 60 * 60 * 1000

async function main() {
  const upstash = createMockUpstash({ modelSets: (k) => k.startsWith('kismetart:authorized-creators:') })
  const [redisUrl, rpcServer, ipServer] = await Promise.all([upstash.start(), startRpc(), startInprocess()])
  process.env.UPSTASH_REDIS_REST_URL = redisUrl
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token'
  process.env.BASE_RPC_URL = rpcServer.url
  process.env.INPROCESS_API_URL = `${ipServer.url}/api`
  process.env.NEXT_PUBLIC_OPERATOR_SMART_WALLET = OPERATOR
  const stop = () => {
    upstash.close()
    rpcServer.close()
    ipServer.close()
  }

  try {
    // The modules read the environment at load, so import AFTER it is set.
    const kv = await import('../lib/kv.ts')
    const ac = await import('../lib/authorizedCreators.ts')
    const notifsTo = (eoa: string) => upstash.zadds.filter((z) => z.key === `kismetart:notif:${eoa}`)
    const pendingKey = (c: string) => `kismetart:authorized-creators-pending:${c}`

    // ── the Patron shape ──
    console.log('list: records + chain + started grants')
    const C = addr('c1')
    chain.owner.set(C, OWNER)
    setPerms(C, [
      [OWNER, 2n], [OWNER_SW, 2n], [ARTIST, 2n], [ARTIST_SW, 2n], [OPERATOR, 7n],
      [T_EOA, 2n], [T_SW, 2n], [N_EOA, 2n], [N_SW, 0n],
      [D_EOA, 2n], [D_SW, 2n], [X, 2n], [R, 0n], [M, 4n],
      [P_EOA, 2n], [P_SW, 2n], [Q_EOA, 0n], [Q_SW, 0n], [E_EOA, 2n], [E_SW, 2n], [O_SW, 0n],
    ])
    inprocess.admins.set(C, [OWNER, OWNER_SW, ARTIST, ARTIST_SW, OPERATOR, T_EOA, T_SW, N_EOA, D_EOA, D_SW, R, M])
    chain.logs.push({ address: C, user: X, perms: 2n })
    inprocess.wallets.set(OWNER, OWNER_SW)
    inprocess.wallets.set(ARTIST, ARTIST_SW)
    upstash.store.set(`kismetart:collection-meta:${C}`, { v: JSON.stringify({ address: C, name: 'Patron', artist: ARTIST }) })
    upstash.store.set(`kismetart:smartwallet-owner:${D_SW}`, { v: D_EOA }) // the reverse index
    await kv.addAuthorizedCreator(C, { eoa: T_EOA, smartWallet: T_SW, grantedBy: OWNER, grantedAt: 1_000 })
    await kv.addAuthorizedCreator(C, { eoa: N_EOA, smartWallet: N_SW, grantedBy: OWNER, grantedAt: 2_000 })
    const now = Date.now()
    await kv.addPendingAuthorizedCreator(C, { eoa: P_EOA, smartWallet: P_SW, grantedBy: OWNER, createdAt: now - 60_000 })
    await kv.addPendingAuthorizedCreator(C, { eoa: Q_EOA, smartWallet: Q_SW, grantedBy: OWNER, createdAt: now - 60_000 })
    await kv.addPendingAuthorizedCreator(C, { eoa: E_EOA, smartWallet: E_SW, grantedBy: OWNER, createdAt: now - 8 * DAY })
    await kv.addPendingAuthorizedCreator(C, { eoa: O_EOA, smartWallet: O_SW, grantedBy: OWNER, createdAt: now - 8 * DAY })
    await kv.addPendingAuthorizedCreator(C, { eoa: T_EOA, smartWallet: T_SW, grantedBy: OWNER, createdAt: now - 60_000 })

    const rows = await ac.listAuthorizedCreators(C)
    const byKey = new Map(rows.map((r) => [r.eoa ?? r.smartWallet, r]))
    const listed = new Set(rows.flatMap((r) => [r.eoa, r.smartWallet]).filter(Boolean))
    check('recorded creators listed by EOA; one whose wallet lost ADMIN is stale', byKey.get(T_EOA)?.liveOnChain === true && byKey.get(N_EOA)?.liveOnChain === false && !byKey.get(T_EOA)?.unmapped)
    const d = byKey.get(D_EOA)
    check('the lost save: EOA + wallet with ADMIN and no record → ONE unmapped row (reverse index)', d?.unmapped === true && d.smartWallet === D_SW && !listed.has(undefined))
    check('a holder found only in the UpdatedPermissions logs → unmapped single', byKey.get(X)?.unmapped === true && byKey.get(X)?.eoa === undefined)
    check('never listed: owner, owner wallet, deployer, deployer wallet, operator', ![OWNER, OWNER_SW, ARTIST, ARTIST_SW, OPERATOR].some((a) => listed.has(a)), [...listed])
    check('never listed: revoked (0) and MINTER-only holders, grants in flight or expired unlanded', ![R, M, Q_EOA, Q_SW, O_EOA, O_SW].some((a) => listed.has(a)))
    check('a started grant that landed a week+ ago is still recorded (the TTL only forgets unlanded ones)', byKey.get(E_EOA)?.smartWallet === E_SW && !byKey.get(E_EOA)?.unmapped)
    const p = byKey.get(P_EOA)
    check('a started grant whose wallet holds ADMIN is listed as recorded, not unmapped', p !== undefined && !p.unmapped && p.smartWallet === P_SW && p.grantedBy === OWNER)
    check('order: records newest first, then unmapped', rows.map((r) => r.eoa ?? r.smartWallet).join() === [P_EOA, E_EOA, N_EOA, T_EOA, D_EOA, X].join(), rows.map((r) => r.eoa ?? r.smartWallet))
    const stored = await kv.readAuthorizedCreators(C)
    check('…and is now in KV', stored.some((r) => r.eoa === P_EOA && r.smartWallet === P_SW))
    const left = [...(upstash.hashes.get(pendingKey(C))?.keys() ?? [])].sort()
    check('started grants: landed, already-recorded and expired-unlanded removed; in-flight kept', JSON.stringify(left) === JSON.stringify([Q_EOA]), left)
    check('the recorded grant\'s creator gets the "authorized" notification', await waitFor(() => notifsTo(P_EOA).some((z) => z.member.includes('"authorized"') && z.member.includes(OWNER))))
    check('no notification for a dropped started grant that was already recorded', notifsTo(T_EOA).length === 0)
    const scans = chain.getLogs
    await ac.listAuthorizedCreators(C)
    check('the log scan is cached: a second GET reads no logs', chain.getLogs === scans && scans === 1, { scans, now: chain.getLogs })
    check('a second GET records nothing twice', (await kv.readAuthorizedCreators(C)).filter((r) => r.eoa === P_EOA).length === 1 && notifsTo(P_EOA).length === 1)

    // ── log scan refused; pairing by forward lookup; owner wallet lookup down ──
    console.log('list: log scan refused, forward pairing, owner lookup down')
    const C2 = addr('c2')
    const OWNER2 = addr('05'), OWNER2_SW = addr('06')
    const Y_EOA = addr('81'), Y_SW = addr('82'), Z = addr('91')
    chain.owner.set(C2, OWNER2)
    setPerms(C2, [[OWNER2, 2n], [OWNER2_SW, 2n], [D_EOA, 2n], [D_SW, 2n], [Y_EOA, 2n], [Y_SW, 2n], [Z, 2n]])
    inprocess.admins.set(C2, [OWNER2, OWNER2_SW, D_EOA, D_SW, Y_EOA, Y_SW, Z])
    inprocess.failing.add(OWNER2) // the owner's wallet lookup fails…
    upstash.store.set(`kismetart:smartwallet-owner:${OWNER2_SW}`, { v: OWNER2 }) // …the reverse index still knows it
    inprocess.wallets.set(Y_EOA, Y_SW)
    chain.code.set(Y_EOA, delegated(addr('aa'))) // a 7702-delegated EOA, like the treasury
    chain.code.set(Y_SW, PROXY_CODE)
    chain.code.set(Z, PROXY_CODE)
    chain.logsRefused = true
    const rows2 = await ac.listAuthorizedCreators(C2)
    chain.logsRefused = false
    const k2 = new Map(rows2.map((r) => [r.eoa ?? r.smartWallet, r]))
    check('scan refused → inprocess\'s list still finds every holder', k2.size === 3, [...k2.keys()])
    check('an EOA + wallet the index doesn\'t know pair through a forward lookup of the EOA', k2.get(Y_EOA)?.smartWallet === Y_SW && k2.get(Y_EOA)?.unmapped === true)
    check('the reverse index pairs too', k2.get(D_EOA)?.smartWallet === D_SW)
    check('a lone contract stays single', k2.get(Z)?.unmapped === true && k2.get(Z)?.eoa === undefined)
    check('contracts are never looked up forward', !inprocess.walletLookups.has(Y_SW) && !inprocess.walletLookups.has(Z))
    check('the owner\'s wallet stays hidden when its lookup fails (reverse index)', !k2.has(OWNER2_SW) && !k2.has(OWNER2))

    // ── outages ──
    console.log('list: outages')
    const C3 = addr('c3')
    chain.owner.set(C3, OWNER)
    setPerms(C3, [[T_EOA, 2n], [T_SW, 0n], [X, 2n], [P_EOA, 2n], [P_SW, 2n]])
    inprocess.admins.set(C3, [T_EOA, T_SW, X])
    await kv.addAuthorizedCreator(C3, { eoa: T_EOA, smartWallet: T_SW, grantedBy: OWNER, grantedAt: 5 })
    await kv.addPendingAuthorizedCreator(C3, { eoa: P_EOA, smartWallet: P_SW, grantedBy: OWNER, createdAt: Date.now() })
    chain.down = true
    const rows3 = await ac.listAuthorizedCreators(C3)
    chain.down = false
    check('chain down: the records, live (no false stale), nothing unmapped', rows3.length === 1 && rows3[0].eoa === T_EOA && rows3[0].liveOnChain === true)
    check('chain down: a started grant is neither recorded nor dropped', !(await kv.readAuthorizedCreators(C3)).some((r) => r.eoa === P_EOA) && upstash.hashes.get(pendingKey(C3))?.has(P_EOA) === true)

    upstash.setFailing(true)
    const redisDown = await ac.listAuthorizedCreators(C).then(() => 'resolved', () => 'threw')
    upstash.setFailing(false)
    check('Redis down: the list throws (the route\'s 503) instead of relabelling records unmapped', redisDown === 'threw')

    const C5 = addr('c5')
    const before = { logs: chain.getLogs, calls: chain.ethCalls }
    const rows5 = await ac.listAuthorizedCreators(C5)
    check('a collection nobody knows: empty, no log query, no chain read', rows5.length === 0 && chain.getLogs === before.logs && chain.ethCalls === before.calls)

    // ── writes ──
    console.log('writes')
    const C6 = addr('c6')
    const VIEWER = OWNER, STRANGER = addr('ee')
    const S_EOA = addr('a1'), S_SW = addr('a2')
    const F_EOA = addr('b1'), F_SW = addr('b2')
    const G_EOA = addr('b3'), G_SW = addr('b4')
    chain.owner.set(C6, VIEWER)
    setPerms(C6, [[VIEWER, 2n]])
    inprocess.wallets.set(S_EOA, S_SW)
    const stranger = await ac.startCreatorGrant(STRANGER, { collection: C6, eoa: S_EOA, smartWallet: S_SW })
    check('start: a non-admin is refused (403)', !stranger.ok && stranger.status === 403)
    const wrong = await ac.startCreatorGrant(VIEWER, { collection: C6, eoa: S_EOA, smartWallet: addr('a9') })
    check('start: a wallet that isn\'t the EOA\'s is refused (400) before anything is sent', !wrong.ok && wrong.status === 400 && !upstash.hashes.get(pendingKey(C6))?.has(S_EOA))
    const started = await ac.startCreatorGrant(VIEWER, { collection: C6, eoa: S_EOA, smartWallet: S_SW, label: ' s.eth ' })
    check('start: an admin records the started grant (verified mapping, trimmed label)', started.ok && started.value.label === 's.eth' && upstash.hashes.get(pendingKey(C6))?.has(S_EOA) === true)

    await kv.addPendingAuthorizedCreator(C6, { eoa: F_EOA, smartWallet: F_SW, grantedBy: VIEWER, createdAt: Date.now() })
    inprocess.failing.add(F_EOA)
    inprocess.failing.add(G_EOA)
    const savedF = await ac.saveCreatorGrant(VIEWER, { collection: C6, eoa: F_EOA, smartWallet: F_SW })
    check('save: a started grant\'s mapping is trusted while inprocess is down', savedF.ok && (await kv.readAuthorizedCreators(C6)).some((r) => r.eoa === F_EOA) && !upstash.hashes.get(pendingKey(C6))?.has(F_EOA))
    const savedG = await ac.saveCreatorGrant(VIEWER, { collection: C6, eoa: G_EOA, smartWallet: G_SW })
    check('save: with no started grant, inprocess down is a retryable 502, nothing recorded', !savedG.ok && savedG.status === 502 && !(await kv.readAuthorizedCreators(C6)).some((r) => r.eoa === G_EOA))

    const savedS1 = await ac.saveCreatorGrant(VIEWER, { collection: C6, eoa: S_EOA, smartWallet: S_SW })
    const savedS2 = await ac.saveCreatorGrant(VIEWER, { collection: C6, eoa: S_EOA, smartWallet: S_SW })
    await waitFor(() => notifsTo(S_EOA).length > 0)
    await new Promise((r) => setTimeout(r, 100))
    const sRows = (await kv.readAuthorizedCreators(C6)).filter((r) => r.eoa === S_EOA)
    check('save: the started grant\'s label carries over', savedS1.ok && savedS1.value.label === 's.eth')
    check('save twice (a retry): one record, one notification', savedS2.ok && latestPerEoa(sRows).length === 1 && notifsTo(S_EOA).length === 1, { records: sRows.length, notifs: notifsTo(S_EOA).length })

    await kv.addPendingAuthorizedCreator(C6, { eoa: S_EOA, smartWallet: S_SW, grantedBy: VIEWER, createdAt: Date.now() })
    const deniedDrop = await ac.dropCreatorGrant(STRANGER, C6, S_EOA)
    check('drop: a non-admin is refused (403)', !deniedDrop.ok && deniedDrop.status === 403)
    const dropped = await ac.dropCreatorGrant(VIEWER, C6, S_EOA)
    check('drop: clears the record and any started grant', dropped.ok && !(await kv.readAuthorizedCreators(C6)).some((r) => r.eoa === S_EOA) && !upstash.hashes.get(pendingKey(C6))?.has(S_EOA))

    // ── KV dedupe: concurrent writers converge on the newest record ──
    const C7 = addr('c7')
    await kv.addAuthorizedCreator(C7, { eoa: T_EOA, smartWallet: T_SW, grantedBy: OWNER, grantedAt: 200 })
    await kv.addAuthorizedCreator(C7, { eoa: T_EOA, smartWallet: T_SW, grantedBy: OWNER, grantedAt: 100 })
    const c7 = await kv.readAuthorizedCreators(C7)
    check('kv: an older write never removes a newer record', c7.some((r) => r.grantedAt === 200))
    check('kv: an older write landing second cleans itself up (one row left)', c7.length === 1, c7.map((r) => r.grantedAt))
    await kv.addAuthorizedCreator(C7, { eoa: T_EOA, smartWallet: T_SW, grantedBy: OWNER, grantedAt: 300 })
    const c7b = await kv.readAuthorizedCreators(C7)
    check('kv: a newer write removes every older record', c7b.length === 1 && c7b[0].grantedAt === 300)
  } finally {
    stop()
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall authorized-creators checks passed')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
