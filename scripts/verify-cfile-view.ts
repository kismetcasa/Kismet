/**
 * The collector-file VIEW gate, end to end against the built app
 * (`next start`) with Redis and the chain mocked — the server half of a
 * collectors-only zine (ZINE_READER_DESIGN.md §22, finding 20):
 *
 *   - an artwork's manager attaches a PDF with its page count, and the
 *     public descriptor carries the count (and ignores one past the cap);
 *   - the view route serves the bytes to a holder, to the artwork's
 *     manager who holds no edition (view only — the ticket route still
 *     refuses them), and to nobody else: no session → 401, a stranger →
 *     403, and a permissions read that fails keeps the collector gate's
 *     403 rather than turning it into a 503.
 *
 * Run: npm run build && npm run verify:cfile-view
 */
import http from 'node:http'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Hex } from 'viem'
import { createMockUpstash } from './_mock-upstash.ts'

let passed = 0
let failed = 0
function ok(cond: boolean, name: string, detail?: unknown) {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  }
}

const MANAGER = getAddress(`0x${'aa'.repeat(20)}`)
const HOLDER = getAddress(`0x${'bb'.repeat(20)}`)
const STRANGER = getAddress(`0x${'cc'.repeat(20)}`)
const COLLECTION = getAddress(`0x${'c0'.repeat(20)}`)
const TOKEN = '1'

// A spec-minimal PDF: the attach route detects the kind by magic and the
// view route serves bytes, neither parses pages.
const PDF_A = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
)
const PDF_B = Buffer.concat([PDF_A, Buffer.from('% a second export\n')])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

// ───────────────────────── mock Base JSON-RPC ─────────────────────────
const PERMISSIONS_ABI = parseAbi(['function permissions(uint256 tokenId, address user) view returns (uint256)'])
const BALANCE_ABI = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)'])
const BALANCE_BATCH_ABI = parseAbi(['function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])'])
const METADATA_EDIT_MASK = 2n | 16n // ADMIN | METADATA (lib/permissions)
const rpcState = { permissionsFailing: false }

function answerCall(data: Hex): Hex {
  try {
    const { args } = decodeFunctionData({ abi: PERMISSIONS_ABI, data })
    if (rpcState.permissionsFailing) throw new Error('mock: permissions read failure')
    const user = String(args[1]).toLowerCase()
    return encodeFunctionResult({ abi: PERMISSIONS_ABI, functionName: 'permissions', result: user === MANAGER.toLowerCase() ? METADATA_EDIT_MASK : 0n })
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('mock:')) throw e
  }
  try {
    const { args } = decodeFunctionData({ abi: BALANCE_BATCH_ABI, data })
    const accounts = args[0] as readonly string[]
    return encodeFunctionResult({ abi: BALANCE_BATCH_ABI, functionName: 'balanceOfBatch', result: accounts.map((a) => (a.toLowerCase() === HOLDER.toLowerCase() ? 1n : 0n)) })
  } catch {}
  const { args } = decodeFunctionData({ abi: BALANCE_ABI, data })
  return encodeFunctionResult({ abi: BALANCE_ABI, functionName: 'balanceOf', result: String(args[0]).toLowerCase() === HOLDER.toLowerCase() ? 1n : 0n })
}

function startRpcServer(): Promise<string> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      const parsed = JSON.parse(body) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[]
      const one = (rpc: { id: number; method: string; params?: unknown[] }) => {
        try {
          if (rpc.method === 'eth_chainId') return { jsonrpc: '2.0', id: rpc.id, result: '0x2105' }
          if (rpc.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: rpc.id, result: '0x10' }
          if (rpc.method === 'eth_call') {
            const call = (rpc.params as [{ to?: string; data: Hex }])[0]
            return { jsonrpc: '2.0', id: rpc.id, result: answerCall(call.data) }
          }
          return { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `mock: ${rpc.method} unsupported` } }
        } catch (e) {
          return { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: `mock: ${String(e)}` } }
        }
      }
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}

// ───────────────────────── the built server ─────────────────────────
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

async function startNext(env: Record<string, string>): Promise<{ base: string; child: ChildProcess }> {
  const port = await freePort()
  const log = createWriteStream(`${process.env.TMPDIR ?? '/tmp'}/verify-cfile-view.next.log`)
  // Its own process group: `npx` wraps the server in a child, and a SIGTERM
  // to the wrapper alone left `next-server` orphaned, spinning on the mocks
  // that had gone with the harness (and starving everything after it).
  const child = spawn('npx', ['next', 'start', '-p', String(port), '-H', '127.0.0.1'], {
    env: { ...process.env, ...env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout?.pipe(log)
  child.stderr?.pipe(log)
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      const r = await fetch(`${base}/api/agent/manifest`)
      if (r.ok) return { base, child }
    } catch {}
    if (child.exitCode !== null) throw new Error(`next start exited with ${child.exitCode} (see verify-cfile-view.next.log)`)
    if (Date.now() > deadline) throw new Error('next start did not become ready in 90s')
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function main() {
  const upstash = createMockUpstash()
  const session = (address: string) => {
    const token = createHash('sha256').update(address).digest('hex')
    upstash.store.set(`kismetart:session:${token}`, { v: address.toLowerCase() })
    return `__Host-kismet_session=${token}`
  }
  const cookies = { manager: session(MANAGER), holder: session(HOLDER), stranger: session(STRANGER) }
  // Cached Farcaster misses, so the gate's sibling expansion never leaves the sandbox.
  for (const a of [MANAGER, HOLDER, STRANGER]) upstash.store.set(`kismetart:fc:fid-by-addr:${a.toLowerCase()}`, { v: '' })

  const [redisUrl, rpcUrl] = await Promise.all([upstash.start(), startRpcServer()])
  const { base, child } = await startNext({
    CRON_INPROCESS: 'off',
    UPSTASH_REDIS_REST_URL: redisUrl,
    UPSTASH_REDIS_REST_TOKEN: 'mock-token',
    BASE_RPC_URL: rpcUrl,
    MAINNET_RPC_URL: rpcUrl,
  })
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    upstash.close()
  }
  process.on('exit', stop)

  const qs = `collection=${COLLECTION}&tokenId=${TOKEN}`
  const put = (cookie: string, bytes: Buffer, extra = '') =>
    fetch(`${base}/api/collector-file?${qs}${extra}`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/pdf', 'x-file-name': 'issue-1.pdf' },
      body: new Uint8Array(bytes),
    })
  const view = (cookie?: string) => fetch(`${base}/api/collector-file/view?${qs}&v=1`, { headers: cookie ? { cookie } : {} })

  try {
    console.log('\nattach — the manager, the page count')
    const stranger = await put(cookies.stranger, PDF_A, '&pages=3')
    ok(stranger.status === 403, 'a stranger cannot attach (403)', stranger.status)
    const attached = await put(cookies.manager, PDF_A, '&pages=3')
    const attachedBody = (await attached.json().catch(() => null)) as { file?: { kind?: string; pages?: number; v?: number; name?: string; sha256?: string } } | null
    ok(attached.status === 200, 'the manager attaches a PDF (200)', { status: attached.status, body: attachedBody })
    ok(attachedBody?.file?.kind === 'pdf' && attachedBody.file.pages === 3 && attachedBody.file.v === 1, 'the descriptor says pdf, 3 pages, v1', attachedBody?.file)
    ok(attachedBody?.file?.sha256 === sha(PDF_A), 'the descriptor carries the bytes’ sha256')
    const status = await fetch(`${base}/api/collector-file/status?${qs}`)
    const statusBody = (await status.json().catch(() => null)) as { file?: { pages?: number; kind?: string } } | null
    ok(status.status === 200 && statusBody?.file?.pages === 3 && statusBody.file.kind === 'pdf', 'the public status carries the page count', statusBody)

    console.log('\nview — who may read')
    const anon = await view()
    ok(anon.status === 401, 'no session → 401', anon.status)
    const asStranger = await view(cookies.stranger)
    ok(asStranger.status === 403, 'a signed-in stranger (no edition, no permissions) → 403', asStranger.status)
    const asHolder = await view(cookies.holder)
    const holderBytes = Buffer.from(await asHolder.arrayBuffer())
    ok(asHolder.status === 200 && asHolder.headers.get('content-type') === 'application/pdf', 'a holder reads the PDF (200, application/pdf)', { status: asHolder.status, type: asHolder.headers.get('content-type') })
    ok(sha(holderBytes) === sha(PDF_A), 'a holder gets the attached bytes, exactly')
    const asManager = await view(cookies.manager)
    const managerBytes = Buffer.from(await asManager.arrayBuffer())
    ok(asManager.status === 200, 'the artwork’s manager, holding no edition, reads it too (200)', asManager.status)
    ok(sha(managerBytes) === sha(PDF_A), 'the manager gets the same bytes')
    ok((asManager.headers.get('content-disposition') ?? '').startsWith('attachment'), 'served as an attachment (a direct navigation saves, never renders)')
    ok((asManager.headers.get('cache-control') ?? '').includes('private'), 'cached privately, as for every viewable kind')

    console.log('\nview only — nothing else for a non-holding manager')
    const ticket = await fetch(`${base}/api/collector-file/ticket?${qs}`, { method: 'POST', headers: { cookie: cookies.manager, 'content-type': 'application/json' }, body: '{}' })
    ok(ticket.status === 403, 'the ticket (download) route still refuses a manager who holds no edition (403)', ticket.status)

    console.log('\nview — a permissions read that fails')
    rpcState.permissionsFailing = true
    const managerOutage = await view(cookies.manager)
    ok(managerOutage.status === 403, 'a failed permissions read keeps the collector gate’s 403, never a 503', managerOutage.status)
    const holderOutage = await view(cookies.holder)
    ok(holderOutage.status === 200, 'a holder is unaffected by the permissions read', holderOutage.status)
    rpcState.permissionsFailing = false

    console.log('\nattach — a page count past the cap is ignored')
    const replaced = await put(cookies.manager, PDF_B, '&pages=999')
    const replacedBody = (await replaced.json().catch(() => null)) as { file?: { pages?: number; v?: number } } | null
    ok(replaced.status === 200 && replacedBody?.file?.v === 2, 'the manager replaces the file (v2)', { status: replaced.status, body: replacedBody })
    ok(replacedBody?.file?.pages === undefined, 'a count past 420 is not stored', replacedBody?.file)
  } finally {
    stop()
  }

  console.log(`\n${failed === 0 ? 'OK' : 'FAILED'} — collector-file view gate: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
