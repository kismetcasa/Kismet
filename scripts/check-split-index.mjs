#!/usr/bin/env node
// Ad-hoc diagnostic for the shared-split pending over-count (ANALYTICS.md §7b).
//
// For a given wallet, lists every split moment in the Redis reverse index
// (kismetart:splits:by-recipient:<wallet>), resolves each moment's cached
// split contract (kismetart:splitaddr:<collection>:<tokenId>), reads each
// UNIQUE split's live ETH/USDC balance from Base, and prints:
//   - what the pending roll-up CURRENTLY sums (once per moment), and
//   - the deduped figure (once per split contract) — the artist's real pending.
// A split address shared by several moments is flagged: that pot is being
// counted N× by lib/pending.ts compute() and distribute-all's fan-out.
//
// Dependency-free (plain fetch): reads UPSTASH_REDIS_REST_URL/TOKEN from
// .env.local (or the environment), talks to Upstash REST + a public Base RPC.
// Balance reads are best-effort — if the RPC is unreachable the shared-split
// detection (the core diagnostic) still completes from Redis alone.
//
// Usage:
//   node scripts/check-split-index.mjs 0xWALLET [envfile]
//     envfile defaults to .env.local in the cwd
//   BASE_RPC_URL overrides the default public RPC (https://mainnet.base.org).

import { readFileSync } from 'node:fs'

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const CHAINLINK_ETH_USD = '0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70'
const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org'

const wallet = (process.argv[2] || '').toLowerCase()
if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
  console.error('usage: node scripts/check-split-index.mjs 0xWALLET [envfile]')
  process.exit(1)
}

// Minimal .env parser — enough for KEY=value lines, optional quotes. Values
// already present in the environment win, so `vercel env pull` or an exported
// shell var both work without flags.
function loadEnv(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v
  }
}
loadEnv(process.argv[3] || '.env.local')

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN
if (!url || !token) {
  console.error(
    'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not found.\n' +
      'Run from the repo root with a populated .env.local (try: vercel env pull .env.local),\n' +
      'or pass the env file path as the second argument.',
  )
  process.exit(1)
}

async function redis(cmd) {
  const res = await fetch(`${url}/${cmd}`, { headers: { Authorization: `Bearer ${token}` } })
  const body = await res.json()
  if (body.error) throw new Error(`upstash: ${body.error}`)
  return body.result
}

// ── Best-effort on-chain reads ───────────────────────────────────────────────
let rpcDown = false
let rpcId = 0
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`)
  return body.result
}

// balanceOf(address) — 0x70a08231. Returns null (and stops retrying) if the
// RPC is unreachable, so Redis-only environments still get the shared report.
async function readBalances(addr) {
  if (rpcDown) return null
  try {
    const [eth, usdc] = await Promise.all([
      rpc('eth_getBalance', [addr, 'latest']).then(BigInt),
      rpc('eth_call', [
        { to: USDC_BASE, data: '0x70a08231' + addr.slice(2).padStart(64, '0') },
        'latest',
      ]).then(BigInt),
    ])
    return { eth, usdc }
  } catch (e) {
    rpcDown = true
    console.error(`(balance reads unavailable — ${e.message}; set BASE_RPC_URL to another RPC)`)
    return null
  }
}

// latestRoundData() — 0xfeaf968c; answer is the 2nd 32-byte word, 8 decimals.
async function ethUsd() {
  if (rpcDown) return null
  try {
    const out = await rpc('eth_call', [{ to: CHAINLINK_ETH_USD, data: '0xfeaf968c' }, 'latest'])
    return Number(BigInt('0x' + out.slice(2 + 64, 2 + 128))) / 1e8
  } catch {
    return null
  }
}

const fmtEth = (wei) => (Number(wei) / 1e18).toFixed(6)
const fmtUsdc = (base) => (Number(base) / 1e6).toFixed(2)

try {
  const members = (await redis(`smembers/kismetart:splits:by-recipient:${wallet}`)) ?? []
  console.log(`${members.length} split moment(s) indexed for ${wallet}\n`)
  if (members.length === 0) {
    console.log('No indexed splits — if the artist definitely has split moments, this wallet')
    console.log('may not be the one their profile resolves to (check their FC sibling wallets).')
    process.exit(0)
  }

  // member format: <collection>:<tokenId>:<pct>
  const moments = []
  for (const m of members) {
    const first = m.indexOf(':')
    const last = m.lastIndexOf(':')
    if (first <= 0 || last <= first) continue
    moments.push({
      collection: m.slice(0, first),
      tokenId: m.slice(first + 1, last),
      pct: Number(m.slice(last + 1)),
    })
  }

  const byAddr = new Map() // splitAddress -> { bal: {eth,usdc}|null, rows: [moment] }
  for (const mo of moments) {
    const addr = await redis(`get/kismetart:splitaddr:${mo.collection}:${mo.tokenId}`)
    const key = typeof addr === 'string' && addr ? addr.toLowerCase() : null
    let entry = key ? byAddr.get(key) : null
    if (key && !entry) {
      entry = { bal: await readBalances(key), rows: [] }
      byAddr.set(key, entry)
    }
    if (entry) entry.rows.push(mo)
    const balNote =
      entry && entry.rows.length === 1 && entry.bal
        ? `  balance=${fmtEth(entry.bal.eth)} ETH / ${fmtUsdc(entry.bal.usdc)} USDC`
        : ''
    console.log(
      `${mo.collection} #${mo.tokenId}  pct=${mo.pct}%  split=${key ?? '(not cached — the pending card has not counted this moment either)'}${balNote}`,
    )
  }

  console.log('')
  let shared = 0
  for (const [addr, e] of byAddr) {
    if (e.rows.length > 1) {
      shared++
      const pot = e.bal ? ` — its ${fmtEth(e.bal.eth)} ETH / ${fmtUsdc(e.bal.usdc)} USDC pot is` : ' —'
      console.log(`⚠ split ${addr} is shared by ${e.rows.length} moments${pot} counted ${e.rows.length}× by the pending roll-up`)
    }
  }
  if (shared === 0) console.log('no shared split addresses — pending is not over-counted for this wallet')

  // What compute() currently sums (per moment) vs the deduped truth (per split).
  const haveAllBalances = [...byAddr.values()].every((e) => e.bal)
  if (haveAllBalances) {
    let curEth = 0n, curUsdc = 0n, dedupEth = 0n, dedupUsdc = 0n
    for (const [, e] of byAddr) {
      for (const r of e.rows) {
        curEth += (e.bal.eth * BigInt(r.pct)) / 100n
        curUsdc += (e.bal.usdc * BigInt(r.pct)) / 100n
      }
      const maxPct = BigInt(Math.max(...e.rows.map((r) => r.pct)))
      dedupEth += (e.bal.eth * maxPct) / 100n
      dedupUsdc += (e.bal.usdc * maxPct) / 100n
    }
    const price = await ethUsd()
    const usd = (wei, base) =>
      price == null ? '?' : ((Number(wei) / 1e18) * price + Number(base) / 1e6).toFixed(2)
    console.log(`\npending as the app sums it today: ${fmtEth(curEth)} ETH + ${fmtUsdc(curUsdc)} USDC  (~$${usd(curEth, curUsdc)})`)
    console.log(`pending deduped by split address: ${fmtEth(dedupEth)} ETH + ${fmtUsdc(dedupUsdc)} USDC  (~$${usd(dedupEth, dedupUsdc)})`)
    if (price != null) console.log(`(ETH/USD from Chainlink: $${price.toFixed(2)})`)
  } else {
    console.log('\n(skipping the $ totals — balance reads were unavailable; the shared report above still stands)')
  }
} catch (e) {
  console.error(`failed: ${e.message}`)
  process.exit(1)
}
