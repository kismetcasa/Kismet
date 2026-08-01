// Behavioural validation of @upstash/redis@1.38.0 auto-pipelining claims.
// Stubs global fetch, counts HTTP requests and inspects each request body.
import { Redis } from '@upstash/redis'

let requests = []
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body)
  requests.push({ url: String(url), body })
  // Pipeline requests send an array of commands and expect an array of results.
  const isPipeline = Array.isArray(body) && Array.isArray(body[0])
  const result = isPipeline ? body.map(() => ({ result: null })) : { result: null }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const redis = new Redis({
  url: 'https://example.upstash.io',
  token: 't',
  enableAutoPipelining: true,
  retry: { retries: 2, backoff: () => 1 },
})

const reset = () => { requests = [] }
const shape = () => requests.map((r) =>
  Array.isArray(r.body) && Array.isArray(r.body[0])
    ? `PIPELINE[${r.body.map((c) => c[0]).join(',')}]`
    : `SINGLE[${Array.isArray(r.body) ? r.body[0] : r.body}]`,
)

console.log('=== CLAIM 1: smembers/zrange excluded from auto-pipelining ===')
reset()
await Promise.all([redis.smembers('a'), redis.smembers('b'), redis.smembers('c')])
console.log('3x smembers same tick ->', requests.length, 'HTTP request(s):', shape())

reset()
await Promise.all([redis.zrange('z1', 0, -1), redis.zrange('z2', 0, -1)])
console.log('2x zrange  same tick ->', requests.length, 'HTTP request(s):', shape())

reset()
await Promise.all([redis.get('k1'), redis.get('k2'), redis.get('k3')])
console.log('3x get     same tick ->', requests.length, 'HTTP request(s):', shape())

reset()
await Promise.all([redis.mget('k1', 'k2'), redis.mget('k3', 'k4')])
console.log('2x mget    same tick ->', requests.length, 'HTTP request(s):', shape())

reset()
await Promise.all([redis.smismember('s', ['a']), redis.smismember('s', ['b'])])
console.log('2x smismember        ->', requests.length, 'HTTP request(s):', shape())

console.log('\n=== CLAIM 2: reads and writes use SEPARATE pipelines ===')
reset()
await Promise.all([redis.get('r1'), redis.set('w1', 'v'), redis.get('r2'), redis.set('w2', 'v')])
console.log('2 reads + 2 writes   ->', requests.length, 'HTTP request(s):', shape())

console.log('\n=== CLAIM 3: eval IS auto-pipelined (multi() is not) ===')
reset()
await Promise.all([redis.eval('return 1', ['k'], ['a']), redis.set('w', 'v')])
console.log('eval + set same tick ->', requests.length, 'HTTP request(s):', shape())

reset()
await Promise.all([redis.eval('return 1', ['k1'], ['a']), redis.eval('return 2', ['k2'], ['b'])])
console.log('2x eval same tick    ->', requests.length, 'HTTP request(s):', shape())

console.log('\n=== CLAIM 4: the real-world searchCollections shape ===')
reset()
await Promise.all([redis.smembers('collections'), redis.smembers('hidden-c'), redis.smembers('hidden-u')])
const after = requests.length
await redis.mget('m1', 'm2', 'm3')
console.log('3 smembers then mget ->', requests.length, 'HTTP total (', after, 'from the smembers):', shape())

console.log('\n=== CLAIM 5: retry re-sends the WHOLE pipeline body ===')
reset()
let attempt = 0
globalThis.fetch = async (url, opts) => {
  attempt++
  const body = JSON.parse(opts.body)
  requests.push({ url: String(url), body })
  if (attempt === 1) throw new TypeError('fetch failed') // network-level failure
  return new Response(JSON.stringify(body.map(() => ({ result: null }))), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}
await Promise.all([
  redis.eval('incr-script', ['rl'], ['60']),
  redis.incr('counter'),
  redis.zincrby('z', 1, 'm'),
])
console.log('pipeline w/ 1 net failure -> HTTP attempts:', requests.length)
console.log('  attempt bodies:', requests.map((r) => `[${r.body.map((c) => c[0]).join(',')}]`))
console.log('  => non-idempotent commands re-sent:', requests.length > 1 ? 'YES' : 'NO')

console.log('\n=== CLAIM 6: a 5xx response is NOT retried ===')
reset()
attempt = 0
globalThis.fetch = async (url, opts) => {
  attempt++
  requests.push({ url: String(url), body: JSON.parse(opts.body) })
  return new Response(JSON.stringify({ error: 'server blew up' }), {
    status: 500, headers: { 'content-type': 'application/json' },
  })
}
try {
  await redis.get('k')
  console.log('no throw (unexpected)')
} catch (e) {
  console.log('HTTP attempts on 500:', requests.length, '| threw:', e.constructor.name)
  console.log('  => 5xx retried:', requests.length > 1 ? 'YES' : 'NO')
}
