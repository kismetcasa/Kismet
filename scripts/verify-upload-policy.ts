// Verifies lib/arweave/uploadFile — the media-upload policy behind the 2026-10-20 stall
// ("Uploading media… 95%" climbing and starting over for half an hour):
//   1. once the finalize request is sent no new data item is made, however Turbo answers;
//   2. Turbo gets 15 minutes to confirm, and a request that never answers still ends;
//   3. a slow but moving upload has no time limit, and failures before finalize are
//      retried within five signings;
//   4. uploads running at once stay apart, and every error is one line.
// It drives the real modules (uploadToArweave, as every caller does, and uploadFile) and the
// real @ardrive/turbo-sdk web build against a mock of Turbo and /api/sign on a scaled clock.
//
// Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-upload-policy.ts

import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

// Date.now and setTimeout scaled together, so the SDK's polling and retry sleeps,
// uploadFile's limits and the mock's delays share one timeline.
const SCALE = 60 // simulated seconds per real second
const realNow = Date.now.bind(Date)
const realSetTimeout = globalThis.setTimeout
let t0 = realNow()
const simMs = () => (realNow() - t0) * SCALE
Date.now = () => t0 + simMs()
globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
  realSetTimeout(fn, Math.max(0, ms ?? 0) / SCALE, ...rest)) as unknown as typeof setTimeout

type Scenario = {
  name: string
  /** Over 10 MiB takes the SDK's chunked path (finalize, then status polling). Default 11. */
  sizeMiB?: number
  /** Seconds after the finalize request until /status says FINALIZED. Omit: never. */
  finalizeAfterS?: number
  /** '504-then-201': the first answer is lost while Turbo stores the item. '500': every answer is
   *  a 500. 'never': no answer completes. */
  finalizeAnswer?: '504-then-201' | '500' | 'never'
  /** A final /status verdict. */
  status?: 'UNDERFUNDED' | 'INVALID'
  /** outageS: chunks fail with a 503 for that long. secondsPerMiB: each chunk is answered that late. */
  chunk?: { outageS: number } | { secondsPerMiB: number }
  signRefusal?: string
  /** These /api/sign requests (1-based) fail with a bare 503. */
  signFailures?: number[]
  /** NEXT_PUBLIC_ARWEAVE_PAID_BY for the run. */
  paidBy?: string
  /** The file has no MIME type. */
  typeless?: boolean
  /** Call this entry without onFinalizing. Otherwise uploadToArweave is called with one. */
  without?: 'uploadToArweave' | 'uploadFile'
  /** No NEXT_PUBLIC_ARWEAVE_N, so the signer can't be built. */
  noKey?: boolean
  /** A 1 MiB upload runs at the same time; its first request fails once this one is finalizing. */
  alongside?: boolean
  /** Each entry is a problem, or false when that check passed. */
  check: (r: Run) => Array<string | false>
}
type Outcome = { ok: boolean; message: string; status?: number }
type Run = Outcome & {
  simMin: number
  /** Minutes from the first finalize request to the end. */
  finalizeMin?: number
  /** /api/sign requests, and the ones that returned a signature. */
  signs: number
  signed: number
  sessions: number
  finalizePosts: number
  finalizing: number
  progress: number[]
  /** x-paid-by on the finalize request. */
  paidBy?: string
  alongside?: Outcome
}

const outsideWindow = (r: Run) =>
  (r.finalizeMin === undefined || r.finalizeMin < 14.5 || r.finalizeMin > 16.5) &&
  `ended ${r.finalizeMin?.toFixed(1)} minutes after finalize began`

const SCENARIOS: Scenario[] = [
  {
    name: 'a quick confirmation resolves with one data item, charged to paidBy',
    finalizeAfterS: 5,
    paidBy: '0xKismetFunder',
    check: (r) => [
      !r.ok && `rejected: ${r.message}`,
      r.signs !== 1 && `${r.signs} signings`,
      r.finalizing !== 1 && `onFinalizing called ${r.finalizing} times`,
      r.paidBy !== '0xKismetFunder' && `x-paid-by: ${r.paidBy}`,
    ],
  },
  {
    name: 'a confirmation slower than the SDK deadline (4 min) resolves without re-signing',
    finalizeAfterS: 240,
    check: (r) => [
      !r.ok && `rejected: ${r.message}`,
      r.signs !== 1 && `${r.signs} signings`,
      r.finalizePosts !== 1 && `${r.finalizePosts} finalize requests`,
    ],
  },
  {
    name: 'a confirmation that never comes ends at the window, one data item, one line',
    check: (r) => [
      r.ok && 'resolved',
      !/hasn't confirmed this upload after 15 minutes\..*\(ref up1\)$/.test(r.message) && `message: ${r.message}`,
      r.message.includes('\n') && 'multi-line message',
      r.signs !== 1 && `${r.signs} signings`,
      r.finalizePosts !== 1 && `${r.finalizePosts} finalize requests`,
      outsideWindow(r),
    ],
  },
  {
    name: 'a finalize request that never completes ends at the window too',
    finalizeAnswer: 'never',
    check: (r) => [
      r.ok && 'resolved',
      !/hasn't confirmed/.test(r.message) && `message: ${r.message}`,
      r.signs !== 1 && `${r.signs} signings`,
      r.finalizePosts !== 1 && `${r.finalizePosts} finalize requests`,
      outsideWindow(r),
    ],
  },
  {
    name: 'a finalize request that keeps failing makes no new data item',
    finalizeAnswer: '500',
    typeless: true,
    without: 'uploadFile',
    check: (r) => [
      r.ok && 'resolved',
      !/hasn't confirmed this upload after 1 minute\./.test(r.message) && `message: ${r.message}`,
      r.signs !== 1 && `${r.signs} signings`,
      r.sessions !== 1 && `${r.sessions} upload sessions`,
    ],
  },
  {
    name: 'a 201 "already stored" finalize answer (after a 504) is accepted',
    finalizeAfterS: 5,
    finalizeAnswer: '504-then-201',
    check: (r) => [
      !r.ok && `rejected: ${r.message} (an SDK before 1.44 refuses 201)`,
      r.signs !== 1 && `${r.signs} signings`,
      r.finalizing !== 1 && `onFinalizing called ${r.finalizing} times`,
    ],
  },
  {
    name: 'an upload Turbo rejects (INVALID) fails at once, naming the verdict',
    status: 'INVALID',
    check: (r) => [
      r.ok && 'resolved',
      !/rejected this upload \(INVALID\)/.test(r.message) && `message: ${r.message}`,
      r.signs !== 1 && `${r.signs} signings`,
      r.simMin > 2 && `took ${r.simMin.toFixed(1)} simulated minutes`,
    ],
  },
  {
    name: 'exhausted credits (UNDERFUNDED) fail at once with the credits message',
    status: 'UNDERFUNDED',
    check: (r) => [
      r.ok && 'resolved',
      r.status !== 402 && `status ${r.status}`,
      !/credits/i.test(r.message) && `message: ${r.message}`,
      r.signs !== 1 && `${r.signs} signings`,
    ],
  },
  {
    // fetch reports no upload progress, so a slow chunk and a hung one look alike:
    // five 5 MiB chunks in flight at ~0.84 Mbit/s, none answered for over 4 minutes.
    name: 'a slow uplink completes without a restart',
    sizeMiB: 26,
    chunk: { secondsPerMiB: 50 },
    finalizeAfterS: 5,
    check: (r) => [!r.ok && `rejected: ${r.message}`, r.signs !== 1 && `${r.signs} signings`],
  },
  {
    name: 'a 60-second chunk outage is ridden out within the signing budget',
    finalizeAfterS: 5,
    chunk: { outageS: 60 },
    check: (r) => [
      !r.ok && `rejected: ${r.message}`,
      r.signs > 5 && `${r.signs} signings`,
      r.finalizePosts !== 1 && `${r.finalizePosts} finalize requests`,
    ],
  },
  {
    name: 'a chunk outage that does not end stops at five signings',
    chunk: { outageS: 3600 },
    check: (r) => [
      r.ok && 'resolved',
      r.signs !== 5 && `${r.signs} signings`,
      r.sessions !== 5 && `${r.sessions} upload sessions`,
      !/storage service unavailable/.test(r.message) && `message: ${r.message}`,
    ],
  },
  {
    name: 'a sign request that fails once is retried, and the upload completes',
    signFailures: [1],
    finalizeAfterS: 5,
    without: 'uploadToArweave',
    check: (r) => [
      !r.ok && `rejected: ${r.message}`,
      r.signs !== 2 && `${r.signs} sign requests`,
      r.signed !== 1 && `${r.signed} signings`,
      r.sessions !== 1 && `${r.sessions} upload sessions`,
      !r.progress.some((p, i) => p === 0 && r.progress.slice(0, i).some((q) => q > 0)) && 'progress not reset before the retry',
    ],
  },
  {
    name: 'a sign request that fails between chunk outages still stops at five signings',
    signFailures: [2],
    chunk: { outageS: 3600 },
    check: (r) => [
      r.ok && 'resolved',
      r.signed !== 5 && `${r.signed} signings`,
      !/storage service unavailable/.test(r.message) && `message: ${r.message}`,
    ],
  },
  {
    name: 'two uploads at once stay apart: one retrying while the other finalizes still signs',
    finalizeAfterS: 60,
    alongside: true,
    check: (r) => [
      !r.ok && `chunked upload rejected: ${r.message}`,
      !r.alongside?.ok && `other upload rejected: ${r.alongside?.message}`,
      r.signs !== 3 && `${r.signs} signings (expected 1 + 2)`,
    ],
  },
  {
    // The signer is built before fetch is patched, so this failure can't leave it patched.
    name: 'a missing signer key fails before any request',
    noKey: true,
    check: (r) => [
      r.ok && 'resolved',
      !/NEXT_PUBLIC_ARWEAVE_N not configured/.test(r.message) && `message: ${r.message}`,
      r.signs + r.sessions !== 0 && 'requests were made',
    ],
  },
  {
    name: "a refusal from /api/sign shows the server's words and uploads nothing",
    signRefusal: 'Sign in to continue',
    check: (r) => [
      r.ok && 'resolved',
      r.message !== 'Sign in to continue' && `message: ${r.message}`,
      r.sessions !== 0 && `${r.sessions} upload sessions opened`,
    ],
  },
]

// ---- mock Turbo upload service + /api/sign ----
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 })
process.env.NEXT_PUBLIC_ARWEAVE_N = (publicKey.export({ format: 'jwk' }) as { n: string }).n

let sc: Scenario = SCENARIOS[0]
let state = newState()
function newState() {
  let finalizeSeen = () => {}
  return {
    signs: 0,
    signed: 0,
    sessions: 0,
    finalizePosts: 0,
    singlePosts: 0,
    finalizedAt: new Map<string, number>(),
    firstChunkAt: undefined as number | undefined,
    firstFinalizeAt: undefined as number | undefined,
    paidBy: undefined as string | undefined,
    finalizeSeen: new Promise<void>((resolve) => (finalizeSeen = resolve)),
    onFinalize: () => finalizeSeen(),
  }
}
const sim = () => simMs() / 1000
const send = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const parts: Buffer[] = []
  req.on('data', (c: Buffer) => parts.push(c))
  req.on('end', () => {
    const p = new URL(req.url ?? '/', 'http://mock').pathname
    const body = Buffer.concat(parts)
    if (p === '/api/sign' && req.method === 'POST') {
      state.signs++
      if (sc.signRefusal) return send(res, 401, { error: sc.signRefusal })
      if (sc.signFailures?.includes(state.signs)) return send(res, 503, {})
      state.signed++
      const hash = Buffer.from((JSON.parse(body.toString()) as { hash: string }).hash, 'base64')
      const signature = crypto.sign('sha256', hash, {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      })
      return send(res, 200, { signature: signature.toString('base64') })
    }
    if (p === '/v1/tx/arweave' && req.method === 'POST') {
      // Only the alongside upload is small enough to take the single-request path.
      if (++state.singlePosts === 1) {
        void state.finalizeSeen.then(() => send(res, 503, { error: 'mock: busy' }))
        return
      }
      return send(res, 200, { id: `TX${state.singlePosts}` })
    }
    if (p === '/v1/chunks/arweave/-1/-1' && req.method === 'GET') {
      state.sessions++
      return send(res, 200, { id: `up${state.sessions}`, chunkSize: 5 * 1024 * 1024 })
    }
    let m = /^\/v1\/chunks\/arweave\/([^/]+)\/finalize$/.exec(p)
    if (m && req.method === 'POST') {
      state.finalizePosts++
      state.firstFinalizeAt ??= sim()
      state.paidBy ??= req.headers['x-paid-by'] as string | undefined
      state.onFinalize()
      const first = !state.finalizedAt.has(m[1])
      if (first) state.finalizedAt.set(m[1], sim())
      if (sc.finalizeAnswer === 'never') {
        // Headers, then a body that never ends: Node's own 5-minute timeouts (browsers
        // have none) see a live response, so only uploadFile's backstop can end it.
        res.writeHead(202, { 'content-type': 'application/json' })
        let timer: ReturnType<typeof setTimeout>
        const trickle = () => {
          res.write(' ')
          timer = setTimeout(trickle, 4 * 60_000)
        }
        trickle()
        res.on('close', () => clearTimeout(timer))
        return
      }
      if (sc.finalizeAnswer === '504-then-201') return send(res, first ? 504 : 201, {})
      if (sc.finalizeAnswer === '500') return send(res, 500, { error: 'mock: finalize failed' })
      return send(res, 202, {})
    }
    m = /^\/v1\/chunks\/arweave\/([^/]+)\/status$/.exec(p)
    if (m && req.method === 'GET') {
      if (sc.status) return send(res, 200, { status: sc.status })
      const at = state.finalizedAt.get(m[1])
      const done = sc.finalizeAfterS !== undefined && at !== undefined && sim() - at >= sc.finalizeAfterS
      return send(res, 200, done ? { status: 'FINALIZED', receipt: { id: `RCPT-${m[1]}` } } : { status: 'FINALIZING' })
    }
    m = /^\/v1\/chunks\/arweave\/([^/]+)\/(\d+)$/.exec(p)
    if (m && req.method === 'POST') {
      state.firstChunkAt ??= sim()
      const chunk = sc.chunk
      if (chunk && 'outageS' in chunk && sim() <= state.firstChunkAt + chunk.outageS) {
        return send(res, 503, { error: 'mock outage' })
      }
      if (chunk && 'secondsPerMiB' in chunk) {
        setTimeout(() => send(res, 200, {}), (body.length / 2 ** 20) * chunk.secondsPerMiB * 1000)
        return
      }
      return send(res, 200, {})
    }
    send(res, 404, { error: `mock: no route ${req.method} ${p}` })
  })
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

// Production origins -> the mock. Installed before uploadFile patches fetch.
const realFetch = globalThis.fetch
const toMock = ((input: RequestInfo | URL, init?: RequestInit) => {
  const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const next = u.startsWith('/api/sign')
    ? origin + u
    : u.startsWith('https://upload.ardrive.io/')
      ? origin + u.slice('https://upload.ardrive.io'.length)
      : u
  return realFetch(next, init)
}) as typeof fetch
globalThis.fetch = toMock

const { default: uploadToArweave } = await import('@/lib/arweave/uploadToArweave')
const { uploadFile } = await import('@/lib/arweave/uploadFile')
const fileOf = (mib: number, name: string, type = 'application/octet-stream') =>
  new File([new Uint8Array(mib * 2 ** 20)], name, { type })
const settle = (p: Promise<string>): Promise<Outcome> =>
  p.then(
    () => ({ ok: true, message: '' }),
    (error: unknown) => {
      const status = (error as { status?: unknown }).status
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        status: typeof status === 'number' ? status : undefined,
      }
    },
  )

// The SDK and uploadFile log through console.error/warn; kept, and shown only on a failure.
const { error: realError, warn: realWarn } = console
let failed = 0
for (const scenario of SCENARIOS) {
  sc = scenario
  state = newState()
  let finalizing = 0
  const progress: number[] = []
  const logs: unknown[][] = []
  if (scenario.paidBy) process.env.NEXT_PUBLIC_ARWEAVE_PAID_BY = scenario.paidBy
  const signerKey: string | undefined = process.env.NEXT_PUBLIC_ARWEAVE_N
  if (scenario.noKey) delete process.env.NEXT_PUBLIC_ARWEAVE_N
  console.error = console.warn = (...args: unknown[]) => void logs.push(args)
  t0 = realNow()
  const file = fileOf(scenario.sizeMiB ?? 11, 'sample.bin', scenario.typeless ? '' : undefined)
  const onProgress = (pct: number) => void progress.push(pct)
  const main = settle(
    scenario.without === 'uploadFile'
      ? uploadFile(file, onProgress)
      : scenario.without === 'uploadToArweave'
        ? uploadToArweave(file, onProgress)
        : uploadToArweave(file, onProgress, () => finalizing++),
  )
  const alongside = scenario.alongside ? settle(uploadFile(fileOf(1, 'poster.bin'))) : undefined
  // An upload with no bound would hang the run; fail it, and stop, since it is still
  // running and would disturb the scenarios after it.
  const hung = await Promise.race([
    Promise.all([main, alongside]).then(() => false),
    new Promise<true>((resolve) => realSetTimeout(() => resolve(true), (60 * 60_000) / SCALE)),
  ])
  if (hung) {
    console.error = realError
    console.warn = realWarn
    failed++
    console.log(`  FAIL  ${scenario.name}: still running after 60 simulated minutes`)
    break
  }
  const run: Run = {
    ...(await main),
    alongside: await alongside,
    simMin: simMs() / 60_000,
    finalizeMin: state.firstFinalizeAt === undefined ? undefined : (sim() - state.firstFinalizeAt) / 60,
    signs: state.signs,
    signed: state.signed,
    sessions: state.sessions,
    finalizePosts: state.finalizePosts,
    finalizing,
    progress,
    paidBy: state.paidBy,
  }
  delete process.env.NEXT_PUBLIC_ARWEAVE_PAID_BY
  process.env.NEXT_PUBLIC_ARWEAVE_N = signerKey
  console.error = realError
  console.warn = realWarn
  // An upload that never started (no signer) has nothing to log.
  const failures = scenario.noKey ? 0 : [run, run.alongside].filter((o) => o !== undefined && !o.ok).length
  const diagnostics = logs.filter((args) => args[0] === '[uploadFile] upload failed').length
  const problems = [
    ...scenario.check(run),
    // Every failed upload leaves one line with the SDK's own detail, for support.
    diagnostics !== failures && `${diagnostics} failure logs for ${failures} failed uploads`,
    // patchFetch is global and ref-counted: every upload must put fetch back.
    globalThis.fetch !== toMock && 'fetch left patched',
  ].filter((x): x is string => typeof x === 'string')
  if (problems.length === 0) {
    console.log(`  PASS  ${scenario.name} (${run.simMin.toFixed(1)} simulated min)`)
  } else {
    failed++
    console.log(`  FAIL  ${scenario.name}: ${problems.join('; ')}`)
    for (const args of logs) console.log('       ', ...args)
  }
}
server.closeAllConnections()
server.close()

if (failed > 0) {
  console.error(`\nFAILED — ${failed} of ${SCENARIOS.length} upload-policy checks`)
  process.exit(1)
}
console.log('\nOK — upload policy')
process.exit(0)
