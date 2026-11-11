// An Upstash-REST front for a REAL redis-server, for scripts/e2e/drops-flow.ts.
//
// The drops code leans on Redis semantics a mock would have to re-implement
// to be believed — the claim reservation and rate limits are Lua scripts,
// the settle lock is SET NX EX, settle progress expires with EXAT, notices
// are SET NX EXAT — so the harness runs the real server and translates the
// REST wire format only: POST / (one command), /pipeline and /multi-exec,
// with the `Upstash-Encoding: base64` result encoding the client asks for
// (every string base64'd except a bare "OK", as the real service does).
import http from 'node:http'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'

class RespError extends Error {}

type Reply = string | number | null | RespError | Reply[]

function parse(buf: Buffer, at: number): { value: Reply; end: number } | null {
  if (at >= buf.length) return null
  const eol = buf.indexOf('\r\n', at)
  if (eol < 0) return null
  const line = buf.toString('utf8', at + 1, eol)
  switch (String.fromCharCode(buf[at])) {
    case '+':
      return { value: line, end: eol + 2 }
    case '-':
      return { value: new RespError(line), end: eol + 2 }
    case ':':
      return { value: Number(line), end: eol + 2 }
    case '$': {
      const n = Number(line)
      if (n < 0) return { value: null, end: eol + 2 }
      if (buf.length < eol + 2 + n + 2) return null
      return { value: buf.toString('utf8', eol + 2, eol + 2 + n), end: eol + 2 + n + 2 }
    }
    case '*': {
      const n = Number(line)
      if (n < 0) return { value: null, end: eol + 2 }
      const out: Reply[] = []
      let pos = eol + 2
      for (let i = 0; i < n; i++) {
        const r = parse(buf, pos)
        if (!r) return null
        out.push(r.value)
        pos = r.end
      }
      return { value: out, end: pos }
    }
    default:
      throw new Error(`unexpected RESP type ${buf[at]}`)
  }
}

class RespClient {
  private buf = Buffer.alloc(0)
  private waiting: ((r: Reply) => void)[] = []
  private sock: net.Socket
  private constructor(sock: net.Socket) {
    this.sock = sock
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d])
      for (;;) {
        const r = parse(this.buf, 0)
        if (!r) break
        this.buf = this.buf.subarray(r.end)
        this.waiting.shift()?.(r.value)
      }
    })
  }
  static connect(port: number): Promise<RespClient> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => resolve(new RespClient(sock)))
      sock.once('error', reject)
    })
  }
  send(args: unknown[]): Promise<Reply> {
    const parts = args.map((a) => Buffer.from(typeof a === 'string' ? a : JSON.stringify(a), 'utf8'))
    const frame = Buffer.concat([
      Buffer.from(`*${parts.length}\r\n`),
      ...parts.flatMap((p) => [Buffer.from(`$${p.length}\r\n`), p, Buffer.from('\r\n')]),
    ])
    return new Promise((resolve) => {
      this.waiting.push(resolve)
      this.sock.write(frame)
    })
  }
  close(): void {
    this.sock.destroy()
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })
}

export interface RealRedis {
  url: string
  /** Direct access for assertions (a fresh connection per call is fine here). */
  command(args: unknown[]): Promise<Reply>
  close(): void
}

export async function startRealRedis(): Promise<RealRedis> {
  const port = await freePort()
  const server: ChildProcess = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore',
  })
  let client: RespClient | null = null
  for (let i = 0; i < 50 && !client; i++) {
    client = await RespClient.connect(port).catch(() => null)
    if (!client) await new Promise((r) => setTimeout(r, 100))
  }
  if (!client) throw new Error('redis-server did not start')
  const resp = client

  const toResult = (r: Reply): { result: unknown } | { error: string } =>
    r instanceof RespError ? { error: r.message } : { result: r }
  const b64 = (x: unknown): unknown =>
    typeof x === 'string' ? (x === 'OK' ? x : Buffer.from(x, 'utf8').toString('base64')) : Array.isArray(x) ? x.map(b64) : x
  const encode = (x: { result: unknown } | { error: string }) => ('result' in x ? { result: b64(x.result) } : x)

  const http_ = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const base64 = String(req.headers['upstash-encoding'] ?? '').toLowerCase() === 'base64'
      const out = (x: { result: unknown } | { error: string }) => (base64 ? encode(x) : x)
      res.setHeader('content-type', 'application/json')
      try {
        const parsed = JSON.parse(body) as unknown[]
        if (req.url?.startsWith('/multi-exec')) {
          await resp.send(['MULTI'])
          for (const cmd of parsed as unknown[][]) await resp.send(cmd)
          const exec = await resp.send(['EXEC'])
          const rows = Array.isArray(exec) ? exec : []
          return res.end(JSON.stringify(rows.map((r) => out(toResult(r)))))
        }
        if (req.url?.startsWith('/pipeline')) {
          const rows = await Promise.all((parsed as unknown[][]).map((cmd) => resp.send(cmd)))
          return res.end(JSON.stringify(rows.map((r) => out(toResult(r)))))
        }
        const r = toResult(await resp.send(parsed))
        if ('error' in r) res.statusCode = 400
        res.end(JSON.stringify(out(r)))
      } catch (err) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })
  await new Promise<void>((r) => http_.listen(0, '127.0.0.1', () => r()))
  const { port: httpPort } = http_.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${httpPort}`,
    command: (args) => resp.send(args),
    close: () => {
      resp.close()
      http_.close()
      server.kill('SIGKILL')
    },
  }
}
