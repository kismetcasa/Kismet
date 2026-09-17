// Mock Upstash REST server for the agent verify harnesses (live-behavior and
// route-level). Models exactly the commands the agent code paths issue —
// strings, the pending-revoke queue's hashes/sets/Lua step, sorted-set writes
// as a log — and answers with the wire encoding the real client expects.
//
// Encoding matters: the Upstash client sends `Upstash-Encoding: base64` and
// base64-DECODES every string it receives. Returning raw strings mostly
// "works" by accident (JSON braces aren't valid base64, so the decode throws
// and falls back to raw) — but a value drawn only from the base64 alphabet,
// i.e. every 0x address, decodes successfully into garbage. So results are
// encoded here exactly as the real REST API does.
//
// Sets are modelled only for keys the `modelSets` predicate accepts (default:
// the pending-revoke queue), so the record store's watcher-index SADDs stay
// inert for tests that don't want a coordinator fan-out.

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface StoredVal {
  v: string
  ex?: number
}

export interface MockUpstash {
  store: Map<string, StoredVal>
  hashes: Map<string, Map<string, string>>
  sets: Map<string, Set<string>>
  /** Every ZADD, in order — the notification inbox is one ZADD per notice. */
  zadds: { key: string; member: string }[]
  /** Every EVAL script + keys/args, so a test can see a rate-limit or unindex step ran. */
  evals: { script: string; keys: string[]; args: string[] }[]
  setFailing(failing: boolean): void
  /** Start listening; resolves to the REST URL to put in UPSTASH_REDIS_REST_URL. */
  start(): Promise<string>
  close(): void
}

export function createMockUpstash(opts: { modelSets?: (key: string) => boolean } = {}): MockUpstash {
  const modelSets = opts.modelSets ?? ((key: string) => key.startsWith('kismetart:scout-pending-revoke'))
  const store = new Map<string, StoredVal>()
  const hashes = new Map<string, Map<string, string>>()
  const sets = new Map<string, Set<string>>()
  const zadds: MockUpstash['zadds'] = []
  const evals: MockUpstash['evals'] = []
  let failing = false

  function exec(cmd: unknown[]): unknown {
    const op = String(cmd[0]).toUpperCase()
    const key = String(cmd[1] ?? '')
    if (op === 'ZADD') {
      zadds.push({ key, member: String(cmd[cmd.length - 1]) })
      return 1
    }
    if (op === 'HSET') {
      const h = hashes.get(key) ?? new Map<string, string>()
      for (let i = 2; i + 1 < cmd.length; i += 2) h.set(String(cmd[i]), String(cmd[i + 1]))
      hashes.set(key, h)
      return 1
    }
    if (op === 'HGETALL') return [...(hashes.get(key)?.entries() ?? [])].flat()
    if (op === 'HDEL') {
      const h = hashes.get(key)
      let n = 0
      for (let i = 2; i < cmd.length; i++) if (h?.delete(String(cmd[i]))) n++
      return n
    }
    if (op === 'HLEN') return hashes.get(key)?.size ?? 0
    if (op === 'SADD') {
      if (!modelSets(key)) return null
      const s = sets.get(key) ?? new Set<string>()
      for (let i = 2; i < cmd.length; i++) s.add(String(cmd[i]))
      sets.set(key, s)
      return 1
    }
    if (op === 'SREM') {
      if (!modelSets(key)) return null
      let n = 0
      for (let i = 2; i < cmd.length; i++) if (sets.get(key)?.delete(String(cmd[i]))) n++
      return n
    }
    if (op === 'SMEMBERS') return modelSets(key) ? [...(sets.get(key) ?? [])] : []
    if (op === 'EVAL') {
      // ["EVAL", script, numkeys, ...keys, ...args]
      const script = String(cmd[1])
      const numKeys = Number(cmd[2])
      const keys = cmd.slice(3, 3 + numKeys).map(String)
      const args = cmd.slice(3 + numKeys).map(String)
      evals.push({ script, keys, args })
      // The pending-revoke queue's "un-index if empty" step.
      if (script.includes('HLEN')) {
        if ((hashes.get(keys[0])?.size ?? 0) === 0) return sets.get(keys[1])?.delete(args[0]) ? 1 : 0
        return 0
      }
      // The scout record's compare-and-set (store.ts saveScoutIfUnchanged).
      if (script.includes('== ARGV[1]')) {
        const cur = store.get(keys[0])
        if (!cur || cur.v !== args[0]) return 0
        store.set(keys[0], { v: args[1], ex: cur.ex })
        return 1
      }
      // The rate limiter's INCR (+ EXPIRE on the first hit): a real counter, so
      // a limit can trip.
      if (script.includes('INCR')) {
        const n = Number(store.get(keys[0])?.v ?? 0) + 1
        store.set(keys[0], { v: String(n), ex: n === 1 ? Number(args[0]) : store.get(keys[0])?.ex })
        return n
      }
      return 1
    }
    if (op === 'SET') {
      const val = String(cmd[2])
      let nx = false
      let ex: number | undefined
      for (let i = 3; i < cmd.length; i++) {
        const t = String(cmd[i]).toUpperCase()
        if (t === 'NX') nx = true
        if (t === 'EX') ex = Number(cmd[++i])
      }
      if (nx && store.has(key)) return null
      store.set(key, { v: val, ex })
      return 'OK'
    }
    if (op === 'SETEX') {
      store.set(key, { v: String(cmd[3]), ex: Number(cmd[2]) })
      return 'OK'
    }
    if (op === 'GET') return store.get(key)?.v ?? null
    if (op === 'DEL') {
      let n = 0
      for (let i = 1; i < cmd.length; i++) {
        const k = String(cmd[i])
        if (store.delete(k)) n++
        if (hashes.delete(k)) n++
        if (sets.delete(k)) n++
      }
      return n
    }
    if (op === 'MGET') {
      const out: (string | null)[] = []
      for (let i = 1; i < cmd.length; i++) out.push(store.get(String(cmd[i]))?.v ?? null)
      return out
    }
    if (op === 'ZRANGE' || op === 'ZREVRANGE') return [] // read as empty, so list-shaped callers see a list
    return null // LPUSH/EXPIRE/SISMEMBER/… — accepted, irrelevant to assertions
  }

  // Like the real service, a bare "OK" status is sent as-is; the client
  // special-cases it before base64-decoding every other string.
  const b64 = (x: unknown): unknown =>
    typeof x === 'string' ? (x === 'OK' ? x : Buffer.from(x, 'utf8').toString('base64')) : Array.isArray(x) ? x.map(b64) : x
  /** Encode only the `result` payloads, never the pipeline envelope or `error`. */
  const encodeResults = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(encodeResults)
    if (x && typeof x === 'object' && 'result' in x) return { ...(x as object), result: b64((x as { result: unknown }).result) }
    return x
  }

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      const encoded = String(req.headers['upstash-encoding'] ?? '').toLowerCase() === 'base64'
      const reply = (x: unknown) => res.end(JSON.stringify(encoded ? encodeResults(x) : x))
      const isPipeline = req.url?.includes('pipeline') || req.url?.includes('multi-exec')
      if (failing) {
        if (isPipeline) {
          const cmds = JSON.parse(body) as unknown[][]
          return reply(cmds.map(() => ({ error: 'mock redis down' })))
        }
        return reply({ error: 'mock redis down' })
      }
      try {
        if (isPipeline) {
          const cmds = JSON.parse(body) as unknown[][]
          return reply(cmds.map((c) => ({ result: exec(c) })))
        }
        return reply({ result: exec(JSON.parse(body) as unknown[]) })
      } catch (e) {
        return reply({ error: String(e) })
      }
    })
  })

  return {
    store,
    hashes,
    sets,
    zadds,
    evals,
    setFailing: (f) => {
      failing = f
    },
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
      }),
    close: () => server.close(),
  }
}
