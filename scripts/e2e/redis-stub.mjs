// Minimal Upstash-REST-compatible stub so the app can render server-side in
// the sandbox. Every read answers "no data", which is the same shape the app
// sees for a moment with no KV entries — the graceful path, not a fake one.
import http from 'http'
const nullFor = (cmd) => {
  const c = String(cmd?.[0] ?? '').toUpperCase()
  if (['SMEMBERS','ZRANGE','KEYS','HKEYS','HVALS','MGET','LRANGE'].includes(c)) return []
  if (['EXISTS','SISMEMBER','ZCARD','SCARD','LLEN','DEL','TTL','INCR'].includes(c)) return 0
  if (c === 'HGETALL') return {}
  return null
}
http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    let parsed = null
    try { parsed = JSON.parse(body || 'null') } catch {}
    const isPipeline = Array.isArray(parsed) && Array.isArray(parsed[0])
    const out = isPipeline
      ? parsed.map((c) => ({ result: nullFor(c) }))
      : { result: nullFor(parsed) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out))
  })
}).listen(6399, () => console.log('redis stub on 6399'))
