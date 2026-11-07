/**
 * Claim drops end to end, through the REAL route handlers, in one process:
 * an artist uploads and opens a drop, collectors claim it, the window closes,
 * the artist delivers it (prepare → mint → airdrop → verified record), and
 * the reminder job and the collector's "your claims" read see each state.
 *
 * Real: every route handler and library on the way (signatures checked by
 * viem against EIP-712 signatures from real keys, intent nonces, sessions,
 * quotas, rate limits, the claim reservation's Lua, the settle lock and
 * progress, the mint proxy, the settlement's on-chain verification and
 * matchAirdropTx), on a REAL redis-server behind an Upstash-REST front
 * (_upstash-redis.ts).
 *
 * Local stand-ins, each at the edge where the app leaves the process:
 *   Bee (Swarm)       a spec-faithful HTTP mock: POST /bzz, GET /bzz/<ref>/,
 *                     GET /stamps/<id>; content-addressed references.
 *   In Process relay  POST /moment/create answers like the relay does
 *                     ({ contractAddress, tokenId, hash }) and records the
 *                     body it was sent.
 *   Base              a JSON-RPC mock: blocks, Zora getTokenInfo, receipts and
 *                     logs for the airdrop the harness "sends" (TransferSingle
 *                     events encoded by viem, exactly as the chain emits them).
 *   Arkiv, Arweave    module-boundary doubles (drops-flow-hooks.mjs). The real
 *                     Arkiv queries run against Rabdi in drops-arkiv-live.ts.
 *
 * The clock is moved (Date.now) to close the window and to reach the
 * reminder points; Redis TTLs stay on real time, which the moves never cross.
 *
 * Run (redis-server on PATH):
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
 *     --import ./scripts/e2e/register-drops-flow.mjs scripts/e2e/drops-flow.ts
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  numberToHex,
  zeroAddress,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { startRealRedis } from './_upstash-redis.ts'

// ───────────────────────── runner ─────────────────────────

let passed = 0
let failed = 0
function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}
const section = (s: string) => console.log(`\n${s}`)

// ───────────────────────── clock ─────────────────────────

let offsetMs = 0
const realNow = Date.now.bind(Date)
Date.now = () => realNow() + offsetMs
const advance = (seconds: number) => {
  offsetMs += seconds * 1000
}

// ───────────────────────── fixtures ─────────────────────────

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const artist = privateKeyToAccount(generatePrivateKey())
const stranger = privateKeyToAccount(generatePrivateKey())
const collectors = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()))
const heir = privateKeyToAccount(generatePrivateKey()) // a claim is handed to this wallet
const COLLECTION = getAddress(`0x${'c0'.repeat(20)}`)
const TOKEN_ID = 7n

// ───────────────────────── Bee mock ─────────────────────────

function startBee(): Promise<{ url: string; uploads: { name: string; batch: string; deferred: string; pin: string }[] }> {
  const files = new Map<string, { body: Buffer; type: string }>()
  const uploads: { name: string; batch: string; deferred: string; pin: string }[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://bee')
      if (req.method === 'POST' && url.pathname === '/bzz') {
        const batch = String(req.headers['swarm-postage-batch-id'] ?? '')
        if (!/^[0-9a-f]{64}$/.test(batch)) {
          res.writeHead(400).end(JSON.stringify({ message: 'invalid batch id' }))
          return
        }
        const body = Buffer.concat(chunks)
        const reference = createHash('sha256').update(body).digest('hex')
        files.set(reference, { body, type: String(req.headers['content-type']) })
        uploads.push({
          name: url.searchParams.get('name') ?? '',
          batch,
          deferred: String(req.headers['swarm-deferred-upload']),
          pin: String(req.headers['swarm-pin']),
        })
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ reference }))
        return
      }
      const m = url.pathname.match(/^\/bzz\/([0-9a-f]{64})\/$/)
      if (req.method === 'GET' && m && files.has(m[1])) {
        const f = files.get(m[1])!
        res.writeHead(200, { 'content-type': f.type, 'content-length': String(f.body.length) }).end(f.body)
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith('/stamps/')) {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ batchID: url.pathname.slice(8), usable: true, utilization: 0, depth: 20, batchTTL: 30 * 86400 }))
        return
      }
      res.writeHead(404).end()
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, uploads })),
  )
}

// ───────────────────────── In Process relay mock ─────────────────────────

const RELAY_CREATE = 'moment/create'

function startRelay(): Promise<{ url: string; mints: Record<string, unknown>[] }> {
  const mints: Record<string, unknown>[] = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      // The relay's endpoint (lib/mint-proxy posts to `${INPROCESS_API}/moment/create`).
      if (req.method === 'POST' && req.url === `/${RELAY_CREATE}`) {
        mints.push(JSON.parse(body) as Record<string, unknown>)
        chain.setToken(COLLECTION, TOKEN_ID, BigInt(((mints.at(-1)!.token as { maxSupply: number }).maxSupply)))
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ contractAddress: COLLECTION, tokenId: TOKEN_ID.toString(), hash: `0x${'aa'.repeat(32)}` }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, mints })),
  )
}

// ───────────────────────── Base JSON-RPC mock ─────────────────────────

const TOKEN_INFO_ABI = [
  {
    name: 'getTokenInfo',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'uri', type: 'string' },
          { name: 'maxSupply', type: 'uint256' },
          { name: 'totalMinted', type: 'uint256' },
        ],
      },
    ],
  },
] as const
const TRANSFER_SINGLE = {
  type: 'event',
  name: 'TransferSingle',
  inputs: [
    { name: 'operator', type: 'address', indexed: true },
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'id', type: 'uint256', indexed: false },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const

interface RpcLog {
  address: string
  topics: Hex[]
  data: Hex
  blockNumber: Hex
  transactionHash: Hex
  transactionIndex: Hex
  blockHash: Hex
  logIndex: Hex
  removed: false
}

const chain = (() => {
  let head = 30_000_000n
  const tokens = new Map<string, { maxSupply: bigint; totalMinted: bigint }>()
  const txs = new Map<string, { block: bigint; logs: RpcLog[]; status: '0x1' | '0x0'; from: string; to: string }>()
  const blockHash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex
  let txSeq = 0

  function send(p: { to: string; from: string; tokenId: bigint; recipients: string[]; operator: string; status?: '0x1' | '0x0' }): Hex {
    head += 1n
    const hash = `0x${(++txSeq).toString(16).padStart(64, 'e')}` as Hex
    const logs = p.recipients.map((to, i) => ({
      address: p.to.toLowerCase(),
      topics: encodeEventTopics({ abi: [TRANSFER_SINGLE], eventName: 'TransferSingle', args: { operator: p.operator as Hex, from: zeroAddress, to: to as Hex } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [p.tokenId, 1n]),
      blockNumber: numberToHex(head),
      transactionHash: hash,
      transactionIndex: '0x0' as Hex,
      blockHash: blockHash(head),
      logIndex: numberToHex(i),
      removed: false as const,
    }))
    const status = p.status ?? '0x1'
    txs.set(hash, { block: head, logs: status === '0x1' ? logs : [], status, from: p.from, to: p.to })
    const t = tokens.get(p.to.toLowerCase())
    if (t && status === '0x1') t.totalMinted += BigInt(p.recipients.length)
    return hash
  }

  function rpc(method: string, params: unknown[]): unknown {
    switch (method) {
      case 'eth_chainId':
        return '0x2105'
      case 'eth_blockNumber':
        return numberToHex(head)
      case 'eth_call': {
        const { to, data } = params[0] as { to: string; data: Hex }
        const t = tokens.get(to.toLowerCase())
        if (!t) throw Object.assign(new Error('execution reverted'), { code: 3 })
        const { args } = decodeFunctionData({ abi: TOKEN_INFO_ABI, data })
        if (args[0] !== TOKEN_ID) throw Object.assign(new Error('execution reverted'), { code: 3 })
        return encodeFunctionResult({ abi: TOKEN_INFO_ABI, functionName: 'getTokenInfo', result: { uri: 'ar://x', maxSupply: t.maxSupply, totalMinted: t.totalMinted } })
      }
      case 'eth_getTransactionReceipt': {
        const tx = txs.get(String(params[0]).toLowerCase())
        if (!tx) return null
        return {
          transactionHash: params[0],
          blockHash: blockHash(tx.block),
          blockNumber: numberToHex(tx.block),
          transactionIndex: '0x0',
          from: tx.from,
          to: tx.to,
          status: tx.status,
          logs: tx.logs,
          gasUsed: '0x5208',
          cumulativeGasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logsBloom: `0x${'00'.repeat(256)}`,
          type: '0x2',
        }
      }
      case 'eth_getLogs': {
        const f = params[0] as { address?: string; topics?: (Hex | null)[]; fromBlock?: Hex | 'latest'; toBlock?: Hex | 'latest' }
        const from = f.fromBlock && f.fromBlock !== 'latest' ? BigInt(f.fromBlock) : 0n
        const to = f.toBlock && f.toBlock !== 'latest' ? BigInt(f.toBlock) : head
        return [...txs.values()]
          .filter((tx) => tx.block >= from && tx.block <= to)
          .flatMap((tx) => tx.logs)
          .filter((l) => !f.address || l.address === f.address.toLowerCase())
          .filter((l) => (f.topics ?? []).every((t, i) => t === null || t === undefined || l.topics[i]?.toLowerCase() === t.toLowerCase()))
      }
      default:
        throw Object.assign(new Error(`method ${method} not modelled`), { code: -32601 })
    }
  }

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const one = (m: { id: number; method: string; params: unknown[] }) => {
        try {
          return { jsonrpc: '2.0', id: m.id, result: rpc(m.method, m.params ?? []) }
        } catch (err) {
          const e = err as { code?: number; message: string }
          return { jsonrpc: '2.0', id: m.id, error: { code: e.code ?? -32000, message: e.message } }
        }
      }
      const parsed = JSON.parse(body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)))
    })
  })
  const ready = new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  )
  return {
    ready,
    head: () => head,
    setToken: (collection: string, _tokenId: bigint, maxSupply: bigint) => tokens.set(collection.toLowerCase(), { maxSupply, totalMinted: 0n }),
    token: (collection: string) => tokens.get(collection.toLowerCase()),
    send,
    close: () => server.close(),
  }
})()

// ───────────────────────── boot ─────────────────────────

const redis = await startRealRedis()
const bee = await startBee()
const relay = await startRelay()
const chainUrl = await chain.ready

Object.assign(process.env, {
  UPSTASH_REDIS_REST_URL: redis.url,
  UPSTASH_REDIS_REST_TOKEN: 'local',
  DROPS_ENABLED: '1',
  ARKIV_WRITER_PRIVATE_KEY: generatePrivateKey(),
  SWARM_BEE_URL: bee.url,
  SWARM_BATCH_ID: `0x${'AB'.repeat(32)}`,
  INPROCESS_API_URL: relay.url,
  INPROCESS_API_KEY: 'local',
  BASE_RPC_URL: chainUrl,
})

const { NextRequest } = await import('next/server')
const { createSession, SESSION_COOKIE } = await import('@/lib/session')
const { KISMET_INTENT_DOMAIN, MINT_INTENT_TYPES, buildMintIntent } = await import('@/lib/intent')
const drops = await import('@/lib/drops')
const { reserveClaim } = await import('@/lib/dropsStore')
const { sendDropNotices } = await import('@/lib/dropNotices')
const { arkiv } = await import('./_arkiv-memory.ts')
const { writerFunds } = await import('./_arkiv-client.ts')
const { arweaveUploads } = await import('./_arweave-memory.ts')
const routes = {
  nonce: await import('@/app/api/auth/intent-nonce/route'),
  drops: await import('@/app/api/drops/route'),
  media: await import('@/app/api/drops/media/route'),
  claims: await import('@/app/api/drops/claims/route'),
  detail: await import('@/app/api/drops/[key]/route'),
  art: await import('@/app/api/drops/[key]/media/route'),
  claim: await import('@/app/api/drops/[key]/claim/route'),
  prepare: await import('@/app/api/drops/[key]/settle/prepare/route'),
  mint: await import('@/app/api/drops/[key]/settle/mint/route'),
  settle: await import('@/app/api/drops/[key]/settle/route'),
}

// ───────────────────────── request helpers ─────────────────────────

type Handler = (req: InstanceType<typeof NextRequest>, ctx: { params: Promise<{ key: string }> }) => Promise<Response>
let ipSeq = 0
function request(path: string, opts: { method?: string; body?: unknown; session?: string; contentType?: string; ip?: string } = {}) {
  const headers = new Headers({ 'x-forwarded-for': opts.ip ?? `10.0.0.${++ipSeq % 250}` })
  if (opts.session) headers.set('cookie', `${SESSION_COOKIE}=${opts.session}`)
  let body: BodyInit | undefined
  if (opts.body instanceof Uint8Array) {
    body = opts.body
    headers.set('content-type', opts.contentType ?? 'application/octet-stream')
    headers.set('content-length', String(opts.body.byteLength))
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
    headers.set('content-type', 'application/json')
  }
  return new NextRequest(new URL(path, 'http://localhost:3000'), { method: opts.method ?? 'GET', headers, body })
}
async function call(handler: unknown, req: InstanceType<typeof NextRequest>, key?: string) {
  const res = await (handler as Handler)(req, { params: Promise.resolve({ key: key ?? '' }) })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {}
  return { status: res.status, json, headers: res.headers, text }
}

async function intent(sign: (nonce: string, expiresAt: number) => Promise<Hex>) {
  const { json } = await call(routes.nonce.POST, request('/api/auth/intent-nonce', { method: 'POST' }))
  const nonce = String(json.nonce)
  const expiresAt = Number(json.expiresAt)
  return { signature: await sign(nonce, expiresAt), nonce, expiresAt }
}
const claimIntent = (who: PrivateKeyAccount, dropKey: string) =>
  intent((nonce, expiresAt) =>
    who.signTypedData({
      domain: KISMET_INTENT_DOMAIN,
      types: drops.CLAIM_DROP_TYPES,
      primaryType: 'ClaimDrop',
      message: drops.buildClaimDropMessage(who.address, dropKey, nonce, expiresAt),
    }),
  )
async function claimAs(who: PrivateKeyAccount, dropKey: string) {
  return call(routes.claim.POST, request(`/api/drops/${dropKey}/claim`, { method: 'POST', body: { account: who.address, intent: await claimIntent(who, dropKey) } }), dropKey)
}

/** Upload the artwork and sign the OpenDrop intent — everything the form does before it POSTs. */
async function signOpen(session: string, title: string, opts: { maxClaims?: number; windowSeconds?: number } = {}) {
  const up = await call(routes.media.POST, request('/api/drops/media', { method: 'POST', body: new Uint8Array(PNG), contentType: 'image/png', session }))
  const now = Math.floor(Date.now() / 1000)
  const validated = drops.validateOpenDrop(
    {
      title,
      description: 'A drop opened by scripts/e2e/drops-flow.ts.',
      swarmRef: up.json.reference,
      mime: up.json.mime,
      closesAt: now + (opts.windowSeconds ?? drops.DROP_MIN_WINDOW_SECONDS),
      maxClaims: opts.maxClaims ?? 10,
    },
    now,
  )
  if (!validated.ok) throw new Error(validated.error)
  const fields = validated.value
  const signed = await intent((nonce, expiresAt) =>
    artist.signTypedData({
      domain: KISMET_INTENT_DOMAIN,
      types: drops.OPEN_DROP_TYPES,
      primaryType: 'OpenDrop',
      message: drops.buildOpenDropMessage(artist.address, fields, nonce, expiresAt),
    }),
  )
  return { up, fields, signed }
}

async function openDrop(session: string, title: string, opts: { maxClaims?: number; windowSeconds?: number } = {}) {
  const { up, fields, signed } = await signOpen(session, title, opts)
  const opened = await call(routes.drops.POST, request('/api/drops', { method: 'POST', body: { account: artist.address, ...fields, intent: signed } }))
  return { up, fields, signed, opened, key: String(opened.json.key) }
}

// ───────────────────────── the flow ─────────────────────────

try {
  const artistSession = await createSession(artist.address)
  const strangerSession = await createSession(stranger.address)

  section('upload and open')
  const noSession = await call(routes.media.POST, request('/api/drops/media', { method: 'POST', body: new Uint8Array(PNG), contentType: 'image/png' }))
  ok(noSession.status === 401, 'an upload without a session is refused', noSession.status)
  const lying = await call(routes.media.POST, request('/api/drops/media', { method: 'POST', body: new Uint8Array(PNG), contentType: 'image/jpeg', session: artistSession }))
  ok(lying.status === 415, 'a file that is not the type it claims is refused', lying.status)

  const a = await openDrop(artistSession, 'Dawn')
  ok(a.up.status === 200 && drops.isSwarmRef(String(a.up.json.reference)), 'the artwork uploads to Swarm and returns its reference', a.up.json)
  const beeUpload = bee.uploads.at(-1)!
  ok(beeUpload.batch === 'ab'.repeat(32) && beeUpload.deferred === 'false' && beeUpload.pin === 'true',
    'Bee got the batch (lowercased, no 0x), a direct upload, pinned', beeUpload)
  ok(a.opened.status === 200 && drops.isEntityKey(a.key), 'the drop opens with one signature', a.opened.json)
  const dropEntity = arkiv.entities.get(a.key)!
  ok(dropEntity.owner === artist.address.toLowerCase() && dropEntity.creator !== dropEntity.owner,
    'the drop entity is written by Kismet and handed to the artist')

  const replay = await call(routes.drops.POST, request('/api/drops', { method: 'POST', body: { account: artist.address, ...a.fields, intent: a.signed } }))
  ok(replay.status === 401 || replay.status === 400, 'replaying the open signature is refused (single-use nonce)', replay)
  const t = await signOpen(artistSession, 'Dawn')
  const tampered = await call(routes.drops.POST, request('/api/drops', { method: 'POST', body: { account: artist.address, ...t.fields, maxClaims: t.fields.maxClaims + 1, intent: t.signed } }))
  ok(tampered.status === 401, 'changing a term after signing breaks the signature', tampered)

  writerFunds.funded = false
  const unfunded = await openDrop(artistSession, 'Broke')
  ok(unfunded.opened.status === 503 && /paused/i.test(String(unfunded.opened.json.error)), 'an unfunded Arkiv writer pauses opening, with a clear message', unfunded.opened.json)
  writerFunds.funded = true

  section('claims')
  const c0 = await claimAs(collectors[0], a.key)
  ok(c0.status === 200 && drops.isEntityKey(String(c0.json.claimKey)), 'a collector claims with one signature', c0.json)
  ok(arkiv.entities.get(String(c0.json.claimKey))?.owner === collectors[0].address.toLowerCase(), 'the claim entity is handed to the collector')
  const again = await claimAs(collectors[0], a.key)
  ok(again.status === 200 && again.json.already === true, 'claiming twice from one wallet answers "already claimed"', again.json)
  const byArtist = await claimAs(artist, a.key)
  ok(byArtist.status === 400, 'the artist cannot claim their own drop', byArtist)
  writerFunds.funded = false
  const paused = await claimAs(collectors[1], a.key)
  ok(paused.status === 503, 'an unfunded writer pauses claims without spending a slot', paused)
  writerFunds.funded = true
  const c1 = await claimAs(collectors[1], a.key)
  const c2 = await claimAs(collectors[2], a.key)
  ok(c1.status === 200 && c2.status === 200, 'the paused collector (and another) claim once the writer is funded', [c1.status, c2.status])

  const signedForA = await claimIntent(stranger, a.key)
  const wrongDrop = await call(routes.claim.POST, request(`/api/drops/${a.key}/claim`, { method: 'POST', body: { account: collectors[0].address, intent: signedForA } }), a.key)
  ok(wrongDrop.status === 401, 'a signature from another wallet does not claim for this one', wrongDrop)

  section('the reservation (real Redis Lua)')
  const probe = `0x${'5e'.repeat(32)}` as Hex
  const closes = Math.floor(realNow() / 1000) + 600
  const w = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`)
  ok((await reserveClaim(probe, w(1), 101, 2, closes)) === 'reserved', 'first wallet of a Farcaster account reserves')
  ok((await reserveClaim(probe, w(2), 101, 2, closes)) === 'account-claimed', 'a second wallet of the same Farcaster account is refused')
  ok((await reserveClaim(probe, w(3), null, 2, closes)) === 'reserved', 'a web claim (no Farcaster account) reserves on its wallet')
  ok((await reserveClaim(probe, w(4), 102, 2, closes)) === 'full', 'the cap holds — a full drop reserves nothing')
  ok((await reserveClaim(probe, w(1), 101, 2, closes)) === 'duplicate', 'the same wallet again is a duplicate, not "full"')
  const ttl = Number(await redis.command(['TTL', `kismetart:drops:claims:${probe}`]))
  ok(ttl > 0 && ttl <= 600, 'the reservation set expires at the drop\'s close', ttl)
  const fidsOnFull = await redis.command(['SISMEMBER', `kismetart:drops:fids:${probe}`, '102'])
  ok(fidsOnFull === 0, 'a refused reservation writes nothing')

  section('reads while open')
  const detail = await call(routes.detail.GET, request(`/api/drops/${a.key}?viewer=${collectors[0].address}`), a.key)
  const d = detail.json.drop as { claimCount: number; delivered: boolean }
  ok(detail.status === 200 && d.claimCount === 3 && detail.json.viewerClaimed === true && detail.json.settlement === null,
    'the drop page reads 3 claims, the viewer\'s own, no settlement yet', detail.json)
  const feed = await call(routes.drops.GET, request('/api/drops'))
  ok(((feed.json.open as { key: string }[]) ?? []).some((x) => x.key === a.key), 'the drop is in the open feed')
  const art = await call(routes.art.GET, request(`/api/drops/${a.key}/media`), a.key)
  ok(art.status === 200 && art.headers.get('content-type') === 'image/png' && art.headers.get('x-content-type-options') === 'nosniff',
    'the artwork streams from Swarm with its type and nosniff')
  const mine = await call(routes.claims.GET, request(`/api/drops/claims?owner=${collectors[1].address}`))
  const mineRows = mine.json.claims as { dropKey: string; settlement: unknown }[]
  ok(mine.status === 200 && mineRows.length === 1 && mineRows[0].dropKey === a.key && mineRows[0].settlement === null,
    'a collector\'s claims list shows the drop, not yet delivered', mine.json)

  // A collector hands their claim to another wallet before the drop closes:
  // the edition goes to whoever owns the claim.
  arkiv.transfer(String(c2.json.claimKey), heir.address)

  section('close')
  const b = await openDrop(artistSession, 'Dusk', { windowSeconds: drops.DROP_MIN_WINDOW_SECONDS + 60 })
  await claimAs(collectors[0], b.key)
  const empty = await openDrop(artistSession, 'Nobody came', { windowSeconds: drops.DROP_MIN_WINDOW_SECONDS + 30 })
  advance(drops.DROP_MIN_WINDOW_SECONDS + 120)
  const late = await claimAs(collectors[1], b.key)
  ok(late.status === 409, 'a claim after the window closes is refused', late)

  section('deliver — prepare')
  const early = await call(routes.prepare.POST, request(`/api/drops/${a.key}/settle/prepare`, { method: 'POST', body: {}, session: strangerSession }), a.key)
  ok(early.status === 403, 'only the artist can prepare the delivery', early)
  const noClaims = await call(routes.prepare.POST, request(`/api/drops/${empty.key}/settle/prepare`, { method: 'POST', body: {}, session: artistSession }), empty.key)
  ok(noClaims.status === 409, 'a drop nobody claimed has nothing to deliver', noClaims)
  const prep = await call(routes.prepare.POST, request(`/api/drops/${a.key}/settle/prepare`, { method: 'POST', body: {}, session: artistSession }), a.key)
  const body = prep.json.body as { account: string; token: Record<string, unknown>; contract: { name: string; uri: string } }
  const recipients = prep.json.recipients as string[]
  const expected = [collectors[0], collectors[1], heir].map((x) => x.address.toLowerCase())
  ok(prep.status === 200, 'the artist prepares the delivery', prep.json)
  ok(recipients.length === 4 && expected.every((x) => recipients.includes(x)) && recipients.at(-1) === artist.address.toLowerCase()
    && !recipients.includes(collectors[2].address.toLowerCase()),
  'recipients: each claim\'s current owner (the handed-off claim goes to its new owner), then the artist', recipients)
  ok(body.token.maxSupply === 4 && body.token.mintToCreatorCount === 0, 'the edition is sized to the recipients, no relay copy', body.token)
  const sale = body.token.salesConfig as Record<string, string>
  ok(sale.saleEnd === '1' && sale.pricePerToken === '0' && sale.type === 'fixedPrice', 'its sale is closed at creation — nobody else can mint it', sale)
  ok(body.contract.name === 'Dawn' && body.contract.uri.startsWith('ar://'), 'a new collection named after the drop, metadata on Arweave', body.contract)
  const media = arweaveUploads.find((u) => u.contentType === 'image/png')
  ok(!!media && media.bytes.equals(PNG), 'the artwork was copied from Swarm to Arweave byte-for-byte')
  const uploadsBefore = arweaveUploads.length
  const prep2 = await call(routes.prepare.POST, request(`/api/drops/${a.key}/settle/prepare`, { method: 'POST', body: {}, session: artistSession }), a.key)
  ok(JSON.stringify(prep2.json.body) === JSON.stringify(body) && arweaveUploads.length === uploadsBefore,
    'preparing again returns the same mint and uploads nothing twice')

  section('deliver — mint')
  const mintIntent = await intent((nonce, expiresAt) =>
    artist.signTypedData({ domain: KISMET_INTENT_DOMAIN, types: MINT_INTENT_TYPES, primaryType: 'MintIntent', message: buildMintIntent(body, 'mint', nonce, expiresAt) }),
  )
  const strangerMint = await call(routes.mint.POST, request(`/api/drops/${a.key}/settle/mint`, { method: 'POST', body: { intent: mintIntent }, session: strangerSession }), a.key)
  ok(strangerMint.status === 403 && relay.mints.length === 0, 'only the artist can mint the edition', strangerMint)
  const minted = await call(routes.mint.POST, request(`/api/drops/${a.key}/settle/mint`, { method: 'POST', body: { intent: mintIntent }, session: artistSession }), a.key)
  ok(minted.status === 200 && minted.json.collection === COLLECTION.toLowerCase() && minted.json.tokenId === TOKEN_ID.toString(),
    'the artist\'s one signature mints the edition through the relay', minted.json)
  const sent = relay.mints[0] as { account: string; token: Record<string, unknown> }
  ok(relay.mints.length === 1 && JSON.stringify(sent.token.salesConfig) === JSON.stringify(sale) && sent.token.maxSupply === 4
    && sent.account.toLowerCase() === artist.address.toLowerCase(), 'the relay received exactly the prepared body', sent)
  const mintAgain = await call(routes.mint.POST, request(`/api/drops/${a.key}/settle/mint`, { method: 'POST', body: { intent: mintIntent }, session: artistSession }), a.key)
  ok(mintAgain.status === 200 && relay.mints.length === 1, 'minting again returns the same token — never a second edition', mintAgain.json)
  const prep3 = await call(routes.prepare.POST, request(`/api/drops/${a.key}/settle/prepare`, { method: 'POST', body: {}, session: artistSession }), a.key)
  ok((prep3.json.minted as { tokenId?: string } | null)?.tokenId === TOKEN_ID.toString(), 'a later visit resumes at the airdrop')

  section('deliver — airdrop and record')
  const notYet = await call(routes.settle.POST, request(`/api/drops/${a.key}/settle`, { method: 'POST', body: {}, session: artistSession }), a.key)
  ok(notYet.status === 200 && notYet.json.delivered === false, 'before the airdrop, the chain says not delivered yet', notYet.json)
  const partial = chain.send({ to: COLLECTION, from: artist.address, operator: artist.address, tokenId: TOKEN_ID, recipients: recipients.slice(0, 3) })
  const short = await call(routes.settle.POST, request(`/api/drops/${a.key}/settle`, { method: 'POST', body: { txHash: partial }, session: artistSession }), a.key)
  ok(short.status === 409, 'an airdrop that misses a recipient does not settle the drop', short)
  const foreign = chain.send({ to: COLLECTION, from: stranger.address, operator: stranger.address, tokenId: TOKEN_ID, recipients })
  const notArtist = await call(routes.settle.POST, request(`/api/drops/${a.key}/settle`, { method: 'POST', body: { txHash: foreign }, session: artistSession }), a.key)
  ok(notArtist.status === 409, 'an airdrop by anyone but the artist does not settle the drop', notArtist)
  // Reset the supply the two rejected sends consumed; the real one follows.
  chain.setToken(COLLECTION, TOKEN_ID, 4n)
  const airdrop = chain.send({ to: COLLECTION, from: artist.address, operator: artist.address, tokenId: TOKEN_ID, recipients })
  // The artist closes the tab here: the next visit finds the airdrop on chain.
  const resumed = await call(routes.settle.POST, request(`/api/drops/${a.key}/settle`, { method: 'POST', body: {}, session: artistSession }), a.key)
  ok(resumed.status === 200 && resumed.json.delivered === true, 'an interrupted delivery resumes from the chain and records itself', resumed.json)
  const settlements = [...arkiv.entities.values()].filter((e) => e.kind === 'settlement')
  ok(settlements.length === 1 && settlements[0].values.airdropTx === airdrop && settlements[0].owner === artist.address.toLowerCase(),
    'one settlement entity, naming the real airdrop, handed to the artist', settlements.map((s) => s.values))
  const twice = await call(routes.settle.POST, request(`/api/drops/${a.key}/settle`, { method: 'POST', body: { txHash: airdrop }, session: artistSession }), a.key)
  ok(twice.status === 200 && twice.json.delivered === true && [...arkiv.entities.values()].filter((e) => e.kind === 'settlement').length === 1,
    'recording again is a no-op that answers delivered')
  const prepAfter = await call(routes.prepare.POST, request(`/api/drops/${a.key}/settle/prepare`, { method: 'POST', body: {}, session: artistSession }), a.key)
  ok(prepAfter.status === 409, 'a delivered drop cannot be prepared again', prepAfter)

  section('reads after delivery')
  const after = await call(routes.detail.GET, request(`/api/drops/${a.key}?viewer=${heir.address}`), a.key)
  const s = after.json.settlement as { collection: string; tokenId: string; airdropTx: string; recipients: number } | null
  ok(!!s && s.collection === COLLECTION.toLowerCase() && s.tokenId === TOKEN_ID.toString() && s.recipients === 4 && (after.json.drop as { delivered: boolean }).delivered,
    'the drop page links the delivered Base token', after.json.settlement)
  ok(after.json.viewerClaimed === true, 'the wallet the claim was handed to sees it as theirs')
  const feedAfter = await call(routes.drops.GET, request('/api/drops'))
  const settling = feedAfter.json.settling as { key: string; delivered: boolean }[]
  ok(settling.find((x) => x.key === a.key)?.delivered === true && settling.find((x) => x.key === b.key)?.delivered === false,
    'the feed marks the delivered drop, and only it', settling)
  const heirClaims = await call(routes.claims.GET, request(`/api/drops/claims?owner=${heir.address}`))
  ok((heirClaims.json.claims as { settlement: { tokenId: string } | null }[])[0]?.settlement?.tokenId === TOKEN_ID.toString(),
    'the claims list shows it delivered, with its token')
  const giver = await call(routes.claims.GET, request(`/api/drops/claims?owner=${collectors[2].address}`))
  ok((giver.json.claims as unknown[]).length === 0, 'the collector who handed their claim away no longer lists it')

  section('reminders')
  const sentNow = await sendDropNotices()
  const inbox = async () => (await redis.command(['ZRANGE', `kismetart:notif:${artist.address.toLowerCase()}`, '0', '-1'])) as string[]
  // The inbox also holds the ordinary "minted" notice the mint proxy wrote.
  const notes = async () =>
    (await inbox()).map((m) => JSON.parse(m) as { type: string; note: string; dropKey: string; amount: number }).filter((x) => x.type === 'drop_status')
  ok((await inbox()).some((m) => (JSON.parse(m) as { type: string }).type === 'mint'), 'the mint proxy\'s own post-mint work ran (the artist\'s "minted" notice)')
  let n = await notes()
  ok(sentNow === 1 && n.length === 1 && n[0].type === 'drop_status' && n[0].note === 'closed' && n[0].dropKey === b.key && n[0].amount === 1,
    'one "closed — deliver it" notice, for the undelivered drop with claims only', { sentNow, n })
  ok((await sendDropNotices()) === 0, 'the next tick sends nothing again')
  advance(drops.SETTLE_GRACE_SECONDS - drops.EXPIRY_WARNING_SECONDS + 3600)
  ok((await sendDropNotices()) === 1, 'two days before its claims expire, a last-chance notice')
  n = await notes()
  ok(n.some((x) => x.note === 'expiring' && x.dropKey === b.key) && !n.some((x) => x.dropKey === a.key || x.dropKey === empty.key),
    'never for the delivered drop or the one nobody claimed', n)
  ok((await sendDropNotices()) === 0, 'and only once')
} catch (err) {
  failed++
  console.error('\nharness error:', err)
} finally {
  redis.close()
  chain.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
