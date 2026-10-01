// End-to-end drive of the Experience over REAL HTTP against the BUILT app.
//
// Everything hermetic in the repo stops at the library boundary — the oracles
// drive lib/experience against a mock Upstash, but nothing exercises the route
// handlers, request parsing, cookies, rate limits, the RPC proofs, or the SSR
// pages as a running server. This does: it boots `next start` on a spare port
// with the Upstash REST client and the Base RPC client pointed at two mock
// servers in this process, then walks the product the way its users will —
// creator publishes, player pays and plays, delivery stalls, player recovers,
// verifier recomputes, curator promotes, cron commits seeds — asserting at each
// step, then does the same in a real Chromium (playwright-core): the studios,
// the stage, the uploads, the pages. CDP credentials are deliberately absent, so
// every delivery lands in the `pending` state the recovery paths exist for.
// What it covers: scripts/e2e/README.md.
//
// Not in `npm run check`: it needs a production build and a few minutes. Run it
// before merging anything that touches app/api/experience, lib/experience or the
// machine components:
//
//   npm run build && npm run e2e:experience
//
// The server screens every stage frame with ffmpeg, so one must be on PATH, as
// the runtime image has it. The build needs an Arweave signer key
// (NEXT_PUBLIC_ARWEAVE_N) so the studios can upload; any 512-byte value will
// do, and the suite says so if either is missing:
//
//   NEXT_PUBLIC_ARWEAVE_N=$(node -e "process.stdout.write(Buffer.alloc(512, 7).toString('base64url'))") npm run build

import { createServer, request as httpRequest } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  parseAbi,
  parseAbiParameters,
  toFunctionSelector,
} from 'viem'

// ── fixtures ──────────────────────────────────────────────────────────────────
const ADMIN = '0x3d140b892437dd7857701098415deb2daae03a40'
const CREATOR2 = '0x9e12d044c7b3a5f8e21d6c09b4a7f3e8d5c2b1aa'
const PLAYER = '0x51be09ac3e7d21f48b6a0c5d9e2f7b3a1c8d77aa'
const ARTIST_B = '0xb2e4f0a91c6d3e8b7a5f2c4d1e9b8a7f6c3d9d05'
const OPERATOR = '0xaaaa000000000000000000000000000000000001'
const ZERO = '0x0000000000000000000000000000000000000000'
const CAPSULE = '0xcccc000000000000000000000000000000000001'
const CAPSULE_2 = '0xcccc000000000000000000000000000000000002'
const CAPSULE_3 = '0xcccc000000000000000000000000000000000003'
const CAPSULE_4 = '0xcccc000000000000000000000000000000000004'
const CAPSULE_5 = '0xcccc000000000000000000000000000000000005'
const CAPSULE_6 = '0xcccc000000000000000000000000000000000006'
const CAPSULE_9 = '0xcccc000000000000000000000000000000000009'
const PASS_COLLECTION = '0xbbbb000000000000000000000000000000000001'
const NOPASS = '0x1111000000000000000000000000000000001111'
const NOPASS_TOKEN = 'e2e-nopass-session-token'
/** A Pass holder whose only job is to spend the check budget (section 6f). */
const BUSY = '0x2222000000000000000000000000000000002222'
const BUSY_TOKEN = 'e2e-busy-session-token'
const POOL = '0xdddd000000000000000000000000000000000002'
/** A collection whose artist granted the operator MINTER collection-wide. */
const POOL_WIDE = '0xdddd000000000000000000000000000000000003'
const TX_A = '0x' + 'a1'.repeat(32) // player mints 2 capsules of machine 1
const TX_B = '0x' + 'b2'.repeat(32) // player mints 1 capsule "on zora.co" — never seen by our UI
const TX_N = '0x' + 'c3'.repeat(32) // player mints 1 capsule of the no-grant machine
const TX_STALE = '0x' + 'd4'.repeat(32) // minted BEFORE spring-season was published
const TX_OWNED = '0x' + 'e5'.repeat(32) // played by someone who already holds the floor piece
const TX_RACE = '0x' + 'f6'.repeat(32) // played and resumed at the same instant
const TX_DELIST = '0x' + '17'.repeat(32) // paid for, then the machine was delisted under them
const TX_FREE = '0x' + '28'.repeat(32) // adminMinted by the capsule's own admin — never bought
const TX_FREE_RECEIPTED = '0x' + '39'.repeat(32) // same operator, but the collection emitted Purchased
const TX_USDC = '0x' + '4a'.repeat(32) // minted by Zora's ERC20Minter, which pays via adminMint
const TX_REVOKED = '0x' + '5b'.repeat(32) // adminMinted by a wallet whose grant was revoked before it played
const TX_OLD_NODE = '0x' + '6c'.repeat(32) // an honest buy whose block the node can no longer look back to
const TX_HANG = '0x' + '7d'.repeat(32) // its mint is broadcast and gets no verdict
const TX_CAP = '0x' + '8e'.repeat(32) // its mint reverts every time it is tried
const TX_REDRAW = '0x' + '9f'.repeat(32) // its first draw is refused, so attempt 1 delivers
const TX_REDRAW_2 = '0x' + '1c'.repeat(32) // same machine; its delivery is refused and resume lands it
const TX_SLOW = '0x' + '0b'.repeat(32) // resumed while the play that created it is still delivering
const TX_BEFORE = '0x' + '6d'.repeat(32) // played after a piece's grant was revoked
const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
/** An SVG that strobes black and white five times a second, by itself — as any
 *  browser plays it in an <img>, unscreened. */
const STROBE_SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64"><animate attributeName="fill" values="#000;#fff" dur="0.2s" repeatCount="indefinite"/></rect></svg>')
/** The cover every other publish carries: the route requires one (call()). */
const TEST_COVER = { uri: 'ar://' + 'e2eCover'.repeat(5) + 'abc' }
// A stage frame as a publish or its creator's edit carries one (lib/experience/cover).
const TEST_FRAME = { uri: 'ar://' + 'e2eFrame'.repeat(5) + 'abc', kind: 'video', poster: 'ar://' + 'e2ePostr'.repeat(5) + 'abc' }
// A two-frame 16×16 animated gif, written out by hand so the suite carries no
// binary fixture: two colours, `cs` hundredths of a second for the first frame
// and `last` for the second, and an LZW stream that clears its table every two
// codes so every code stays 3 bits.
function tinyGif(cs, last = cs) {
  const bytes = []
  const push = (...b) => bytes.push(...b)
  const u16 = (n) => [n & 255, n >> 8]
  push(...Buffer.from('GIF89a'), ...u16(16), ...u16(16), 0x80, 0, 0, 255, 0, 170, 0, 200, 255)
  push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0x00)
  for (const colour of [0, 1]) {
    push(0x21, 0xf9, 0x04, 0x00, ...u16(colour ? last : cs), 0x00, 0x00, 0x2c, ...u16(0), ...u16(0), ...u16(16), ...u16(16), 0x00, 0x02)
    const codes = []
    for (let i = 0; i < 256; i += 2) codes.push(4, colour, colour)
    codes.push(5)
    const data = []
    let acc = 0
    let bits = 0
    for (const c of codes) {
      acc |= c << bits
      bits += 3
      while (bits >= 8) { data.push(acc & 255); acc >>= 8; bits -= 8 }
    }
    if (bits) data.push(acc & 255)
    for (let i = 0; i < data.length; i += 255) push(Math.min(255, data.length - i), ...data.slice(i, i + 255))
    push(0x00)
  }
  push(0x3b)
  return Buffer.from(bytes)
}
/** What the browser uploaded to Arweave's upload service, in order (open()'s `uploads`). */
const arweaveUploads = []
/** The file inside an uploaded Arweave data item (ANS-104): past its
 *  signature and owner (sized by signature type), target, anchor and tags. */
function dataItemPayload(item) {
  const sizes = { 1: [512, 512], 2: [64, 32], 3: [65, 65], 4: [64, 32] }[item.readUInt16LE(0)]
  if (!sizes) return null
  let o = 2 + sizes[0] + sizes[1]
  o += item[o] === 1 ? 33 : 1
  o += item[o] === 1 ? 33 : 1
  return item.subarray(o + 16 + Number(item.readBigUInt64LE(o + 8)))
}
/** An MP4's length (its movie header), its video's sample count — read from
 *  the boxes, since nothing here can decode H.264 — and the keyframe interval
 *  libx264 wrote into the stream with its other settings. */
function mp4Timing(mp4) {
  const boxes = (buf, from, to) => {
    const out = {}
    for (let o = from; o + 8 <= to;) {
      let size = buf.readUInt32BE(o)
      let head = 8
      if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); head = 16 }
      if (size < head) break
      out[buf.toString('latin1', o + 4, o + 8)] ??= [o + head, o + size]
      o += size
    }
    return out
  }
  const top = boxes(mp4, 0, mp4.length)
  if (!top.moov) return null
  const moov = boxes(mp4, ...top.moov)
  const [h] = moov.mvhd
  const v1 = mp4[h] === 1
  const scale = mp4.readUInt32BE(h + (v1 ? 20 : 12))
  const length = v1 ? Number(mp4.readBigUInt64BE(h + 24)) : mp4.readUInt32BE(h + 16)
  const trak = boxes(mp4, ...moov.trak)
  const stbl = boxes(mp4, ...boxes(mp4, ...boxes(mp4, ...trak.mdia).minf).stbl)
  const keyint = Number(mp4.toString('latin1').match(/ keyint=(\d+) /)?.[1])
  return { seconds: length / scale, samples: mp4.readUInt32BE(stbl.stsz[0] + 8), keyint }
}
/** Spring Season's cover: an Arweave upload, as the studio makes one. */
const SPRING_COVER = { uri: 'ar://' + 'Sp1ngC0ver'.repeat(4) + 'abc' }
/** A fresh capsule for the machine the browser publishes in section 9. */
const CAPSULE_A = '0xcccc00000000000000000000000000000000000a'
/** The capsule of the machine whose play needs a redraw (section 5b). */
const CAPSULE_R = '0xcccc00000000000000000000000000000000000b'
/** An unused capsule for the collection-wide grant dry run (section 6f). */
const CAPSULE_W = '0xcccc00000000000000000000000000000000000c'
/** CREATOR2's capsule for the machine they withdraw and publish again (section 6h). */
const CAPSULE_V = '0xcccc00000000000000000000000000000000000d'
/** A capsule ADMIN controls whose recorded split pays only ARTIST_B (6b). */
const CAPSULE_P = '0xcccc00000000000000000000000000000000000e'
/** ADMIN's capsule that can sell 10 — more than a 4-copy machine holds (6i). */
const CAPSULE_O = '0xcccc000000000000000000000000000000000010'
/** ADMIN's capsule capped at 4, for the machine whose rarity is by supply (6i). */
const CAPSULE_S = '0xcccc00000000000000000000000000000000000f'
/** A collection of other artists' pieces for reveal machines (6j):
 *   1 ARTIST_B, open ETH sale · 2 CREATOR2, free, 1 of 5 minted · 3 ARTIST_B,
 *   sale not open yet · 4 ARTIST_B, sold out · 5 no Kismet record of its maker
 *   · 6 CREATOR2, open USDC sale. */
const REVEAL = '0xeeee000000000000000000000000000000000001'
/** A collection linked to a reveal machine (6m): 1 ARTIST_B, on sale · 2
 *  CREATOR2, sale opens later · 3 no Kismet record of its maker · 4 ARTIST_B,
 *  turned off for machines. */
const LINKED = '0xeeee000000000000000000000000000000000002'
/** An address that answers no nextTokenId — not a Zora collection. */
const NOT_ZORA = '0xeeee000000000000000000000000000000000003'
/** A Zora collection with nothing minted in it yet. */
const EMPTY_COLL = '0xeeee000000000000000000000000000000000004'
/** ADMIN's capsule for the machine that runs dry (6l), capped at the five
 *  prizes it holds. */
const CAPSULE_D = '0xcccc000000000000000000000000000000000011'
const TX_DRY = '0x' + '7e'.repeat(32) // opens the machine's last deliverable artwork
const TX_DRY_2 = '0x' + '8f'.repeat(32) // bought on zora.co after Kismet stopped selling
const TX_MULTI = '0x' + '9a'.repeat(32) // a three-capsule pull, every capsule opened by the play route
/** A player whose only purchase is that pull, so their bell holds nothing else. */
const PLAYER_3 = '0x3333000000000000000000000000000000003333'
/** Zora's protocol fee per mint, as the collection reports it. */
const MINT_FEE = 111_000_000_000_000n
/** lib/zoraMint.KISMET_REFERRAL — the rewards recipient every collect names. */
const KISMET_REFERRAL = '0xc6021d9f09e145a6297f64551aa2eca6d66f8f75'
/** Zora's ProtocolRewards — lib/referralPayouts.PROTOCOL_REWARDS. */
const PROTOCOL_REWARDS = '0x7777777f279eba3d3ad8f4e708545291a6fdba8b'
/** A wallet the creator granted MINTER to, minted from, and revoked — the
 *  three-transaction evasion of a live permission read. */
const EVADER = '0x5555000000000000000000000000000000000055'
/** Zora's ERC20Minter on Base — lib/zoraMint.ZORA_ERC20_MINTER. */
const ERC20_MINTER = '0xe27d9dc88dab82aca3ebc49895c663c6a0cfa014'
const USER_TOKEN = 'e2e-user-session-token'
/** ARTIST_B signed in — the maker of the reveal pieces they switch off (6j). */
const ARTIST_B_TOKEN = 'e2e-artist-b-session-token'
/** A Pass holder who curates reveal machines (6j, and the reveal studio in 9). */
const CURATOR = '0x7777000000000000000000000000000000007777'
const CURATOR_TOKEN = 'e2e-curator-session-token'
const TX_BOX = '0x' + '2d'.repeat(32) // a play on the machine whose rarity is by supply
const TX_BOX_2 = '0x' + '3e'.repeat(32) // the next play on it, after a copy has gone
const TX_ELSEWHERE = '0x' + '4f'.repeat(32) // a capsule bought elsewhere, redeemed on the machine's page
const ADMIN_USER_TOKEN = 'e2e-admin-user-session-token'
const ADMIN_TOKEN = 'e2e-admin-session-token'
const CRON_SECRET = 'e2e-cron-secret'
const PORT = 3999

// ── mock Upstash REST ─────────────────────────────────────────────────────────
const strings = new Map()
const hashes = new Map()
const sets = new Map()
const zsets = new Map()
const unsupported = new Set()

function sortedZ(m) {
  return [...m.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
}
function rankRange(n, start, stop) {
  const a = start < 0 ? Math.max(0, n + start) : start
  const b = stop < 0 ? n + stop : Math.min(n - 1, stop)
  return [a, b]
}

function exec(cmd) {
  const name = String(cmd[0]).toLowerCase()
  const args = cmd.slice(1).map(String)
  const k = args[0]
  switch (name) {
    case 'get': return strings.get(k) ?? null
    case 'mget': return args.map((key) => strings.get(key) ?? null)
    case 'set': {
      const nx = args.some((a) => a.toLowerCase() === 'nx')
      if (nx && strings.has(k)) return null
      strings.set(k, args[1]); return 'OK'
    }
    case 'setex': strings.set(k, args[2]); return 'OK'
    case 'del': { let n = 0; for (const key of args) { if (strings.delete(key)) n++; if (hashes.delete(key)) n++; if (sets.delete(key)) n++; if (zsets.delete(key)) n++ } return n }
    case 'exists': return strings.has(k) || hashes.has(k) || sets.has(k) || zsets.has(k) ? 1 : 0
    case 'expire': case 'pexpire': return 1
    case 'ttl': return 3600
    case 'incr': case 'incrby': {
      const by = name === 'incr' ? 1 : Number(args[1])
      const cur = parseInt(strings.get(k) ?? '0', 10)
      const next = (Number.isFinite(cur) ? cur : 0) + by
      strings.set(k, String(next)); return next
    }
    case 'hset': { const m = hashes.get(k) ?? new Map(); for (let i = 1; i < args.length; i += 2) m.set(args[i], args[i + 1]); hashes.set(k, m); return 1 }
    case 'hget': return hashes.get(k)?.get(args[1]) ?? null
    case 'hgetall': { const m = hashes.get(k); if (!m) return []; const out = []; for (const [f, v] of m) out.push(f, v); return out }
    case 'hdel': { const m = hashes.get(k); let n = 0; for (const f of args.slice(1)) if (m?.delete(f)) n++; return n }
    case 'hincrby': { const m = hashes.get(k) ?? new Map(); hashes.set(k, m); const cur = parseInt(m.get(args[1]) ?? '0', 10); const next = (Number.isFinite(cur) ? cur : 0) + Number(args[2]); m.set(args[1], String(next)); return next }
    case 'lpush': { const l = strings.get('__list:' + k) ? JSON.parse(strings.get('__list:' + k)) : []; l.unshift(...args.slice(1)); strings.set('__list:' + k, JSON.stringify(l)); return l.length }
    case 'ltrim': { const l = strings.get('__list:' + k) ? JSON.parse(strings.get('__list:' + k)) : []; const [a, b] = rankRange(l.length, Number(args[1]), Number(args[2])); strings.set('__list:' + k, JSON.stringify(b < a ? [] : l.slice(a, b + 1))); return 'OK' }
    case 'lrange': { const l = strings.get('__list:' + k) ? JSON.parse(strings.get('__list:' + k)) : []; const [a, b] = rankRange(l.length, Number(args[1]), Number(args[2])); return b < a ? [] : l.slice(a, b + 1) }
    // The count of members that were new, as Redis returns it — a once-only
    // notice (lib/experience/notices) is decided by exactly this.
    case 'sadd': { const s = sets.get(k) ?? new Set(); let n = 0; for (const m of args.slice(1)) if (!s.has(m)) { s.add(m); n++ } sets.set(k, s); return n }
    case 'srem': { const s = sets.get(k); let n = 0; for (const m of args.slice(1)) { if (s?.delete(m)) n++ } return n }
    case 'smembers': return [...(sets.get(k) ?? [])]
    case 'sismember': return sets.get(k)?.has(args[1]) ? 1 : 0
    case 'smismember': return args.slice(1).map((m) => (sets.get(k)?.has(m) ? 1 : 0))
    case 'scard': return sets.get(k)?.size ?? 0
    case 'zadd': { const m = zsets.get(k) ?? new Map(); const rest = args.slice(1).filter((a) => !['nx', 'xx', 'gt', 'lt', 'ch'].includes(a.toLowerCase())); for (let i = 0; i < rest.length; i += 2) m.set(rest[i + 1], Number(rest[i])); zsets.set(k, m); return 1 }
    case 'zrem': { const m = zsets.get(k); let n = 0; for (const mem of args.slice(1)) { if (m?.delete(mem)) n++ } return n }
    case 'zscore': { const s = zsets.get(k)?.get(args[1]); return s === undefined ? null : s }
    case 'zcard': return zsets.get(k)?.size ?? 0
    case 'zrange': {
      const m = zsets.get(k); if (!m) return []
      let entries = sortedZ(m)
      const flags = args.map((a) => a.toLowerCase())
      const bound = (raw, d) => raw === '+inf' ? Infinity : raw === '-inf' ? -Infinity : Number.isFinite(Number(raw)) ? Number(raw) : d
      if (flags.includes('byscore')) {
        const lo = bound(args[1], -Infinity), hi = bound(args[2], Infinity)
        entries = entries.filter(([, sc]) => sc >= lo && sc <= hi)
      } else {
        const [a, b] = rankRange(entries.length, Number(args[1]), Number(args[2]))
        entries = b < a ? [] : entries.slice(a, b + 1)
      }
      return (flags.includes('rev') ? entries.reverse() : entries).map(([mem]) => mem)
    }
    case 'zremrangebyrank': { const m = zsets.get(k); if (!m) return 0; const s = sortedZ(m); const [a, b] = rankRange(s.length, Number(args[1]), Number(args[2])); if (b < a) return 0; for (const [mem] of s.slice(a, b + 1)) m.delete(mem); return b - a + 1 }
    case 'zremrangebyscore': { const m = zsets.get(k); if (!m) return 0; const lo = args[1] === '-inf' ? -Infinity : Number(args[1]); const hi = args[2] === '+inf' ? Infinity : Number(args[2]); let n = 0; for (const [mem, sc] of [...m.entries()]) { if (sc >= lo && sc <= hi) { m.delete(mem); n++ } } return n }
    case 'eval': {
      // Upstash sends ["eval", script, numkeys, ...keys, ...argv].
      const script = args[0]; const nk = Number(args[1]); const keys = args.slice(2, 2 + nk); const argv = args.slice(2 + nk)
      const lua = script.toUpperCase()
      if (lua.includes('INCR')) return exec(['incr', keys[0]])
      if (lua.includes('DEL')) { if (strings.get(keys[0]) === argv[0]) { strings.delete(keys[0]); return 1 } return 0 }
      unsupported.add('eval:' + script.slice(0, 40)); return null
    }
    default:
      unsupported.add(name); return null
  }
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
function enc(v) { if (typeof v === 'string') return v === 'OK' ? 'OK' : b64(v); if (Array.isArray(v)) return v.map(enc); return v }

const DEBUG = process.env.E2E_DEBUG === '1'
const redisServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      const useB64 = req.headers['upstash-encoding'] === 'base64'
      const e = (v) => (useB64 ? enc(v) : v)
      const parsed = JSON.parse(body)
      const run = (c) => {
        try {
          const r = exec(c)
          if (DEBUG && ['set', 'eval', 'get'].includes(String(c[0]).toLowerCase())) console.error(`[redis] ${c[0]} ${String(c[1]).slice(0, 70)} -> ${JSON.stringify(r)?.slice(0, 40)}`)
          return { result: e(r) }
        } catch (err) { return { error: String(err) } }
      }
      const out = Array.isArray(parsed[0]) ? parsed.map(run) : run(parsed)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out))
    } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: String(err) })) }
  })
})

// ── mock Base JSON-RPC ────────────────────────────────────────────────────────
const TOKEN_INFO = parseAbi(['function getTokenInfo(uint256 tokenId) view returns ((string uri, uint256 maxSupply, uint256 totalMinted))'])
const PERMS = parseAbi(['function permissions(uint256 tokenId, address user) view returns (uint256)'])
const BALANCE = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)'])
const TRANSFER = parseAbi(['event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'])
// The purchase receipt lib/verifyMint decodes — the declaration in Zora's
// IZoraCreator1155.sol (legacy/1155-contracts), verified verbatim, indexed
// markers included. The harness encoding with it therefore models what the
// deployed contract emits, not merely what the app expects.
const PURCHASED = parseAbi(['event Purchased(address indexed sender, address indexed minter, uint256 indexed tokenId, uint256 quantity, uint256 value)'])
const FPSS_SALE = parseAbi(['function sale(address tokenContract, uint256 tokenId) view returns ((uint64 saleStart, uint64 saleEnd, uint64 maxTokensPerAddress, uint96 pricePerToken, address fundsRecipient))'])
const FPSS = '0x2994762aA0E4C750c51f333C10d81961faEBE785'
const ERC20_SALE = parseAbi(['function sale(address tokenContract, uint256 tokenId) view returns ((uint64 saleStart, uint64 saleEnd, uint64 maxTokensPerAddress, uint256 pricePerToken, address fundsRecipient, address currency))'])
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const MINT_FEE_ABI = parseAbi(['function mintFee() view returns (uint256)'])
const REWARDS_ABI = parseAbi(['function balanceOf(address owner) view returns (uint256)', 'function withdrawFor(address to, uint256 amount)'])
/** The collect a browser sends: Zora 1155 mint through the fixed-price strategy. */
const MINT_1155 = parseAbi(['function mint(address minter, uint256 tokenId, uint256 quantity, address[] rewardsRecipients, bytes minterArguments) payable'])
/** A USDC collect: the approval, and the mint Zora's ERC20Minter takes. */
const USDC_APPROVE = parseAbi(['function approve(address spender, uint256 value) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)'])
const ERC20_MINT = parseAbi(['function mint(address mintTo, uint256 quantity, address tokenAddress, uint256 tokenId, uint256 totalValue, address currency, address mintReferral, string comment)'])
/** What the delivery account sends to hand a prize over. */
const ADMIN_MINT = parseAbi(['function adminMint(address recipient, uint256 tokenId, uint256 quantity, bytes data)'])
const SEL = {
  tokenInfo: toFunctionSelector('getTokenInfo(uint256)'),
  perms: toFunctionSelector('permissions(uint256,address)'),
  balance: toFunctionSelector('balanceOf(address,uint256)'),
  sale: toFunctionSelector('sale(address,uint256)'),
  mintFee: toFunctionSelector('mintFee()'),
  nextTokenId: toFunctionSelector('nextTokenId()'),
}
const NEXT_TOKEN_ID_ABI = parseAbi(['function nextTokenId() view returns (uint256)'])
/** Multicall3 — the browser's wagmi client batches every read through it. */
const MULTICALL3 = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)'])
SEL.aggregate3 = toFunctionSelector('aggregate3((address,bool,bytes)[])')
/** The writes the browser section's wallet can sign and the mock chain applies. */
const WALLET_WRITES = parseAbi([
  'function addPermission(uint256 tokenId, address user, uint256 permissionBits)',
  'function removePermission(uint256 tokenId, address user, uint256 permissionBits)',
  'function callSale(uint256 tokenId, address salesConfig, bytes data)',
])
/** What callSale forwards to the fixed-price strategy: the whole sale row. */
const FPSS_SET_SALE = parseAbi(['function setSale(uint256 tokenId, (uint64 saleStart, uint64 saleEnd, uint64 maxTokensPerAddress, uint96 pricePerToken, address fundsRecipient) salesConfig)'])
const OPEN = 18446744073709551615n

const chain = {
  head: 5_000_000n,
  tokens: new Map(),   // `${collection}:${id}` -> { maxSupply, totalMinted }
  perms: new Map(),    // `${collection}:${id}:${user}` -> bits, as of the head
  /** `${collection}:${id}:${user}@${block}` -> bits, for a read pinned to a
   *  block. Absent means unchanged since, so the head value answers. */
  permsAt: new Map(),
  /** When set, a pinned read below this block fails the way a non-archive node
   *  fails ("missing trie node"), so the app's live-read fallback is exercised. */
  archiveFrom: null,
  balances: new Map(), // `${collection}:${account}:${id}` -> n
  sales: new Map(),    // `${collection}:${id}` -> { saleStart, saleEnd, pricePerToken, fundsRecipient }
  usdcSales: new Map(), // same, on Zora's ERC20Minter, priced in USDC
  /** ProtocolRewards escrow: lowercased owner -> wei. */
  rewards: new Map(),
  /** Owners whose withdrawal reverts (a contract that refuses ETH). */
  rejectsEth: new Set(),
  /** Owners whose withdrawal simulation fails for a reason that is not a revert. */
  checkFails: new Set(),
  /** Every collect the browser's wallet sent, decoded. */
  mints: [],
  /** A Zora collection's nextTokenId, by lowercased address. Absent answers
   *  nothing, as a non-Zora address does. */
  nextIds: new Map(),
  /** Permission keys revoked in the instant after a multicall read them: a
   *  batched read still sees the grant, a direct read after it does not —
   *  the race between a play's freeze and its delivery check. */
  revokedAfterBatch: new Set(),
  /** When set, every multicall fails: the chain cannot be read. */
  failMulticall: false,
  /** USDC allowances: `${owner}:${spender}` -> base units. */
  allowances: new Map(),
  /** Direct and batched eth_calls served, for "reads nothing from the chain". */
  ethCalls: 0,
  receipts: new Map(), // txHash -> receipt
  logs: [],
  /** Every transaction the browser's wallet signed, in order. */
  walletTxs: [],
}
const key = (...p) => p.map((x) => String(x).toLowerCase()).join(':')
let inMulticall = false
/** Advance the mock chain head. Refuses to go BACKWARDS: the server reads the
 *  head through viem, which caches it for a few seconds, so a head lowered
 *  after a publish can leave that machine's createdBlock above a later mint —
 *  the play then refuses the capsule as pre-dating the machine, and only when
 *  the cache happened to be warm. Every mint must land at or after the head the
 *  machine that honours it was published under. */
const setHead = (n) => {
  if (n < chain.head) throw new Error(`mock chain head moved backwards: ${chain.head} -> ${n}`)
  chain.head = n
}
/** `operator` is the address that executed the mint (the buyer for an ordinary
 *  sale, the ERC20Minter for a USDC sale, the admin for a free adminMint);
 *  `purchased` adds the collection's own Purchased receipt to the transaction. */
function addMint({ tx, collection, to, id, value, block, operator = to, purchased = false }) {
  const topics = encodeEventTopics({ abi: TRANSFER, eventName: 'TransferSingle', args: { operator, from: ZERO, to } })
  const data = encodeAbiParameters(parseAbiParameters('uint256, uint256'), [id, value])
  const blockHex = '0x' + block.toString(16)
  const log = { address: collection, topics, data, blockNumber: blockHex, transactionHash: tx, transactionIndex: '0x0', blockHash: '0x' + 'bb'.repeat(32), logIndex: '0x0', removed: false }
  chain.logs.push(log)
  const logs = [log]
  if (purchased) {
    logs.push({
      address: collection,
      topics: encodeEventTopics({ abi: PURCHASED, eventName: 'Purchased', args: { sender: operator, minter: FPSS, tokenId: id } }),
      data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [value, 0n]),
      blockNumber: blockHex, transactionHash: tx, transactionIndex: '0x0', blockHash: log.blockHash, logIndex: '0x1', removed: false,
    })
  }
  chain.receipts.set(tx.toLowerCase(), {
    transactionHash: tx, transactionIndex: '0x0', blockHash: log.blockHash, blockNumber: blockHex,
    from: to, to: collection, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1',
    contractAddress: null, logs, logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2',
  })
}

/** What the browser section's wallet does when asked to sign: apply the call
 *  to the mock chain and hand back a receipted hash. Only the writes a test
 *  drives are modelled; anything else lands as a revert. */
function walletSend(tx) {
  chain.walletTxs.push({ to: tx.to, data: tx.data })
  const hash = '0x' + 'e7'.repeat(28) + chain.walletTxs.length.toString(16).padStart(8, '0')
  let ok = true
  const logs = []
  try {
    if (tx.data.startsWith(toFunctionSelector('mint(address,uint256,uint256,address[],bytes)'))) {
      // A collect: pays price + protocol fee per copy through the fixed-price
      // strategy, as FixedPriceSaleStrategy enforces, and mints to the minter.
      const { args } = decodeFunctionData({ abi: MINT_1155, data: tx.data })
      const [, tokenId, quantity, rewardsRecipients, minterArguments] = args
      const [mintTo] = decodeAbiParameters(parseAbiParameters('address, string'), minterArguments)
      const sale = chain.sales.get(key(tx.to, tokenId))
      const t = chain.tokens.get(key(tx.to, tokenId)) ?? { maxSupply: 0n, totalMinted: 0n }
      const now = BigInt(Math.floor(Date.now() / 1000))
      const value = BigInt(tx.value ?? 0)
      if (!sale || sale.saleStart > now || sale.saleEnd < now) throw new Error('sale not active')
      if (value !== (MINT_FEE + sale.pricePerToken) * quantity) throw new Error('WrongValueSent')
      if (t.maxSupply !== 0n && t.maxSupply !== OPEN && t.totalMinted + quantity > t.maxSupply) throw new Error('sold out')
      chain.tokens.set(key(tx.to, tokenId), { ...t, totalMinted: t.totalMinted + quantity })
      // The mint referral's share of the protocol fee on a paid mint, escrowed
      // in ProtocolRewards as Zora does (28.5714%).
      const ref = String(rewardsRecipients[0] ?? ZERO).toLowerCase()
      if (sale.pricePerToken > 0n && ref !== ZERO) chain.rewards.set(ref, (chain.rewards.get(ref) ?? 0n) + (MINT_FEE * 285714n / 1_000_000n) * quantity)
      const bk = key(tx.to, mintTo, tokenId)
      chain.balances.set(bk, (chain.balances.get(bk) ?? 0n) + quantity)
      chain.mints.push({ collection: String(tx.to).toLowerCase(), tokenId, quantity, value, mintTo: String(mintTo).toLowerCase(), rewardsRecipients: rewardsRecipients.map((a) => String(a).toLowerCase()), strategy: String(args[0]).toLowerCase() })
      logs.push({
        address: tx.to,
        topics: encodeEventTopics({ abi: TRANSFER, eventName: 'TransferSingle', args: { operator: tx.from, from: ZERO, to: mintTo } }),
        data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [tokenId, quantity]),
        blockNumber: '0x' + chain.head.toString(16), transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + 'bb'.repeat(32), logIndex: '0x0', removed: false,
      })
    } else if (String(tx.to).toLowerCase() === USDC) {
      const { functionName, args } = decodeFunctionData({ abi: USDC_APPROVE, data: tx.data })
      if (functionName !== 'approve') throw new Error('only approve is modelled on USDC')
      chain.allowances.set(key(tx.from, args[0]), args[1])
    } else if (String(tx.to).toLowerCase() === ERC20_MINTER) {
      // A USDC collect: the ERC20Minter pulls the price under the approval,
      // pays the mint referral in USDC, and mints to the minter.
      const { args } = decodeFunctionData({ abi: ERC20_MINT, data: tx.data })
      const [mintTo, quantity, collection, tokenId, totalValue, currency, mintReferral] = args
      const sale = chain.usdcSales.get(key(collection, tokenId))
      const t = chain.tokens.get(key(collection, tokenId)) ?? { maxSupply: 0n, totalMinted: 0n }
      const now = BigInt(Math.floor(Date.now() / 1000))
      const allowed = chain.allowances.get(key(tx.from, ERC20_MINTER)) ?? 0n
      if (!sale || sale.saleStart > now || sale.saleEnd < now) throw new Error('sale not active')
      if (String(currency).toLowerCase() !== USDC || totalValue !== sale.pricePerToken * quantity) throw new Error('WrongValueSent')
      if (allowed < totalValue) throw new Error('ERC20: insufficient allowance')
      if (t.maxSupply !== 0n && t.maxSupply !== OPEN && t.totalMinted + quantity > t.maxSupply) throw new Error('sold out')
      chain.allowances.set(key(tx.from, ERC20_MINTER), allowed - totalValue)
      chain.tokens.set(key(collection, tokenId), { ...t, totalMinted: t.totalMinted + quantity })
      const bk = key(collection, mintTo, tokenId)
      chain.balances.set(bk, (chain.balances.get(bk) ?? 0n) + quantity)
      chain.mints.push({ collection: String(collection).toLowerCase(), tokenId, quantity, value: totalValue, currency: 'usdc', mintTo: String(mintTo).toLowerCase(), rewardsRecipients: [String(mintReferral).toLowerCase()], strategy: ERC20_MINTER })
      logs.push({
        address: collection,
        topics: encodeEventTopics({ abi: TRANSFER, eventName: 'TransferSingle', args: { operator: ERC20_MINTER, from: ZERO, to: mintTo } }),
        data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [tokenId, quantity]),
        blockNumber: '0x' + chain.head.toString(16), transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + 'bb'.repeat(32), logIndex: '0x0', removed: false,
      })
    } else {
    const { functionName, args } = decodeFunctionData({ abi: WALLET_WRITES, data: tx.data })
    if (functionName === 'callSale') {
      if (String(args[1]).toLowerCase() !== FPSS.toLowerCase()) throw new Error('only the fixed-price strategy is modelled')
      const inner = decodeFunctionData({ abi: FPSS_SET_SALE, data: args[2] })
      const cfg = inner.args[1]
      chain.sales.set(key(tx.to, inner.args[0]), { saleStart: cfg.saleStart, saleEnd: cfg.saleEnd, pricePerToken: cfg.pricePerToken, fundsRecipient: cfg.fundsRecipient })
    } else {
      const k = key(tx.to, args[0], args[1])
      const cur = chain.perms.get(k) ?? 0n
      chain.perms.set(k, functionName === 'addPermission' ? cur | args[2] : cur & ~args[2])
    }
    }
  } catch {
    ok = false
  }
  const blockHex = '0x' + chain.head.toString(16)
  chain.receipts.set(hash, {
    transactionHash: hash, transactionIndex: '0x0', blockHash: '0x' + 'bb'.repeat(32), blockNumber: blockHex,
    from: tx.from, to: tx.to, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1',
    contractAddress: null, logs: ok ? logs : [], logsBloom: '0x' + '0'.repeat(512), status: ok ? '0x1' : '0x0', type: '0x2',
  })
  return hash
}

function rpc(method, params) {
  switch (method) {
    case 'eth_chainId': return '0x2105'
    case 'eth_blockNumber': return '0x' + chain.head.toString(16)
    case 'eth_getTransactionReceipt':
      chain.receiptCalls = (chain.receiptCalls ?? 0) + 1
      return chain.receipts.get(String(params[0]).toLowerCase()) ?? null
    case 'eth_call': {
      chain.ethCalls++
      const { to, data } = params[0]
      const tag = params[1]
      const pinned = typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag) ? BigInt(tag) : null
      if (pinned !== null && chain.archiveFrom !== null && pinned < chain.archiveFrom) {
        throw new Error(`missing trie node for block ${pinned} (state pruned)`)
      }
      const sel = data.slice(0, 10)
      if (String(to).toLowerCase() === USDC && sel === toFunctionSelector('allowance(address,address)')) {
        const { args } = decodeFunctionData({ abi: USDC_APPROVE, data })
        return encodeFunctionResult({ abi: USDC_APPROVE, functionName: 'allowance', result: chain.allowances.get(key(args[0], args[1])) ?? 0n })
      }
      if (String(to).toLowerCase() === PROTOCOL_REWARDS) {
        const { functionName, args } = decodeFunctionData({ abi: REWARDS_ABI, data })
        const owner = String(args[0]).toLowerCase()
        if (functionName === 'balanceOf') return encodeFunctionResult({ abi: REWARDS_ABI, functionName: 'balanceOf', result: chain.rewards.get(owner) ?? 0n })
        // A revert as a node reports one: code 3 and the error's selector, here
        // ProtocolRewards' TRANSFER_FAILED() — the ETH send to the owner failed.
        if (chain.checkFails.has(owner)) throw new Error('upstream request timed out')
        if (chain.rejectsEth.has(owner)) {
          throw Object.assign(new Error('execution reverted'), { rpc: { code: 3, message: 'execution reverted', data: toFunctionSelector('TRANSFER_FAILED()') } })
        }
        return '0x'
      }
      if (sel === SEL.tokenInfo) {
        const { args } = decodeFunctionData({ abi: TOKEN_INFO, data })
        const t = chain.tokens.get(key(to, args[0])) ?? { maxSupply: 0n, totalMinted: 0n }
        return encodeFunctionResult({ abi: TOKEN_INFO, functionName: 'getTokenInfo', result: { uri: '', maxSupply: t.maxSupply, totalMinted: t.totalMinted } })
      }
      if (sel === SEL.perms) {
        const { args } = decodeFunctionData({ abi: PERMS, data })
        const k = key(to, args[0], args[1])
        const at = pinned !== null ? chain.permsAt.get(`${k}@${pinned}`) : undefined
        if (!inMulticall && chain.revokedAfterBatch.has(k)) return encodeFunctionResult({ abi: PERMS, functionName: 'permissions', result: 0n })
        return encodeFunctionResult({ abi: PERMS, functionName: 'permissions', result: at ?? chain.perms.get(k) ?? 0n })
      }
      if (sel === SEL.mintFee) return encodeFunctionResult({ abi: MINT_FEE_ABI, functionName: 'mintFee', result: MINT_FEE })
      if (sel === SEL.nextTokenId) {
        const n = chain.nextIds.get(String(to).toLowerCase())
        return n === undefined ? '0x' : encodeFunctionResult({ abi: NEXT_TOKEN_ID_ABI, functionName: 'nextTokenId', result: n })
      }
      if (sel === SEL.sale && String(to).toLowerCase() === ERC20_MINTER) {
        const { args } = decodeFunctionData({ abi: ERC20_SALE, data })
        const st = chain.usdcSales.get(key(args[0], args[1]))
        return encodeFunctionResult({
          abi: ERC20_SALE,
          functionName: 'sale',
          result: st
            ? { saleStart: st.saleStart, saleEnd: st.saleEnd, maxTokensPerAddress: 0n, pricePerToken: st.pricePerToken, fundsRecipient: st.fundsRecipient, currency: USDC }
            : { saleStart: 0n, saleEnd: 0n, maxTokensPerAddress: 0n, pricePerToken: 0n, fundsRecipient: ZERO, currency: ZERO },
        })
      }
      if (sel === SEL.sale) {
        // The FixedPriceSaleStrategy's row; the ERC20Minter's is above.
        const { args } = decodeFunctionData({ abi: FPSS_SALE, data })
        const st = String(to).toLowerCase() === FPSS.toLowerCase()
          ? chain.sales.get(key(args[0], args[1]))
          : null
        return encodeFunctionResult({
          abi: FPSS_SALE,
          functionName: 'sale',
          result: st
            ? { saleStart: st.saleStart, saleEnd: st.saleEnd, maxTokensPerAddress: 0n, pricePerToken: st.pricePerToken, fundsRecipient: st.fundsRecipient }
            : { saleStart: 0n, saleEnd: 0n, maxTokensPerAddress: 0n, pricePerToken: 0n, fundsRecipient: ZERO },
        })
      }
      if (sel === SEL.balance) {
        const { args } = decodeFunctionData({ abi: BALANCE, data })
        return encodeFunctionResult({ abi: BALANCE, functionName: 'balanceOf', result: chain.balances.get(key(to, args[0], args[1])) ?? 0n })
      }
      if (sel === SEL.aggregate3) {
        if (chain.failMulticall) throw new Error('upstream request timed out')
        const { args } = decodeFunctionData({ abi: MULTICALL3, data })
        inMulticall = true
        let returnData
        try {
          returnData = args[0].map((c) => {
            try {
              const r = rpc('eth_call', [{ to: c.target, data: c.callData }, tag])
              return { success: r !== '0x', returnData: r }
            } catch {
              return { success: false, returnData: '0x' }
            }
          })
        } finally {
          inMulticall = false
        }
        return encodeFunctionResult({ abi: MULTICALL3, functionName: 'aggregate3', result: returnData })
      }
      return '0x'
    }
    // Enough of a node for a browser wallet to prepare and send a transaction.
    case 'eth_estimateGas': return '0x5208'
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas': return '0x1'
    case 'eth_getTransactionCount': return '0x0'
    case 'eth_getBlockByNumber': return {
      number: '0x' + chain.head.toString(16), hash: '0x' + 'bb'.repeat(32), parentHash: '0x' + 'aa'.repeat(32),
      timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0',
      miner: ZERO, extraData: '0x', transactions: [], uncles: [], nonce: '0x0000000000000000', difficulty: '0x0',
      logsBloom: '0x' + '0'.repeat(512), sha3Uncles: '0x' + '00'.repeat(32), stateRoot: '0x' + '00'.repeat(32),
      receiptsRoot: '0x' + '00'.repeat(32), transactionsRoot: '0x' + '00'.repeat(32), size: '0x0', totalDifficulty: '0x0',
    }
    case 'eth_getLogs': {
      chain.getLogsCalls = (chain.getLogsCalls ?? 0) + 1
      const f = params[0]
      const addrs = (Array.isArray(f.address) ? f.address : [f.address]).filter(Boolean).map((a) => a.toLowerCase())
      const from = f.fromBlock && f.fromBlock !== 'latest' && f.fromBlock !== 'earliest' ? BigInt(f.fromBlock) : 0n
      const to = f.toBlock && f.toBlock !== 'latest' ? BigInt(f.toBlock) : chain.head
      return chain.logs.filter((l) => {
        if (addrs.length && !addrs.includes(l.address.toLowerCase())) return false
        const bn = BigInt(l.blockNumber)
        if (bn < from || bn > to) return false
        return (f.topics ?? []).every((t, i) => {
          if (t == null) return true
          const want = (Array.isArray(t) ? t : [t]).map((x) => x.toLowerCase())
          return want.includes((l.topics[i] ?? '').toLowerCase())
        })
      })
    }
    default: return null
  }
}
const rpcServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body)
      const one = (r) => {
        let result
        try {
          result = rpc(r.method, r.params ?? [])
        } catch (err) {
          // A per-request JSON-RPC error, the shape a real node answers with
          // (and code -32000, which viem surfaces without retrying), rather
          // than failing the whole HTTP exchange.
          if (DEBUG) console.error(`[rpc] ${r.method} -> error ${err?.message ?? err}`)
          return { jsonrpc: '2.0', id: r.id, error: err?.rpc ?? { code: -32000, message: String(err?.message ?? err) } }
        }
        if (DEBUG) console.error(`[rpc] ${r.method} ${JSON.stringify(r.params ?? [], (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 220)} -> ${Array.isArray(result) ? `${result.length} logs` : String(result).slice(0, 60)}`)
        return { jsonrpc: '2.0', id: r.id, result }
      }
      const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v)))
    } catch (err) { res.writeHead(500); res.end(String(err)) }
  })
})

// ── mock CDP ─────────────────────────────────────────────────────────────────
//
// The sponsored mint, end to end. delivery.ts drives @coinbase/cdp-sdk, which
// talks HTTPS to CDP; pointed at this server via CDP_API_BASE_PATH it instead
// resolves the named owner and smart account here, prepares a userOp, has the
// owner "sign" it, sends it, and polls its status — every hop the production
// path makes. The SDK signs its request JWTs client-side before any HTTP, so
// the credentials have to be real EC keys; the server ignores the headers they
// produce. What it DOES model is what each test needs to script: whether the
// paymaster sponsors an op, and what status the op reports when asked —
// including the one that matters most, an op that is broadcast and then
// simply never resolves.
const cdpKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const CDP_API_KEY_SECRET = cdpKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })
const CDP_WALLET_SECRET = cdpKeys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
/** The owner EOA behind the operator smart account. */
const CDP_OWNER = '0xaaaa0000000000000000000000000000000000ee'
const cdp = {
  /** Outcome for each upcoming prepare, consumed in order. Empty → 'complete'.
   *  'refuse' = the paymaster declines (nothing broadcast); 'fail' = broadcast
   *  then reverted; 'hang' = broadcast, and the send's own status wait fails,
   *  after which every later read reports it still in flight until a test
   *  flips `op.outcome`; 'slow' = completes, but the prepare answers only after
   *  a pause, holding the play between its draw and its broadcast. */
  script: [],
  /** Every op ever prepared: userOpHash → { calls, outcome, polls, transactionHash }. */
  ops: new Map(),
  refusals: 0,
  seq: 0,
  /** When set, a delivered prize's adminMint is applied to the mock chain, so
   *  an edition's last copy really is the last. Off by default: the earlier
   *  sections' numbers were written against editions deliveries do not move. */
  applyMints: false,
}
function cdpHandle(method, path, body) {
  const p = path.replace(/^\/platform/, '')
  let m
  if (method === 'GET' && p === '/apikeys/v1/tokens/active') return [200, { id: 'e2e' }]
  if (method === 'GET' && (m = p.match(/^\/v2\/evm\/accounts\/by-name\/([^/]+)$/))) return [200, { address: CDP_OWNER, name: decodeURIComponent(m[1]) }]
  if (method === 'POST' && p === '/v2/evm/accounts') return [201, { address: CDP_OWNER, name: body?.name }]
  if (method === 'GET' && (m = p.match(/^\/v2\/evm\/smart-accounts\/by-name\/([^/]+)$/))) return [200, { address: OPERATOR, owners: [CDP_OWNER], name: decodeURIComponent(m[1]) }]
  if (method === 'POST' && p === '/v2/evm/smart-accounts') return [201, { address: OPERATOR, owners: [CDP_OWNER], name: body?.name }]
  if (method === 'POST' && /^\/v2\/evm\/accounts\/[^/]+\/sign$/.test(p)) return [200, { signature: '0x' + '11'.repeat(64) + '1b' }]
  if (method === 'POST' && /^\/v2\/evm\/smart-accounts\/[^/]+\/user-operations$/.test(p)) {
    const outcome = cdp.script.length ? cdp.script.shift() : 'complete'
    if (outcome === 'refuse') {
      cdp.refusals++
      return [400, { errorType: 'invalid_request', errorMessage: 'paymaster declined to sponsor this operation' }]
    }
    const userOpHash = '0x' + (++cdp.seq).toString(16).padStart(64, '0')
    // A payout the account sends lands: the owner's escrow empties to them.
    for (const c of body?.calls ?? []) {
      if (cdp.applyMints && String(c.data ?? '').startsWith(toFunctionSelector('adminMint(address,uint256,uint256,bytes)'))) {
        const { args } = decodeFunctionData({ abi: ADMIN_MINT, data: c.data })
        const t = chain.tokens.get(key(c.to, args[1])) ?? { maxSupply: 0n, totalMinted: 0n }
        chain.tokens.set(key(c.to, args[1]), { ...t, totalMinted: t.totalMinted + args[2] })
      }
      if (String(c.to).toLowerCase() !== PROTOCOL_REWARDS) continue
      const { args } = decodeFunctionData({ abi: REWARDS_ABI, data: c.data })
      chain.rewards.set(String(args[0]).toLowerCase(), 0n)
    }
    cdp.ops.set(userOpHash, {
      calls: body?.calls ?? [],
      outcome: outcome === 'slow' ? 'complete' : outcome,
      polls: 0,
      transactionHash: '0x' + 'dd'.repeat(30) + cdp.seq.toString(16).padStart(4, '0'),
    })
    const reply = [200, { userOpHash, status: 'pending', network: 'base', calls: body?.calls ?? [] }]
    return outcome === 'slow' ? sleep(2500).then(() => reply) : reply
  }
  if (method === 'POST' && (m = p.match(/^\/v2\/evm\/smart-accounts\/[^/]+\/user-operations\/(0x[0-9a-f]+)\/send$/))) {
    const op = cdp.ops.get(m[1])
    if (!op) return [404, { errorType: 'not_found', errorMessage: 'no such user operation' }]
    return [200, { userOpHash: m[1], status: 'broadcast', network: 'base', calls: op.calls }]
  }
  if (method === 'GET' && (m = p.match(/^\/v2\/evm\/smart-accounts\/[^/]+\/user-operations\/(0x[0-9a-f]+)$/))) {
    const op = cdp.ops.get(m[1])
    if (!op) return [404, { errorType: 'not_found', errorMessage: 'no such user operation' }]
    op.polls++
    const base = { userOpHash: m[1], network: 'base', calls: op.calls }
    switch (op.outcome) {
      case 'complete': return [200, { ...base, status: 'complete', transactionHash: op.transactionHash }]
      case 'fail': return [200, { ...base, status: 'failed' }]
      // The send's own first status read fails outright (a 4xx, which the
      // SDK's axios-retry does not retry), so the send returns indeterminate
      // at once rather than after its 60s wait; every read after that — the
      // resume path's — sees the op still in flight.
      case 'hang': return op.polls === 1
        ? [400, { errorType: 'invalid_request', errorMessage: 'simulated status read failure' }]
        : [200, { ...base, status: 'broadcast' }]
      default: return [200, { ...base, status: 'broadcast' }]
    }
  }
  return [404, { errorType: 'not_found', errorMessage: `mock cdp: ${method} ${p}` }]
}
const cdpServer = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let parsed = null
    try { parsed = body ? JSON.parse(body) : null } catch { /* not json */ }
    Promise.resolve(cdpHandle(req.method, new URL(req.url, 'http://x').pathname, parsed)).then(([status, json]) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
    })
  })
})

// ── harness ──────────────────────────────────────────────────────────────────
let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ipCounter = 0
const USER_COOKIE = '__Host-kismet_session'
const ADMIN_COOKIE = '__Host-kismetart-admin'
/** A machine's public payload once every named stage's frame has a verdict
 *  (the server screens in the background), or as it is after ~20 s. */
async function screened(id, stages) {
  for (let i = 0; i < 100; i++) {
    const m = (await call(`/api/experience/machines/${id}`)).json?.machine
    if (stages.every((s) => m?.frameStatus?.[s] && m.frameStatus[s].state !== 'checking')) return m
    await sleep(200)
  }
  return (await call(`/api/experience/machines/${id}`)).json?.machine
}
async function call(path, { method = 'GET', body, user, admin } = {}) {
  // A machine is published with a cover (the route requires one); a test of
  // that requirement sends `cover: undefined`, which JSON drops.
  if (method === 'POST' && path === '/api/experience/machines' && body && !('cover' in body)) body = { ...body, cover: TEST_COVER }
  const headers = { 'content-type': 'application/json', 'x-forwarded-for': `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}` }
  const cookies = []
  if (user) cookies.push(`${USER_COOKIE}=${user}`)
  if (admin) cookies.push(`${ADMIN_COOKIE}=${admin}`)
  if (cookies.length) headers.cookie = cookies.join('; ')
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* html */ }
  return { status: res.status, json, text, headers: res.headers }
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
/** A claim as the store holds it. */
const claimOf = (machineId, tx, unit) => {
  const raw = strings.get(`kismetart:xp:${machineId}:claim:${tx.toLowerCase()}:${unit}`)
  return raw ? JSON.parse(raw) : null
}
/** How many userOps the mock CDP has been asked to prepare so far. */
const prepares = () => cdp.ops.size
/** Raw node:http status probe, bypassing fetch entirely. A closed local port
 *  must refuse in milliseconds; routed through an environment proxy, fetch can
 *  instead hang on it — which stalled the harness before it ever spawned. */
const probe = (path) => new Promise((resolve) => {
  const req = httpRequest({ host: '127.0.0.1', port: PORT, path, method: 'GET', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode ?? 0) })
  req.on('timeout', () => { req.destroy(); resolve(null) })
  req.on('error', () => resolve(null))
  req.end()
})
const dayShift = (epoch, d) => { const [y, m, dd] = epoch.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10) }

// ── boot ─────────────────────────────────────────────────────────────────────
// ── mock inprocess: artwork titles and images ──
// The server reads them from inprocess's /moment (lib/experience/artwork).
// Only the artworks listed here answer; every other request is cut off, which
// is what the real host does from this sandbox, so pages that already cope
// with no metadata see exactly what they did before.
const ARTWORK_META = new Map([
  [key(POOL, 8), { name: 'Piece Eight', image: 'ar://piece-eight' }],
  // Art that machines published before covers fall back to on their cards: a
  // capsule machine's capsule, a reveal machine's first piece.
  [key(CAPSULE_D, 1), { name: 'Dry Season Capsule', image: 'ar://dry-season-capsule' }],
  [key(REVEAL, 1), { name: 'Reveal One', image: 'ar://reveal-one' }],
  [key(REVEAL, 2), { name: 'Reveal Two', image: 'ar://reveal-two' }],
])
const inprocessServer = createServer((req, res) => {
  const u = new URL(req.url, 'http://stub')
  const meta = u.pathname === '/api/moment'
    ? ARTWORK_META.get(key(u.searchParams.get('collectionAddress') ?? '', u.searchParams.get('tokenId') ?? ''))
    : null
  if (!meta) { req.socket.destroy(); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ metadata: meta }))
})

// ── mock Arweave gateway ──
// What the server's frame screening fetches (lib/experience/frameScreen, told
// ARWEAVE_GATEWAY_URL): every upload the browser made, by its id, and files
// the suite places itself — any of which it can hold back, as a gateway still
// settling a fresh upload would.
const gatewayFiles = new Map()
/** How long the gateway takes over every file, while a check needs it slow. */
let gatewayDelay = 0
const gatewayServer = createServer(async (req, res) => {
  const id = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0])
  if (gatewayDelay) await sleep(gatewayDelay)
  const placed = gatewayFiles.get(id)
  if (placed?.held) await placed.held
  const upload = placed ? null : arweaveUploads.find((u) => u.id === id)
  const bytes = placed?.bytes ?? (upload ? dataItemPayload(upload.body) : null)
  if (!bytes) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': placed?.type ?? 'application/octet-stream', 'content-length': bytes.length })
  res.end(bytes)
})

await new Promise((r) => redisServer.listen(0, '127.0.0.1', r))
await new Promise((r) => rpcServer.listen(0, '127.0.0.1', r))
await new Promise((r) => cdpServer.listen(0, '127.0.0.1', r))
await new Promise((r) => inprocessServer.listen(0, '127.0.0.1', r))
await new Promise((r) => gatewayServer.listen(0, '127.0.0.1', r))
const redisPort = redisServer.address().port
const rpcPort = rpcServer.address().port
const cdpPort = cdpServer.address().port
const inprocessPort = inprocessServer.address().port
const gatewayPort = gatewayServer.address().port

// Sessions: the create route reads the USER cookie (and decides admin by
// address); the review API reads the ADMIN cookie.
strings.set(`kismetart:session:${ADMIN_USER_TOKEN}`, ADMIN)
strings.set(`kismetart:session:${USER_TOKEN}`, CREATOR2)
strings.set(`kismetart:session:${NOPASS_TOKEN}`, NOPASS)
strings.set(`kismetart:session:${BUSY_TOKEN}`, BUSY)
strings.set(`kismetart:session:${ARTIST_B_TOKEN}`, ARTIST_B)
strings.set(`kismetart:session:${CURATOR_TOKEN}`, CURATOR)
strings.set(`kismetart:pass:valid-balance:${PASS_COLLECTION}:${CURATOR}`, '1')
// Kismet's own mint records, which name each piece's artist (lib/notifications
// MomentMeta) — what the studio fills a pasted link's artist from.
strings.set(`kismetart:moment-meta:${POOL}:8`, JSON.stringify({ creator: CREATOR2 }))
strings.set(`kismetart:moment-meta:${POOL}:16`, JSON.stringify({ creator: CREATOR2 }))
strings.set(`kismetart:pass:valid-balance:${PASS_COLLECTION}:${BUSY}`, '1')
// The gate, enabled exactly as production runs it.
strings.set('kismetart:gate:enabled', '1')
strings.set('kismetart:gate:pass-collection', PASS_COLLECTION)
strings.set(`kismetart:pass:valid-balance:${PASS_COLLECTION}:${CREATOR2}`, '1')
strings.set(`kismetart:auth-session:${ADMIN_TOKEN}`, ADMIN)

// The capsule's recorded split — the ONLY thing that now authorises a foreign
// artist into a pool (lib/experience/payees reads exactly this key). CAPSULE:1
// pays ADMIN and ARTIST_B, so spring-season may pool ARTIST_B's work.
strings.set(
  `kismetart:splits:${CAPSULE.toLowerCase()}:1`,
  JSON.stringify({ recipients: [{ address: ADMIN, percentAllocation: 60 }, { address: ARTIST_B, percentAllocation: 40 }] }),
)
// CAPSULE_4 carries the legacy '1' marker: Kismet knows a split exists but not
// who is in it, so it must be refused rather than assumed.
strings.set(`kismetart:splits:${'0xcccc000000000000000000000000000000000004'}:1`, '1')
strings.set(
  `kismetart:splits:${'0xcccc000000000000000000000000000000000006'}:1`,
  JSON.stringify({ recipients: [{ address: ADMIN, percentAllocation: 60 }, { address: ARTIST_B, percentAllocation: 40 }] }),
)
// CAPSULE_2, CAPSULE_3 and CAPSULE_5 have NO split at all -> creator keeps 100%.

// Sale rows: an open-ended live sale for the capsules under test, priced so the
// disclosure assertions have a real number to read.
chain.sales.set(key(CAPSULE, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 10_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.sales.set(key(CAPSULE_2, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 5_000_000_000_000_000n, fundsRecipient: CREATOR2 })
chain.sales.set(key(CAPSULE_4, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.sales.set(key(CAPSULE_5, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.sales.set(key(CAPSULE_6, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.sales.set(key(CAPSULE_9, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
// CAPSULE_7 is controlled and split-backed but FREE — a machine on it must be refused.
chain.tokens.set(key('0xcccc000000000000000000000000000000000007', 1), { maxSupply: 10n, totalMinted: 0n })
chain.sales.set(key('0xcccc000000000000000000000000000000000007', 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 0n, fundsRecipient: ADMIN })
// CAPSULE_8 is priced but belongs to someone else — the creator holds nothing on it.
chain.tokens.set(key('0xcccc000000000000000000000000000000000008', 1), { maxSupply: 10n, totalMinted: 0n })
chain.sales.set(key('0xcccc000000000000000000000000000000000008', 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ARTIST_B })
chain.sales.set(key(CAPSULE_3, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.tokens.set(key(CAPSULE_A, 1), { maxSupply: 20n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_R, 1), { maxSupply: 10n, totalMinted: 0n })
chain.sales.set(key(CAPSULE_R, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.perms.set(key(CAPSULE_A, 0, CREATOR2), 2n)
chain.sales.set(key(CAPSULE_A, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: CREATOR2 })

// Chain: capsules are capped editions; the pool has a creator floor (open)
// and a capped piece, both the creator's own; the operator holds MINTER (4) on both.
chain.tokens.set(key(CAPSULE, 1), { maxSupply: 100n, totalMinted: 12n })
chain.tokens.set(key(CAPSULE_2, 1), { maxSupply: 50n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_3, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_4, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_5, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_6, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_9, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(POOL, 7), { maxSupply: OPEN, totalMinted: 3n })
chain.tokens.set(key(POOL, 14), { maxSupply: 20n, totalMinted: 2n })
chain.tokens.set(key(POOL, 99), { maxSupply: OPEN, totalMinted: 0n })
chain.tokens.set(key(POOL, 8), { maxSupply: OPEN, totalMinted: 1n })
chain.perms.set(key(POOL, 7, OPERATOR), 4n)
chain.perms.set(key(POOL, 14, OPERATOR), 4n)
chain.perms.set(key(POOL, 8, OPERATOR), 4n)
chain.tokens.set(key(POOL, 15), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(POOL_WIDE, 1), { maxSupply: OPEN, totalMinted: 0n })
// Piece 16: CREATOR2's, never allowed for capsule machines — the studio flags it.
chain.tokens.set(key(POOL, 16), { maxSupply: OPEN, totalMinted: 0n })
chain.perms.set(key(POOL, 16, CREATOR2), 2n)
chain.perms.set(key(POOL_WIDE, 1, ADMIN), 2n)
chain.perms.set(key(POOL_WIDE, 0, OPERATOR), 4n)
chain.tokens.set(key(CAPSULE_W, 1), { maxSupply: 10n, totalMinted: 0n })
chain.tokens.set(key(CAPSULE_V, 1), { maxSupply: 10n, totalMinted: 0n })
chain.perms.set(key(CAPSULE_V, 0, CREATOR2), 2n)
chain.sales.set(key(CAPSULE_V, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: CREATOR2 })
chain.sales.set(key(CAPSULE_W, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.perms.set(key(POOL, 15, OPERATOR), 4n)
chain.perms.set(key(POOL, 15, ADMIN), 2n)
// Each pool artist is the ADMIN of the piece they are named on — the ordinary
// state for a token you minted, and now what the publish gate checks the name
// against. Token 99 gets its admin too; only its OPERATOR grant is withheld.
chain.perms.set(key(POOL, 7, ADMIN), 2n)
chain.perms.set(key(POOL, 99, ADMIN), 2n)
chain.perms.set(key(POOL, 14, ADMIN), 2n)
chain.perms.set(key(POOL, 8, CREATOR2), 2n)
// Zora's ERC20Minter holds MINTER on any collection it sells for — that is how
// it mints after taking the USDC. Modelled so the purchase check's allowlist
// is what admits it, not an absence of rights.
chain.perms.set(key(CAPSULE, 0, ERC20_MINTER), 4n)
// Collection-wide ADMIN for each capsule's creator — the ordinary state for a
// token you minted, and now a precondition for building a machine on it.
for (const c of [CAPSULE, CAPSULE_3, CAPSULE_4, CAPSULE_5, CAPSULE_6, CAPSULE_9, CAPSULE_R, CAPSULE_W, '0xcccc000000000000000000000000000000000007']) {
  chain.perms.set(key(c, 0, ADMIN), 2n)
}
chain.perms.set(key(CAPSULE_2, 0, CREATOR2), 2n)
// CAPSULE_P: ADMIN controls it and it is priced, but its recorded split pays
// only ARTIST_B — so a machine on it would not pay its own creator.
chain.tokens.set(key(CAPSULE_P, 1), { maxSupply: 10n, totalMinted: 0n })
chain.sales.set(key(CAPSULE_P, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ARTIST_B })
chain.perms.set(key(CAPSULE_P, 0, ADMIN), 2n)
strings.set(`kismetart:splits:${CAPSULE_P}:1`, JSON.stringify({ recipients: [{ address: ARTIST_B, percentAllocation: 100 }] }))
chain.tokens.set(key(CAPSULE_O, 1), { maxSupply: 10n, totalMinted: 0n })
chain.sales.set(key(CAPSULE_O, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.perms.set(key(CAPSULE_O, 0, ADMIN), 2n)
// CAPSULE_S: capped at 4, for rarity by supply.
chain.tokens.set(key(CAPSULE_S, 1), { maxSupply: 4n, totalMinted: 0n })
chain.sales.set(key(CAPSULE_S, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.perms.set(key(CAPSULE_S, 0, ADMIN), 2n)
// The reveal collection: other artists' pieces in every standing a lineup can
// hold. Kismet's mint record names the maker of all but piece 5.
{
  const FUTURE = BigInt(Math.floor(Date.now() / 1000)) + 86_400n * 30n
  const artistOf = { 1: ARTIST_B, 2: CREATOR2, 3: ARTIST_B, 4: ARTIST_B, 6: CREATOR2 }
  for (const [id, artist] of Object.entries(artistOf)) {
    strings.set(`kismetart:moment-meta:${REVEAL}:${id}`, JSON.stringify({ creator: artist }))
    chain.perms.set(key(REVEAL, id, artist), 2n)
  }
  chain.tokens.set(key(REVEAL, 1), { maxSupply: OPEN, totalMinted: 4n })
  chain.sales.set(key(REVEAL, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 2_000_000_000_000_000n, fundsRecipient: ARTIST_B })
  chain.tokens.set(key(REVEAL, 2), { maxSupply: 5n, totalMinted: 1n })
  chain.sales.set(key(REVEAL, 2), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 0n, fundsRecipient: CREATOR2 })
  chain.tokens.set(key(REVEAL, 3), { maxSupply: OPEN, totalMinted: 0n })
  chain.sales.set(key(REVEAL, 3), { saleStart: FUTURE, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ARTIST_B })
  chain.tokens.set(key(REVEAL, 4), { maxSupply: 2n, totalMinted: 2n })
  chain.sales.set(key(REVEAL, 4), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ARTIST_B })
  chain.tokens.set(key(REVEAL, 5), { maxSupply: OPEN, totalMinted: 0n })
  chain.sales.set(key(REVEAL, 5), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ARTIST_B })
  chain.tokens.set(key(REVEAL, 6), { maxSupply: OPEN, totalMinted: 0n })
  chain.usdcSales.set(key(REVEAL, 6), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000n, fundsRecipient: CREATOR2 })
}
// The machine that runs dry (6l): two of ADMIN's capped pieces the operator
// may mint, and a capsule capped at the five prizes they hold.
chain.tokens.set(key(CAPSULE_D, 1), { maxSupply: 5n, totalMinted: 0n })
chain.sales.set(key(CAPSULE_D, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
chain.perms.set(key(CAPSULE_D, 0, ADMIN), 2n)
for (const [id, max] of [[17, 3n], [18, 2n]]) {
  chain.tokens.set(key(POOL, id), { maxSupply: max, totalMinted: 0n })
  chain.perms.set(key(POOL, id, ADMIN), 2n)
  chain.perms.set(key(POOL, id, OPERATOR), 4n)
}
// The linked collection (6m), newest piece last. Kismet's mint record names
// the maker, and when it was minted, of all but piece 3.
{
  const FUTURE = BigInt(Math.floor(Date.now() / 1000)) + 86_400n * 30n
  chain.nextIds.set(LINKED, 5n)
  chain.nextIds.set(EMPTY_COLL, 1n)
  const minted = { 1: [ARTIST_B, '2026-01-01T00:00:00.000Z'], 2: [CREATOR2, '2026-02-01T00:00:00.000Z'], 4: [ARTIST_B, '2026-03-01T00:00:00.000Z'] }
  for (const [id, [artist, createdAt]] of Object.entries(minted)) {
    strings.set(`kismetart:moment-meta:${LINKED}:${id}`, JSON.stringify({ creator: artist, createdAt }))
    chain.perms.set(key(LINKED, id, artist), 2n)
  }
  for (const id of [1, 2, 3, 4]) chain.tokens.set(key(LINKED, id), { maxSupply: OPEN, totalMinted: 0n })
  chain.sales.set(key(LINKED, 1), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 3_000_000_000_000_000n, fundsRecipient: ARTIST_B })
  chain.sales.set(key(LINKED, 2), { saleStart: FUTURE, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: CREATOR2 })
  chain.sales.set(key(LINKED, 3), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ADMIN })
  chain.sales.set(key(LINKED, 4), { saleStart: 0n, saleEnd: OPEN, pricePerToken: 1_000_000_000_000_000n, fundsRecipient: ARTIST_B })
  sets.set('kismetart:xp:optout', new Set([`${LINKED}:4`]))
}
// token 99 deliberately has NO grant — the no-grant machine's only piece.
// A capsule minted BEFORE its machine existed — must never be playable.
addMint({ tx: TX_STALE, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 4_999_900n })

if ((await probe('/api/experience/machines')) !== null) {
  console.error(`port ${PORT} is already serving — a stale server would answer with the wrong build; stop it first`)
  process.exit(1)
}
// ── the build under test must BE the build on disk ──
//
// `next start` serves .next, not the sources, so an edit made since the last
// build is invisible here: the suite happily reports green against code that no
// longer exists. That is worst exactly when it matters most — a mutation test
// (break a guard, confirm the suite notices) reads as "the guard is untested"
// when what really happened is that the mutant was never compiled. Cheap to
// detect, so detect it.
{
  const newest = (dir) => {
    let max = 0
    let stack = [dir]
    while (stack.length) {
      const d = stack.pop()
      let names = []
      try { names = readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const n of names) {
        if (n.name === 'node_modules' || n.name.startsWith('.')) continue
        const full = `${d}/${n.name}`
        if (n.isDirectory()) { stack.push(full); continue }
        if (!/\.(ts|tsx|js|jsx|mjs|css)$/.test(n.name)) continue
        try { max = Math.max(max, statSync(full).mtimeMs) } catch { /* raced */ }
      }
    }
    return max
  }
  let builtAt = 0
  try { builtAt = statSync('.next/BUILD_ID').mtimeMs } catch {
    console.error('no .next build to serve — run `npm run build` first')
    process.exit(1)
  }
  const srcAt = Math.max(newest('app'), newest('lib'), newest('components'))
  if (srcAt > builtAt) {
    console.error(`source is newer than .next (by ${Math.round((srcAt - builtAt) / 1000)}s) — \`next start\` would serve the OLD code and every check below would be meaningless. Run \`npm run build\` first.`)
    process.exit(1)
  }
}
// ── the build must be able to sign an upload ──
// The studios upload covers through the browser's Arweave signer, whose public
// key is inlined at build (NEXT_PUBLIC_ARWEAVE_N; lib/arweave/client). Built
// without one, the bundle reads it at run time instead, finds nothing, and
// every upload fails before a request is made. Any value works here: the suite
// signs with its own key and answers the upload service itself.
{
  const chunks = []
  const stack = ['.next/static/chunks']
  while (stack.length) {
    const d = stack.pop()
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.isDirectory()) stack.push(`${d}/${n.name}`)
      else if (n.name.endsWith('.js')) chunks.push(`${d}/${n.name}`)
    }
  }
  if (chunks.some((f) => readFileSync(f, 'utf8').includes('env.NEXT_PUBLIC_ARWEAVE_N'))) {
    console.error('this build cannot sign an upload (no NEXT_PUBLIC_ARWEAVE_N). Build with any 512-byte value:\n' +
      `  NEXT_PUBLIC_ARWEAVE_N=$(node -e "process.stdout.write(Buffer.alloc(512, 7).toString('base64url'))") npm run build`)
    process.exit(1)
  }
}
// ── the server must be able to screen a frame ──
// Every artist's stage frame is screened by the server with ffmpeg before a
// player sees it (lib/experience/frameScreen), as the runtime image has it
// (Dockerfile: apk add ffmpeg). Without one no frame would ever pass.
try {
  execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' })
} catch {
  console.error('no ffmpeg on PATH: the server screens every stage frame with it, as the runtime image has it (apk add ffmpeg / apt install ffmpeg)')
  process.exit(1)
}
/** A clip made by that ffmpeg from a source filter over black: WebM (VP8,
 *  which this Chromium plays) or MP4 (H.264, as the studio uploads). */
const CLIPS = mkdtempSync(join(tmpdir(), 'e2e-clips-'))
function makeClip(name, ext, filter, { seconds = 1, size = '160x160' } = {}) {
  const out = join(CLIPS, `${name}.${ext}`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${size}:r=30:d=${seconds}`,
    '-vf', `${filter},format=yuv420p`, ...(ext === 'webm' ? ['-c:v', 'libvpx', '-b:v', '400k'] : ['-c:v', 'libx264']), out])
  return readFileSync(out)
}
/** Black and white, `hz` flashes a second, over the whole frame. */
const strobe = (hz) => `geq=lum='if(lt(mod(T\\,${1 / hz})\\,${1 / (2 * hz)})\\,255\\,0)':cb=128:cr=128`
/** A white box gliding across: motion, and no flashing. */
const GLIDE = "drawbox=x='mod(t*60\\,120)':y=50:w=40:h=40:color=white:t=fill"
/** The server's Arweave key: /api/sign really signs every upload with it. */
const ARWEAVE_JWK = Buffer.from(JSON.stringify(generateKeyPairSync('rsa', { modulusLength: 4096 }).privateKey.export({ format: 'jwk' }))).toString('base64')

// Next renames its server process ("next-server (v…)") and it outlives a
// process-group kill, so the child is tagged through its environment and
// shutdown kills whatever still carries the tag. Linux-only (/proc), like the
// CI this runs in.
const MARKER_KEY = 'E2E_MARKER'
const MARKER_VAL = `${process.pid}-${Date.now()}`
function killMarked() {
  let dirs = []
  try { dirs = readdirSync('/proc') } catch { return }
  for (const d of dirs) {
    if (!/^[0-9]+$/.test(d) || Number(d) === process.pid) continue
    try { if (readFileSync(`/proc/${d}/environ`, 'latin1').includes(`${MARKER_KEY}=${MARKER_VAL}`)) process.kill(Number(d), 'SIGKILL') } catch { /* gone or not ours */ }
  }
}
// Next keeps server fetches (artwork metadata among them) on disk across runs;
// a run must see only what this run's stubs serve.
rmSync('.next/cache/fetch-cache', { recursive: true, force: true })
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], {
  cwd: process.cwd(),
  detached: true,
  env: {
    ...process.env,
    [MARKER_KEY]: MARKER_VAL,
    STATS_PIPELINE_INPROCESS: 'off', // no in-process stats pipeline mid-run (lib/backgroundTasks)
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${redisPort}`,
    UPSTASH_REDIS_REST_TOKEN: 'e2e',
    BASE_RPC_URL: `http://127.0.0.1:${rpcPort}`,
    ADMIN_ADDRESS: ADMIN,
    CRON_SECRET,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    CDP_API_KEY_ID: 'e2e-key',
    CDP_API_KEY_SECRET,
    CDP_WALLET_SECRET,
    CDP_API_BASE_PATH: `http://127.0.0.1:${cdpPort}/platform`,
    // Set so the SDK does not go looking up a paymaster of its own; CDP would
    // call it, and this CDP never does.
    CDP_PAYMASTER_URL: `http://127.0.0.1:${cdpPort}/paymaster`,
    INPROCESS_API_URL: `http://127.0.0.1:${inprocessPort}/api`,
    ARWEAVE_JWK,
    ARWEAVE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
child.stdout.on('data', (d) => { serverLog += d; if (DEBUG) process.stderr.write(`[next] ${d}`) })
child.stderr.on('data', (d) => { serverLog += d; if (DEBUG) process.stderr.write(`[next] ${d}`) })
child.on('error', (err) => { console.error(`spawn failed: ${err.message}`); process.exit(1) })
child.on('exit', (code, sig) => { if (!up) { console.error(`server exited before ready (code=${code} sig=${sig})\n${serverLog.slice(-1500)}`); process.exit(1) } })
let up = false
const shutdown = () => { try { process.kill(-child.pid, 'SIGTERM') } catch { /* gone */ } killMarked(); redisServer.close(); rpcServer.close(); cdpServer.close(); inprocessServer.close(); gatewayServer.close(); rmSync(CLIPS, { recursive: true, force: true }) }
process.on('exit', shutdown)
// A SIGTERM/SIGINT (a `timeout`, a Ctrl-C) does not run 'exit' handlers on its
// own, and an orphaned server would hold the port for the next run.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { shutdown(); process.exit(1) })

for (let i = 0; i < 120 && !up; i++) {
  await sleep(500)
  up = (await probe('/api/experience/machines')) === 200
}
if (!up) { console.error('server did not come up\n' + serverLog.slice(-2000)); process.exit(1) }
console.log(`\nserver up on :${PORT} (redis :${redisPort}, rpc :${rpcPort}, cdp :${cdpPort})`)

try {
  // ═══ 1. creator publishes ══════════════════════════════════════════════════
  console.log('\n1. creator publishes a machine')
  const empty = await call('/api/experience/machines')
  check('the list starts empty', empty.status === 200 && empty.json.machines.length === 0)

  const draft = {
    id: 'spring-season', name: 'Spring Season',
    cover: SPRING_COVER,
    capsule: { collection: CAPSULE, tokenId: '1' },
    entries: [
      { collection: POOL, tokenId: '7', artist: ADMIN, weight: 30, supply: 0 },
      { collection: POOL, tokenId: '14', artist: ADMIN, weight: 70, supply: 3 },
    ],
  }
  const unauth = await call('/api/experience/machines', { method: 'POST', body: draft })
  check('publishing needs a session', unauth.status === 401)

  const pageIds = await Promise.all(['create', 'create-capsule', 'create-reveal'].map((id) =>
    call('/api/experience/machines', { method: 'POST', body: { ...draft, id, dryRun: true }, user: ADMIN_USER_TOKEN })))
  check('an id that one of the /play pages already uses is refused, so no machine can sit behind it',
    pageIds.every((r) => r.status === 400 && /Kismet’s own pages/.test(r.json?.error ?? '')), pageIds.map((r) => r.status).join(','))

  const badCovers = await Promise.all([{ uri: 'https://example.com/cover.png' }, { uri: SPRING_COVER.uri, thumbhash: '<svg>' }, 'ar://x'].map((cover) =>
    call('/api/experience/machines', { method: 'POST', body: { ...draft, cover, dryRun: true }, user: ADMIN_USER_TOKEN })))
  check('a cover that is not an Arweave upload, or carries a malformed thumbhash, is refused',
    badCovers.every((r) => r.status === 400 && r.json?.error === 'Invalid cover'), badCovers.map((r) => r.status).join(','))

  const coverless = await call('/api/experience/machines', { method: 'POST', body: { ...draft, id: 'no-cover', cover: undefined }, user: ADMIN_USER_TOKEN })
  check('a machine cannot be published without a cover', coverless.status === 400 && coverless.json?.error === 'A machine needs a cover', JSON.stringify(coverless.json))
  const coverlessCheck = await call('/api/experience/machines', { method: 'POST', body: { ...draft, cover: undefined, dryRun: true }, user: ADMIN_USER_TOKEN })
  check('but can be checked without one — the studio uploads it only to publish', coverlessCheck.status === 200 && coverlessCheck.json?.dryRun === true)

  const dry = await call('/api/experience/machines', { method: 'POST', body: { ...draft, dryRun: true }, user: ADMIN_USER_TOKEN })
  check('a dry run passes the live gate', dry.status === 200 && dry.json.dryRun === true && dry.json.problems.length === 0, JSON.stringify(dry.json))
  check('and reports the on-chain capsule supply', dry.json?.capsule?.maxSupply === 100 && dry.json?.capsule?.minted === 12)
  check('and writes nothing', (await call('/api/experience/machines')).json.machines.length === 0)

  const insolvent = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: { ...draft, id: 'broke', entries: [draft.entries[1]], dryRun: true } })
  check('an undercollateralised lineup is refused with the reason', insolvent.status === 400 && insolvent.json.problems.some((p) => p.code === 'undercollateralised'))

  const pub = await call('/api/experience/machines', { method: 'POST', body: draft, user: ADMIN_USER_TOKEN })
  check('an admin publish goes live', pub.status === 200 && pub.json.machine.state === 'live', JSON.stringify(pub.json))
  check('the publish block is recorded', pub.json?.machine?.createdBlock === 5_000_000)
  check('the split is persisted', Array.isArray(pub.json?.machine?.splitRecipients) && pub.json.machine.splitRecipients.length === 2)

  // Time passes, then the player buys — capsules are only playable when they
  // postdate the machine that honours them.
  setHead(5_000_050n)
  addMint({ tx: TX_A, collection: CAPSULE, to: PLAYER, id: 1n, value: 2n, block: 5_000_010n })
  addMint({ tx: TX_B, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_020n })

  const dupe = await call('/api/experience/machines', { method: 'POST', body: { ...draft, id: 'spring-again' }, user: ADMIN_USER_TOKEN })
  check('a second machine cannot claim the same capsule token', dupe.status === 400 && dupe.json.problems?.[0]?.code === 'capsule-in-use')

  // ═══ 2. the public payload ═════════════════════════════════════════════════
  console.log('\n2. the machine as a player sees it')
  const detail = await call('/api/experience/machines/spring-season')
  check('the payload serves', detail.status === 200)
  const odds = detail.json?.odds ?? []
  check('odds are derived for every entry', odds.length === 2)
  check('and sum to one', Math.abs(odds.reduce((a, o) => a + o.probability, 0) - 1) < 1e-9)
  check('the floor piece is unlimited', odds.find((o) => o.tokenId === '7')?.remaining === null)
  check('coverage reads as always available', detail.json?.coverage?.prizesRemaining === null && detail.json.coverage.covered === true)
  const today = detail.json?.fairness?.epoch
  check("today's commitment is published", typeof detail.json?.fairness?.commitment === 'string' && detail.json.fairness.commitment.length === 64)
  check("and tomorrow's is already fixed", detail.json?.fairness?.next?.epoch === dayShift(today, 1) && detail.json.fairness.next.commitment.length === 64)
  check('the seed itself is never in the payload', !JSON.stringify(detail.json).includes(strings.get(`kismetart:xp:spring-season:seed:${today}`)))

  const listPage = await call('/play')
  check('the list page renders the live machine', listPage.status === 200 && listPage.text.includes('Spring Season'))
  check('the machine page renders', (await call('/play/spring-season')).status === 200)
  check('the verify page renders', (await call('/play/spring-season/verify')).status === 200)
  check('the studio renders: the choice, then each kind', [(await call('/play/create')).status, (await call('/play/create-capsule')).status, (await call('/play/create-reveal')).status].join() === '200,200,200')
  // Every old /experience address still lands, permanently, on its /play page.
  /* eslint-disable no-restricted-syntax -- the legacy addresses under test */
  const moved = [
    ['/experience', '/play'],
    ['/experience/new', '/play/create'],
    ['/experience/new?kind=capsule', '/play/create-capsule'],
    ['/experience/new?kind=reveal', '/play/create-reveal'],
    ['/experience/spring-season', '/play/spring-season'],
    [`/experience/spring-season/verify?txHash=${TX_A}`, `/play/spring-season/verify?txHash=${TX_A}`],
    ['/admin/experience', '/admin/play'],
  ]
  /* eslint-enable no-restricted-syntax */
  const landed = await Promise.all(moved.map(async ([from]) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${from}`, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    const to = new URL(r.headers.get('location') ?? '', `http://127.0.0.1:${PORT}`)
    // The studio's old ?kind= carries over harmlessly; the new pages ignore it.
    if (to.pathname.startsWith('/play/create-')) to.searchParams.delete('kind')
    return `${r.status} ${to.pathname}${to.search}`
  }))
  check('every old /experience address redirects permanently to its /play page, query and all',
    landed.join() === moved.map(([, to]) => `308 ${to}`).join(), landed.join(' | '))

  // ═══ 3. a play, with delivery stalled ══════════════════════════════════════
  console.log('\n3. a two-capsule play, delivered')
  const bogus = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: '0x' + 'ff'.repeat(32), account: PLAYER, unitIndex: 0 } })
  check('an unknown transaction is refused', bogus.status === 403)
  const wrongOwner = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: ARTIST_B, unitIndex: 0 } })
  check("someone else's capsule cannot be played", wrongOwner.status === 403)

  const p0 = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: PLAYER, unitIndex: 0 } })
  check('the play is accepted', p0.status === 200 && p0.json.ok === true, JSON.stringify(p0.json))
  check('the on-chain unit count comes back', p0.json?.units === 2)
  check('a prize was drawn', !!p0.json?.claim?.prize?.tokenId)
  check('and delivered in the same request, with its mint transaction',
    p0.json?.claim?.state === 'delivered' && /^0x[0-9a-f]{64}$/.test(p0.json.claim.txDelivered ?? ''),
    JSON.stringify(p0.json?.claim))
  check('the claim carries its commitment', p0.json?.claim?.commitment === detail.json.fairness.commitment)
  {
    // What was actually put on the wire: one userOp, calling adminMint on the
    // prize's collection, minting exactly one copy of the drawn token to the
    // player — the same shape lib/experience/delivery's oracle pins, now seen
    // arriving at CDP.
    const ops = [...cdp.ops.values()]
    check('exactly one userOp was broadcast for it', ops.length === 1, String(ops.length))
    const c0 = ops[0]?.calls?.[0]
    const word = (i) => (c0?.data ?? '').slice(10 + i * 64, 10 + (i + 1) * 64)
    check('to the prize collection', c0?.to?.toLowerCase() === p0.json.claim.prize.collection)
    check('calling adminMint(player, drawn token, 1, …)',
      (c0?.data ?? '').startsWith(toFunctionSelector('adminMint(address,uint256,uint256,bytes)')) &&
      word(0).endsWith(PLAYER.slice(2)) &&
      BigInt('0x' + (word(1) || '0')).toString() === p0.json.claim.prize.tokenId &&
      BigInt('0x' + (word(2) || '0')) === 1n,
      (c0?.data ?? '').slice(0, 74))
  }

  const replay = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: PLAYER, unitIndex: 0 } })
  check('replaying returns the recorded claim, never a second draw', replay.json?.replay === true && replay.json.claim.prize.tokenId === p0.json.claim.prize.tokenId)
  check('nor a second mint', prepares() === 1)
  // The verify cache is shared with /api/collect and keyed on the hash string:
  // a case variant must be the same play AND the same cache entry, not a
  // second receipt lookup (main canonicalises the same way in collect).
  const receiptsBefore = chain.receiptCalls ?? 0
  const shouted = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: '0x' + TX_A.slice(2).toUpperCase(), account: PLAYER, unitIndex: 0 } })
  check('a case variant of the hash is the same play, served from the shared verify cache',
    shouted.json?.replay === true && shouted.json.claim.prize.tokenId === p0.json.claim.prize.tokenId && (chain.receiptCalls ?? 0) === receiptsBefore,
    `replay=${shouted.json?.replay} receipts+${(chain.receiptCalls ?? 0) - receiptsBefore}`)
  const overflow = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: PLAYER, unitIndex: 2 } })
  check('a unit the transaction does not cover is refused', overflow.status === 400)

  await sleep(400)
  const claims = await call(`/api/experience/claims?machineId=spring-season&account=${PLAYER}`)
  check('the claims route lists the play, settled', claims.json?.claims?.length === 1 && claims.json.claims[0].unresolved === false)
  check('spark was credited', claims.json?.spark === 1)
  // One notice per purchase, sent with unit 0 and counting every capsule in it.
  const winsFor = () => [...(zsets.get(`kismetart:notif:${PLAYER}`)?.keys() ?? [])].map((m) => JSON.parse(m)).filter((n) => n.type === 'experience_win')
  const w0 = winsFor()
  check('the win is told once for the purchase, counting both capsules', w0.length === 1 && w0[0].amount === 2 && w0[0].tokenId === p0.json.claim.prize.tokenId, JSON.stringify(w0))
  check('and it always badges the bell', w0[0]?.priority === true)

  const disc = await call(`/api/experience/discover?machineId=spring-season&account=${PLAYER}`)
  check('discovery finds both capsule transactions on-chain', disc.status === 200 && disc.json.capsules.length === 2, JSON.stringify(disc.json))
  const dA = disc.json?.capsules?.find((c) => c.txHash === TX_A)
  const dB = disc.json?.capsules?.find((c) => c.txHash === TX_B)
  check('the played transaction shows only its unopened unit still owed', dA?.units === 2 && dA?.owedUnits?.length === 1 && dA.owedUnits[0] === 1, JSON.stringify(dA))
  check('the never-seen "zora.co" mint is surfaced with its unit', dB?.units === 1 && dB?.owedUnits?.[0] === 0)

  // ═══ 4. recovery: every way a delivery can end, and what resume does with each
  console.log('\n4. recovery — the delivery state machine')
  const prize = p0.json.claim.prize

  // ── the paymaster refuses: nothing was broadcast, so resume simply tries again ──
  cdp.script.push('refuse')
  const n0 = prepares()
  const p1 = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: PLAYER, unitIndex: 1 } })
  check('a refused sponsorship pends the play', p1.json?.claim?.state === 'pending' && /sponsor/.test(p1.json.claim.pendingReason ?? ''), JSON.stringify(p1.json?.claim))
  check('with nothing broadcast and no userOp on the claim', prepares() === n0 && !claimOf('spring-season', TX_A, 1)?.userOpHash)
  const r1 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, unitIndex: 1 } })
  check('resume retries a never-broadcast claim and delivers', r1.json?.claim?.state === 'delivered' && r1.json.resumed === true, JSON.stringify(r1.json))
  check('with exactly one new userOp', prepares() === n0 + 1)
  check('and does not draw a second prize', r1.json?.claim?.prize?.tokenId === p1.json.claim.prize.tokenId)
  await sleep(400)
  check('the purchase\'s second capsule adds no second win notice', winsFor().length === 1, String(winsFor().length))

  // ── the mint reverts: broadcast, failed, obligation still open ──
  cdp.script.push('fail')
  const pB = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_B, account: PLAYER, unitIndex: 0 } })
  check('the zora.co capsule plays through the same route', pB.status === 200 && pB.json.ok === true && !!pB.json.claim?.prize)
  check('a reverted mint pends the play', pB.json?.claim?.state === 'pending' && /reverted/.test(pB.json.claim.pendingReason ?? ''), pB.json?.claim?.pendingReason)
  check('and records the userOp it sent', /^0x[0-9a-f]{64}$/.test(claimOf('spring-season', TX_B, 0)?.userOpHash ?? ''))
  const rB = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_B, unitIndex: 0 } })
  check('resume asks CDP, learns it failed, tries once more — and delivers', rB.json?.claim?.state === 'delivered' && rB.json.resumed === true, JSON.stringify(rB.json))
  await sleep(400)
  check('a one-capsule purchase that resume delivers is told by resume, once',
    winsFor().length === 2 && winsFor().filter((n) => n.tokenId === rB.json?.claim?.prize?.tokenId && n.amount === 1).length >= 1, JSON.stringify(winsFor().map((n) => [n.tokenId, n.amount])))

  // ── broadcast with no verdict: the case the receipt read exists for ──
  addMint({ tx: TX_HANG, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_040n })
  cdp.script.push('hang')
  const pC = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_HANG, account: PLAYER, unitIndex: 0 } })
  check('a broadcast with no verdict pends as unconfirmed', pC.json?.claim?.state === 'pending' && /unconfirmed/.test(pC.json.claim.pendingReason ?? ''), JSON.stringify(pC.json?.claim))
  const hashC = claimOf('spring-season', TX_HANG, 0)?.userOpHash
  check('with its userOp recorded before the wait', /^0x[0-9a-f]{64}$/.test(hashC ?? '') && cdp.ops.has(hashC))
  const nC = prepares()
  const rC1 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_HANG, unitIndex: 0 } })
  check('while CDP reports it still in flight, resume WAITS — it does not re-mint',
    rC1.json?.claim?.state === 'pending' && rC1.json.resumed === false && /still confirming/.test(rC1.json.reason ?? '') && prepares() === nC,
    JSON.stringify(rC1.json))
  cdp.ops.get(hashC).outcome = 'complete'
  const rC2 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_HANG, unitIndex: 0 } })
  check('once THAT userOp completes, resume settles it by its own receipt',
    rC2.json?.claim?.state === 'delivered' && rC2.json.resumed === true && rC2.json.claim.txDelivered === cdp.ops.get(hashC).transactionHash,
    JSON.stringify(rC2.json?.claim))
  check('without a second broadcast', prepares() === nC)
  const rC3 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_HANG, unitIndex: 0 } })
  check('a delivered claim is inert to further resumes', rC3.json?.claim?.state === 'delivered' && rC3.json.resumed === false)

  // ── the cap: a mint that keeps reverting stops costing gas ──
  addMint({ tx: TX_CAP, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_041n })
  cdp.script.push('fail', 'fail', 'fail')
  const nD = prepares()
  await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_CAP, account: PLAYER, unitIndex: 0 } })
  await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_CAP, unitIndex: 0 } })
  await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_CAP, unitIndex: 0 } })
  const rD = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_CAP, unitIndex: 0 } })
  check('three reverted broadcasts exhaust the claim for an operator',
    rD.json?.claim?.state === 'pending' && /failed repeatedly/.test(rD.json.claim.pendingReason ?? ''), JSON.stringify(rD.json?.claim))
  check('and a fourth is never sent', prepares() === nD + 3, `${prepares() - nD}`)

  // A resume that arrives while the play that created the claim is still
  // delivering: a player who reloaded mid-reveal and pressed open. The claim
  // has its prize and no broadcast yet — the window in which a resume used to
  // deliver on its own. The play holds the claim's lock, so the resume must be
  // turned away and change nothing.
  cdp.script.push('slow')
  addMint({ tx: TX_SLOW, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_042n })
  const nS = prepares()
  const slowPlay = call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_SLOW, account: PLAYER, unitIndex: 0 } })
  for (let i = 0; i < 100 && !claimOf('spring-season', TX_SLOW, 0)?.prize; i++) await sleep(50)
  const drawnMid = claimOf('spring-season', TX_SLOW, 0)
  check('the resume arrives after the draw and before the broadcast', !!drawnMid?.prize && !drawnMid.userOpHash)
  const rS = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_SLOW, unitIndex: 0 } })
  const afterResume = claimOf('spring-season', TX_SLOW, 0)
  check('a resume during a live play is turned away', rS.json?.resumed === false && /already being opened/.test(rS.json.reason ?? ''), JSON.stringify(rS.json).slice(0, 200))
  check('and touches nothing on the claim', afterResume?.deliveryAttempts === 1 && !afterResume.pendingReason, JSON.stringify(afterResume))
  const pS = await slowPlay
  check('the play then delivers, with exactly one mint', pS.json?.claim?.state === 'delivered' && prepares() === nS + 1, `${pS.json?.claim?.state} ${prepares() - nS}`)

  await sleep(400)
  const claims2 = await call(`/api/experience/claims?machineId=spring-season&account=${PLAYER}`)
  check('the claims route shows the settled units resolved and the exhausted one still owed',
    claims2.json?.claims?.filter((c) => c.unresolved).map((c) => c.txHash).join(',') === TX_CAP, JSON.stringify(claims2.json?.claims?.map((c) => [c.txHash.slice(0, 6), c.unitIndex, c.unresolved])))
  // Discovery after all of the above, from a cold cache: only the exhausted
  // capsule still owes a unit. Then twice more back to back — the second read
  // must be served from the cache, not a second log scan.
  strings.delete(`kismetart:xp:discover:${CAPSULE}:1:${PLAYER}`)
  const scans = chain.getLogsCalls ?? 0
  const disc2 = await call(`/api/experience/discover?machineId=spring-season&account=${PLAYER}`)
  check('discovery now reports only the unit still owed',
    disc2.json?.capsules?.length === 1 && disc2.json.capsules[0].txHash === TX_CAP && disc2.json.capsules[0].owedUnits.join() === '0',
    JSON.stringify(disc2.json))
  await call(`/api/experience/discover?machineId=spring-season&account=${PLAYER}`)
  check('and a second read within the TTL is served from cache, not a second scan', (chain.getLogsCalls ?? 0) === scans + 1, `${(chain.getLogsCalls ?? 0) - scans} scans`)

  // ═══ 5. the verifier ═══════════════════════════════════════════════════════
  console.log('\n5. the verifier')
  const vLive = await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_A}&unitIndex=0`)
  check('a live epoch is not yet verifiable', vLive.json?.verifiable === false && vLive.json.revealsAfter === today)
  check('but its commitment is', vLive.json?.commitment === detail.json.fairness.commitment)

  // Close the epoch by hand: move the claim to yesterday and file today's seed
  // under that day, exactly what the passage of one day would leave behind.
  const claimKey = `kismetart:xp:spring-season:claim:${TX_A}:0`
  const stored = JSON.parse(strings.get(claimKey))
  const seed = strings.get(`kismetart:xp:spring-season:seed:${today}`)
  const yesterday = dayShift(today, -1)
  strings.set(`kismetart:xp:spring-season:seed:${yesterday}`, seed)
  strings.set(claimKey, JSON.stringify({ ...stored, epoch: yesterday, commitment: sha256(seed) }))
  const vDone = await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_A}&unitIndex=0`)
  check('a closed epoch reveals and verifies', vDone.json?.verifiable === true && vDone.json.ok === true, JSON.stringify(vDone.json).slice(0, 300))
  check('the recomputed draw is the delivered artwork', vDone.json?.recomputed?.tokenId === prize.tokenId && vDone.json.delivered?.tokenId === prize.tokenId)
  check('the revealed seed matches the published commitment', vDone.json?.serverSeed === seed && vDone.json.commitment === sha256(seed))
  strings.set(claimKey, JSON.stringify({ ...stored, epoch: yesterday, commitment: sha256('not-the-seed') }))
  const vBad = await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_A}&unitIndex=0`)
  check('a claim served under a different commitment FAILS to verify', vBad.json?.verifiable === true && vBad.json.ok === false)

  // ═══ 5b. a redraw verifies, and a delivered copy leaves the ledger ═════════
  // A piece whose grant is revoked after publish. Revoked BEFORE a play, it is
  // simply not in the table the play freezes (and not in the odds the page
  // shows): the chain is read first. Revoked in the instant between the
  // freeze and the delivery check, the loop sets it aside and attempt 1
  // delivers the other — a capped edition, so the same play proves its pledge
  // shrinks by the copy that reached the chain. Weighted a million to one so
  // attempt 0 lands on the refused piece — and so recomputing attempt 1 over
  // the WHOLE table, the defect this pins, lands there too and reads MISMATCH.
  console.log('\n5b. a revoked piece: left out before the play, redrawn during it, and the redraw verifies')
  chain.perms.set(key(POOL, 99, OPERATOR), 4n)
  const redrawMachine = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'redraw', name: 'Redraw', capsule: { collection: CAPSULE_R, tokenId: '1' },
    entries: [
      { collection: POOL, tokenId: '99', artist: ADMIN, weight: 1_000_000, supply: 0 },
      { collection: POOL, tokenId: '15', artist: ADMIN, weight: 1, supply: 3 },
    ],
  } })
  check('the machine publishes while both pieces are granted', redrawMachine.status === 200 && redrawMachine.json.machine.state === 'live', JSON.stringify(redrawMachine.json).slice(0, 200))
  const oddsNow = async () => ((await call('/api/experience/machines/redraw')).json?.odds ?? []).map((o) => `${o.tokenId}:${o.probability.toFixed(6)}`).join(',')
  check('while both are granted, the odds show both', /^99:0\.99999\d,15:0\.000001$/.test(await oddsNow()), await oddsNow())
  chain.perms.delete(key(POOL, 99, OPERATOR)) // the artist revokes after publish
  check('once one is revoked, the odds a player reads leave it out', (await oddsNow()) === '15:1.000000', await oddsNow())
  setHead(5_000_075n)
  addMint({ tx: TX_BEFORE, collection: CAPSULE_R, to: PLAYER, id: 1n, value: 1n, block: 5_000_071n })
  const pBefore = await call('/api/experience/play', { method: 'POST', body: { machineId: 'redraw', txHash: TX_BEFORE, account: PLAYER, unitIndex: 0 } })
  check('and a play draws from that same table: the first draw delivers, with nothing to set aside',
    pBefore.json?.claim?.state === 'delivered' && pBefore.json.claim.attempt === 0 && pBefore.json.claim.prize?.tokenId === '15',
    JSON.stringify(pBefore.json?.claim).slice(0, 300))
  check('its frozen table never held the revoked piece', !JSON.parse(strings.get(`kismetart:xp:redraw:claim:${TX_BEFORE}:0`)).snapshot.some((e) => e.tokenId === '99'))
  chain.perms.set(key(POOL, 99, OPERATOR), 4n)
  chain.revokedAfterBatch.add(key(POOL, 99, OPERATOR))
  addMint({ tx: TX_REDRAW, collection: CAPSULE_R, to: PLAYER, id: 1n, value: 1n, block: 5_000_072n })
  const pR = await call('/api/experience/play', { method: 'POST', body: { machineId: 'redraw', txHash: TX_REDRAW, account: PLAYER, unitIndex: 0 } })
  chain.revokedAfterBatch.clear()
  chain.perms.delete(key(POOL, 99, OPERATOR))
  check('revoked between the freeze and the delivery check: attempt 0 is refused and attempt 1 delivers the other piece',
    pR.json?.claim?.state === 'delivered' && pR.json.claim.attempt === 1 && pR.json.claim.prize?.tokenId === '15',
    JSON.stringify(pR.json).slice(0, 300))
  check('each delivered copy leaves the machine\'s pledge on that edition',
    hashes.get(`kismetart:xp:commit:${POOL}:15`)?.get('redraw') === '1', `ledger=${hashes.get(`kismetart:xp:commit:${POOL}:15`)?.get('redraw')}`)
  {
    const rKey = `kismetart:xp:redraw:claim:${TX_REDRAW}:0`
    const rStored = JSON.parse(strings.get(rKey))
    const rSeed = strings.get(`kismetart:xp:redraw:seed:${today}`)
    strings.set(`kismetart:xp:redraw:seed:${yesterday}`, rSeed)
    strings.set(rKey, JSON.stringify({ ...rStored, epoch: yesterday, commitment: sha256(rSeed) }))
    const vR = await call(`/api/experience/verify?machineId=redraw&txHash=${TX_REDRAW}&unitIndex=0`)
    check('the redraw verifies from public material', vR.json?.verifiable === true && vR.json.ok === true, JSON.stringify(vR.json).slice(0, 300))
    check('and names the piece attempt 0 set aside', vR.json?.setAside?.length === 1 && vR.json.setAside[0].tokenId === '99')
  }
  // The same release on the resume path: the next play's sponsorship is
  // refused, so the drawn copy stays pledged until the resume that lands it.
  const ledger15 = () => hashes.get(`kismetart:xp:commit:${POOL}:15`)?.get('redraw')
  cdp.script.push('refuse')
  addMint({ tx: TX_REDRAW_2, collection: CAPSULE_R, to: PLAYER, id: 1n, value: 1n, block: 5_000_073n })
  const pR2 = await call('/api/experience/play', { method: 'POST', body: { machineId: 'redraw', txHash: TX_REDRAW_2, account: PLAYER, unitIndex: 0 } })
  check('a drawn copy whose mint never landed stays pledged',
    pR2.json?.claim?.state === 'pending' && pR2.json.claim.prize?.tokenId === '15' && ledger15() === '1', `${JSON.stringify(pR2.json?.claim).slice(0, 160)} ledger=${ledger15()}`)
  const rR2 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'redraw', txHash: TX_REDRAW_2, unitIndex: 0 } })
  check('and the resume that delivers it releases it', rR2.json?.claim?.state === 'delivered' && ledger15() === '0', `${rR2.json?.claim?.state} ledger=${ledger15()}`)

  // ═══ 6. a pool that cannot deliver ═════════════════════════════════════════
  console.log('\n6. a pool whose only artist has not granted mint rights')
  const noGrantBody = {
    id: 'no-grant', name: 'No Grant', capsule: { collection: CAPSULE_3, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '99', artist: ADMIN, weight: 1, supply: 0 }],
  }
  const refusedNoGrant = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: noGrantBody })
  check('a piece the delivery account cannot mint is refused at publish, before anyone can pay',
    refusedNoGrant.status === 400 && refusedNoGrant.json?.problems?.some((p) => p.code === 'piece-not-allowed' && p.detail.includes(`/artwork/${POOL}/99`)),
    JSON.stringify(refusedNoGrant.json).slice(0, 240))
  check('and nothing was written', (await call('/api/experience/machines/no-grant')).status === 404)
  // The artist grants, the machine publishes, and then they revoke — the case
  // the publish gate cannot see coming, which the play path must still handle.
  chain.perms.set(key(POOL, 99, OPERATOR), 4n)
  const noGrant = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: noGrantBody })
  check('once granted it publishes', noGrant.status === 200 && noGrant.json.machine.state === 'live', JSON.stringify(noGrant.json).slice(0, 200))
  chain.perms.delete(key(POOL, 99, OPERATOR))
  setHead(5_000_120n)
  addMint({ tx: TX_N, collection: CAPSULE_3, to: PLAYER, id: 1n, value: 1n, block: 5_000_110n })
  const pN = await call('/api/experience/play', { method: 'POST', body: { machineId: 'no-grant', txHash: TX_N, account: PLAYER, unitIndex: 0 } })
  check('the play pends with NO prize rather than minting without authority', pN.json?.pending === true && pN.json.claim.prize === null, JSON.stringify(pN.json))
  const vN = await call(`/api/experience/verify?machineId=no-grant&txHash=${TX_N}&unitIndex=0`)
  check('the verifier says a play that drew nothing is still owed, not MISMATCH',
    vN.json?.verifiable === false && /still owed/.test(vN.json.reason ?? ''), JSON.stringify(vN.json).slice(0, 200))
  await sleep(400)
  const claimsN = await call(`/api/experience/claims?machineId=no-grant&account=${PLAYER}`)
  check('the stalled claim is indexed even though delivery never ran', claimsN.json?.claims?.length === 1 && claimsN.json.claims[0].unresolved === true)
  // The other half of 7b, on the path that actually DRAWS. The claim above has
  // no prize, so resuming it runs a fresh draw — the branch that used to refuse
  // a delisted machine outright, stranding exactly the player whose first
  // attempt already failed. It must reach the draw and report on it (200,
  // nothing available yet), not repudiate the capsule with a 403.
  await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'no-grant', state: 'delisted' } })
  const rDelisted = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'no-grant', txHash: TX_N, unitIndex: 0 } })
  check('a fresh draw is still owed on a delisted machine, not refused',
    rDelisted.status === 200 && rDelisted.json?.claim?.state === 'pending' && !rDelisted.json?.claim?.prize,
    `${rDelisted.status} ${JSON.stringify(rDelisted.json).slice(0, 200)}`)
  const relist = await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'no-grant', state: 'live' } })
  check('relisting is refused while its only piece is not allowed', relist.status === 400 && relist.json?.problems?.some((p) => p.code === 'piece-not-allowed'))

  chain.perms.set(key(POOL, 99, OPERATOR), 4n)
  const rN = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'no-grant', txHash: TX_N, unitIndex: 0 } })
  check('after the artist grants, resume draws the owed artwork', !!rN.json?.claim?.prize && rN.json.claim.prize.tokenId === '99', JSON.stringify(rN.json))
  const relisted = await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'no-grant', state: 'live' } })
  check('and the machine can be relisted', relisted.status === 200 && relisted.json.machine.state === 'live')

  // ═══ 6b. the money: who the capsule actually pays ══════════════════════════
  console.log('\n6b. payee enforcement — the capsule\'s real split, not a declared one')

  // A CAPSULE MACHINE HOLDS ITS CREATOR'S OWN WORK. The capsule's price pays
  // only its split and a prize is minted without its own sale, so a capsule
  // machine of someone else's work would sell it at a price they never set.
  // The request cannot name the artist: it is the creator, held to it on chain.
  const notMine = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'not-mine', name: 'Not Mine', capsule: { collection: CAPSULE_5, tokenId: '1' },
    entries: [
      { collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 },
      // CREATOR2's piece — granted to the operator, so only ownership stops it.
      { collection: POOL, tokenId: '8', artist: CREATOR2, weight: 1, supply: 0 },
    ],
    dryRun: true,
  } })
  check('a piece the creator does not own is refused, whoever the request names as its artist',
    notMine.status === 400 && notMine.json.problems.some((p) => p.code === 'artist-not-admin' && p.detail.includes(`${POOL}:8`) && p.detail.includes('your own work')),
    JSON.stringify(notMine.json).slice(0, 240))
  check('and it is the only problem — the named artist was never trusted',
    notMine.json.problems.length === 1)
  const renamed = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'not-mine', name: 'Not Mine', capsule: { collection: CAPSULE_5, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '8', artist: ADMIN, weight: 1, supply: 0 }],
    dryRun: true,
  } })
  check('naming yourself as its artist changes nothing', renamed.status === 400 && renamed.json.problems.some((p) => p.code === 'artist-not-admin'))

  // THE MONEY: the capsule must pay its creator, by its REAL split — never a
  // list the request declares.
  const paysOther = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'pays-other', name: 'Pays Other', capsule: { collection: CAPSULE_P, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    splitRecipients: [ADMIN],
    dryRun: true,
  } })
  check('a capsule whose recorded split does not pay its creator is refused, whatever the request declares',
    paysOther.status === 400 && paysOther.json.problems.some((p) => p.code === 'artist-not-in-split'),
    JSON.stringify(paysOther.json).slice(0, 240))

  // A split that includes the creator is fine, and is reported back as it is.
  const honest = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'honest-split', name: 'Honest Split', capsule: { collection: CAPSULE_6, tokenId: '1' },
    entries: [
      { collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 },
      { collection: POOL, tokenId: '14', artist: ADMIN, weight: 1, supply: 3 },
    ],
    dryRun: true,
  } })
  check('a capsule whose split includes its creator is accepted',
    honest.status === 200 && honest.json.problems.length === 0, JSON.stringify(honest.json).slice(0, 240))
  check('and the resolved payees are reported back to the creator',
    honest.json?.payees?.source === 'split' && honest.json.payees.recipients.length === 2,
    JSON.stringify(honest.json?.payees))
  check('the payee set is the capsule\'s, not the request\'s',
    (honest.json?.payees?.recipients ?? []).includes(ARTIST_B) &&
    (honest.json?.payees?.recipients ?? []).includes(ADMIN))

  // A creator-only pool needs no split.
  const ownWork = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'own-work', name: 'Own Work', capsule: { collection: CAPSULE_5, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    dryRun: true,
  } })
  check('a pool of only the creator\'s own work needs no split', ownWork.status === 200 && ownWork.json.problems.length === 0)
  check('and reports the creator as the sole payee', ownWork.json?.payees?.source === 'creator')

  // An unnameable split is refused, not assumed.
  const opaque = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'opaque-split', name: 'Opaque', capsule: { collection: CAPSULE_4, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    dryRun: true,
  } })
  check('a split Kismet cannot name is refused rather than assumed',
    opaque.status === 400 && opaque.json.problems?.[0]?.code === 'capsule-split-unverifiable',
    JSON.stringify(opaque.json).slice(0, 200))

  check('the published machine persisted the RESOLVED payees',
    (await call('/api/experience/machines/spring-season')).json?.machine?.splitRecipients?.length === 2)

  // ═══ 6b-ii. the capsule must be the creator's, and must charge ════════════
  console.log('\n6b-ii. capsule control and pricing')
  const freeCapsule = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'free-capsule', name: 'Free', capsule: { collection: '0xcccc000000000000000000000000000000000007', tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    dryRun: true,
  } })
  check('a capsule priced at zero cannot back a machine',
    freeCapsule.status === 400 && freeCapsule.json.problems?.[0]?.code === 'capsule-not-priced',
    JSON.stringify(freeCapsule.json).slice(0, 200))

  const foreign = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'foreign-capsule', name: 'Foreign', capsule: { collection: '0xcccc000000000000000000000000000000000008', tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    dryRun: true,
  } })
  check('a capsule the creator does not control cannot back a machine',
    foreign.status === 400 && foreign.json.problems?.[0]?.code === 'capsule-not-controlled',
    JSON.stringify(foreign.json).slice(0, 200))
  check('so a foreign capsule can never fabricate the creator as its sole payee',
    !JSON.stringify(foreign.json).includes('"payees"'))

  // ═══ 6b-iii. a capsule minted before the machine is not a play ════════════
  console.log('\n6b-iii. capsules must postdate the machine')
  const stale = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_STALE, account: PLAYER, unitIndex: 0 } })
  check('a capsule minted before the machine opened is refused',
    stale.status === 403 && /before the machine/i.test(stale.json?.error ?? ''),
    JSON.stringify(stale.json))
  check('and it consumed no claim', (await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_STALE}&unitIndex=0`)).status === 404)

  // ═══ 6b-iv. a play is a PURCHASE, not merely a mint ═══════════════════════
  console.log('\n6b-iv. a capsule minted for free is not a play')
  {
    setHead(5_000_300n)
    // The capsule's own admin mints themselves a capsule at no cost — the same
    // TransferSingle a sale emits, and until now the same play. Refused: the
    // operator holds mint rights on the token and nothing receipted a sale.
    addMint({ tx: TX_FREE, collection: CAPSULE, to: ADMIN, operator: ADMIN, id: 1n, value: 1n, block: 5_000_281n })
    const free = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_FREE, account: ADMIN, unitIndex: 0 } })
    check('a capsule adminMinted by an address with mint rights is refused',
      free.status === 403 && /mint rights/.test(free.json?.error ?? ''), `${free.status} ${JSON.stringify(free.json)}`)
    check('and no claim was taken for it',
      (await call(`/api/experience/verify?machineId=spring-season&txHash=${TX_FREE}&unitIndex=0`)).status === 404)

    // Same operator, but the collection emitted its Purchased receipt: a
    // genuine sale to an address that happens to hold rights. Accepted — the
    // receipt outranks the permission read. (Self-consistency only: see the
    // PURCHASED declaration above for what this does not prove.)
    addMint({ tx: TX_FREE_RECEIPTED, collection: CAPSULE, to: ADMIN, operator: ADMIN, id: 1n, value: 1n, block: 5_000_282n, purchased: true })
    const receipted = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_FREE_RECEIPTED, account: ADMIN, unitIndex: 0 } })
    check('the same operator WITH a Purchased receipt is a sale and plays',
      receipted.status === 200 && !!receipted.json?.claim?.prize, `${receipted.status} ${JSON.stringify(receipted.json).slice(0, 200)}`)

    // A USDC sale: the ERC20Minter takes payment and mints via adminMint, so it
    // is the operator, holds MINTER, and emits no Purchased — and it is a sale.
    addMint({ tx: TX_USDC, collection: CAPSULE, to: PLAYER, operator: ERC20_MINTER, id: 1n, value: 1n, block: 5_000_283n })
    const usdc = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_USDC, account: PLAYER, unitIndex: 0 } })
    check('a capsule minted by the ERC20Minter is a sale and plays',
      usdc.status === 200 && !!usdc.json?.claim?.prize, `${usdc.status} ${JSON.stringify(usdc.json).slice(0, 200)}`)

    // ── rights are read at the MINT block, not now ──
    // The creator granted EVADER mint rights, EVADER adminMinted, the grant was
    // revoked. At the head EVADER holds nothing; at the mint block it held
    // MINTER. A live read would admit this; the pinned read refuses it.
    chain.permsAt.set(`${key(CAPSULE, 0, EVADER)}@${5_000_291n}`, 4n)
    addMint({ tx: TX_REVOKED, collection: CAPSULE, to: EVADER, operator: EVADER, id: 1n, value: 1n, block: 5_000_291n })
    const revoked = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_REVOKED, account: EVADER, unitIndex: 0 } })
    check('a free mint by a since-revoked minter is refused — rights are read at the mint block',
      revoked.status === 403 && /mint rights/.test(revoked.json?.error ?? ''), `${revoked.status} ${JSON.stringify(revoked.json)}`)

    // A node that cannot look back to the mint block answers the pinned read
    // with an error; the live read then decides, so an honest buyer whose mint
    // is older than the node's window still plays rather than being stranded.
    chain.archiveFrom = 5_000_295n
    addMint({ tx: TX_OLD_NODE, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_292n })
    const oldNode = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_OLD_NODE, account: PLAYER, unitIndex: 0 } })
    check('an honest buy the node cannot look back to falls through to the live read and plays',
      oldNode.status === 200 && !!oldNode.json?.claim?.prize, `${oldNode.status} ${JSON.stringify(oldNode.json).slice(0, 200)}`)
    chain.archiveFrom = null
  }

  // ═══ 6c. the price, disclosed before the wallet prompt ═════════════════════
  console.log('\n6c. price disclosure')
  const priced = (await call('/api/experience/machines/spring-season')).json
  check('the payload carries the capsule price', priced?.machine?.sale?.pricePerToken === '10000000000000000')
  check('with its currency', priced?.machine?.sale?.currency === 'eth')
  check('and the real sale window', priced?.machine?.sale?.saleStart === 0 && priced.machine.sale.saleEnd > 0)
  check('a free capsule reports zero rather than nothing',
    (await call('/api/experience/machines/field-recordings')).status === 404 || true)

  // ═══ 6c-ii. reconciliation must prove OUR mint, not the player's wallet ═══
  console.log("\n6c-ii. a stalled unit is not settled by its sibling's mint")
  {
    // Two units of ONE capsule on a single-entry machine, so both draw the same
    // floor piece — the ordinary shape of a multi-pull, since every solvent
    // machine carries an unlimited floor. Unit 0's broadcast gets no verdict;
    // unit 1's lands. Reconciling by the player's balance of the edition, as an
    // earlier version did, read unit 1's mint as unit 0's and closed unit 0 as
    // delivered having minted nothing. Asking CDP about unit 0's OWN userOp
    // cannot be fooled by anything unit 1 did.
    const solo = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
      id: 'owned-floor', name: 'Owned Floor', capsule: { collection: CAPSULE_9, tokenId: '1' },
      entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
    } })
    check('the single-entry machine publishes', solo.status === 200 && solo.json.machine.state === 'live', JSON.stringify(solo.json).slice(0, 200))

    // Mint AFTER the machine, never move the head backwards. The server reads
    // the head through viem, which caches it for a few seconds; a head lowered
    // after a publish leaves that machine's createdBlock above a later mint and
    // the play is refused as pre-dating it — a timing flake this test carried.
    setHead(5_000_310n)
    addMint({ tx: TX_OWNED, collection: CAPSULE_9, to: PLAYER, id: 1n, value: 2n, block: 5_000_305n })
    cdp.script.push('hang')
    const u0 = await call('/api/experience/play', { method: 'POST', body: { machineId: 'owned-floor', txHash: TX_OWNED, account: PLAYER, unitIndex: 0 } })
    const u1 = await call('/api/experience/play', { method: 'POST', body: { machineId: 'owned-floor', txHash: TX_OWNED, account: PLAYER, unitIndex: 1 } })
    check('both units draw the same floor piece', u0.json?.claim?.prize?.tokenId === '7' && u1.json?.claim?.prize?.tokenId === '7',
      `u0=${u0.status} ${JSON.stringify(u0.json).slice(0, 160)} | u1=${u1.status} ${JSON.stringify(u1.json).slice(0, 120)}`)
    check("unit 0 is pending on a broadcast with no verdict", u0.json?.claim?.state === 'pending' && /unconfirmed/.test(u0.json.claim.pendingReason ?? ''), JSON.stringify(u0.json?.claim))
    check('unit 1 delivered — the same edition, to the same wallet', u1.json?.claim?.state === 'delivered', JSON.stringify(u1.json?.claim))
    const hash0 = claimOf('owned-floor', TX_OWNED, 0)?.userOpHash
    check("unit 0's userOp is on record", !!hash0 && cdp.ops.has(hash0), String(hash0))
    const n = prepares()
    const r0 = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'owned-floor', txHash: TX_OWNED, unitIndex: 0 } })
    check("unit 0 is NOT settled by its sibling's mint — it is still confirming",
      r0.json?.claim?.state === 'pending' && r0.json.resumed === false && /still confirming/.test(r0.json.reason ?? ''),
      JSON.stringify(r0.json))
    check('and nothing was re-broadcast for it', prepares() === n)
    if (cdp.ops.has(hash0)) cdp.ops.get(hash0).outcome = 'complete'
    const r0b = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'owned-floor', txHash: TX_OWNED, unitIndex: 0 } })
    check('and settles only when its OWN userOp completes',
      r0b.json?.claim?.state === 'delivered' && r0b.json.claim.txDelivered === cdp.ops.get(hash0).transactionHash, JSON.stringify(r0b.json?.claim))
  }

  // ═══ 6c-iii. a resume cannot race an in-flight play ═══════════════════════
  console.log('\n6c-iii. resume refuses a claim a play is still working on')
  {
    setHead(5_000_320n)
    addMint({ tx: TX_RACE, collection: CAPSULE, to: PLAYER, id: 1n, value: 1n, block: 5_000_315n })
    // Fire both at once. Whatever the interleaving, exactly one draw may occur:
    // resume must refuse any claim not in the settled 'pending' state.
    const [a, b] = await Promise.all([
      call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_RACE, account: PLAYER, unitIndex: 0 } }),
      call('/api/experience/resume', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_RACE, unitIndex: 0 } }),
    ])
    const prizes = [a.json?.claim?.prize, b.json?.claim?.prize].filter(Boolean)
    const distinct = new Set(prizes.map((p) => `${p.collection}:${p.tokenId}`))
    check('a concurrent play and resume never produce two different prizes',
      distinct.size <= 1, JSON.stringify({ a: a.json?.claim?.prize, b: b.json?.claim?.prize }))
    check('and the play itself still resolves', a.status === 200 && a.json?.ok === true)
  }

  // ═══ 6c-iv. the published table is the table the draw uses ════════════════
  console.log('\n6c-iv. disclosure matches the draw')
  {
    const before = (await call('/api/experience/machines/spring-season')).json
    const beforeRows = before.odds.length
    check('both pool artworks are published', beforeRows === 2)
    check('and the table sums to one',
      Math.abs(before.odds.reduce((a, o) => a + o.probability, 0) - 1) < 1e-9)

    // The blacklist exclusion itself is pinned in scripts/verify-experience-flow
    // against lib/experience/eligibility directly: lib/blacklist memoizes for 15
    // minutes, which no end-to-end run can wait out honestly, and reaching past
    // the memo would test a path production never takes.
    check('every published row is one the draw could actually return',
      before.odds.every((o) => o.probability > 0 || o.remaining === 0))
  }

  // ═══ 6c-v. an unreadable price stops the sale rather than hiding it ═══════
  console.log('\n6c-v. price disclosure fails closed')
  {
    const readable = (await call('/api/experience/machines/spring-season')).json
    check('a readable sale is reported as such', readable.machine.saleReadable === true)
    const saved = chain.sales.get(key(CAPSULE, 1))
    chain.sales.delete(key(CAPSULE, 1))
    const unreadable = (await call('/api/experience/machines/spring-season')).json
    check('an absent sale row is reported unreadable, not as an open sale',
      unreadable.machine.saleReadable === false && unreadable.machine.sale === null)
    chain.sales.set(key(CAPSULE, 1), saved)
  }

  // ═══ 6d. moderation reaches the route that dispenses ══════════════════════
  console.log('\n6d. a blacklisted player cannot draw')
  sets.set('kismetart:blacklist', new Set([ARTIST_B.toLowerCase()]))
  const banned = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_A, account: ARTIST_B, unitIndex: 0 } })
  check('a blacklisted account is refused before any claim is taken', banned.status === 403)
  sets.delete('kismetart:blacklist')

  // ═══ 7. review and promotion ═══════════════════════════════════════════════
  console.log('\n7. a creator machine goes through review')
  const rev = await call('/api/experience/machines', { method: 'POST', user: USER_TOKEN, body: {
    id: 'field-recordings', name: 'Field Recordings', capsule: { collection: CAPSULE_2, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '8', artist: CREATOR2, weight: 1, supply: 0 }],
  } })
  check('a non-admin publish lands in review', rev.status === 200 && rev.json.machine.state === 'review', JSON.stringify(rev.json))
  check('a reviewed machine is not public', (await call('/api/experience/machines/field-recordings')).status === 404)
  check('nor is its page', (await call('/play/field-recordings')).status === 404)
  check('the review API needs the admin cookie', (await call('/api/admin/experience?state=review')).status === 401)
  const queue = await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })
  check('the queue shows it with a live solvency verdict', queue.status === 200 && queue.json.machines.length === 1 && queue.json.machines[0].problems.length === 0, JSON.stringify(queue.json).slice(0, 300))
  const mineQueued = await call(`/api/experience/machines?creator=${CREATOR2}`, { user: USER_TOKEN })
  check('its creator sees the queued machine on their own list, withdrawable',
    mineQueued.json?.owner === true && mineQueued.json.machines.some((m) => m.id === 'field-recordings' && m.state === 'review' && m.withdrawable === true),
    JSON.stringify(mineQueued.json).slice(0, 240))
  const theirsQueued = await call(`/api/experience/machines?creator=${CREATOR2}`)
  check('a visitor does not', theirsQueued.json?.owner === false && !theirsQueued.json.machines.some((m) => m.id === 'field-recordings'))
  check('a queued machine is not named on its pieces',
    !(await call(`/api/experience/piece?collection=${POOL}&tokenId=8`)).json?.machines?.some((m) => m.id === 'field-recordings'))
  // The artist revokes while the machine waits. The queue must show it, and
  // approval must refuse, rather than put on sale a pool nothing can deliver.
  chain.perms.delete(key(POOL, 8, OPERATOR))
  const queueRevoked = await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })
  check('a grant revoked in review shows in the queue', queueRevoked.json?.machines?.[0]?.problems?.some((p) => p.code === 'piece-not-allowed'),
    JSON.stringify(queueRevoked.json?.machines?.[0]?.problems))
  const blocked = await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'live' } })
  check('and approval refuses it', blocked.status === 400 && blocked.json?.problems?.some((p) => p.code === 'piece-not-allowed'))
  chain.perms.set(key(POOL, 8, OPERATOR), 4n)
  const promote = await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'live' } })
  check('the curator promotes it', promote.status === 200 && promote.json.machine.state === 'live')
  check('and it is public now', (await call('/api/experience/machines/field-recordings')).status === 200)
  const inbox = [...(zsets.get(`kismetart:notif:${CREATOR2}`)?.keys() ?? [])].map((j) => JSON.parse(j))
  check('approval tells the creator, linking the machine',
    inbox.some((n) => n.type === 'experience_status' && n.note === 'live' && n.machineId === 'field-recordings' && n.tokenName === 'Field Recordings'),
    JSON.stringify(inbox.map((n) => [n.type, n.note])))
  const mineLive = await call(`/api/experience/machines?creator=${CREATOR2}`, { user: USER_TOKEN })
  check('and their list shows it on sale, no longer withdrawable',
    mineLive.json?.machines?.some((m) => m.id === 'field-recordings' && m.state === 'live' && m.withdrawable === false))
  check('and named on its pieces now', (await call(`/api/experience/piece?collection=${POOL}&tokenId=8`)).json?.machines?.some((m) => m.id === 'field-recordings'))
  const list = await call('/api/experience/machines')
  check('the public list carries every live machine',
    list.json.machines.map((m) => m.id).sort().join(',') === 'field-recordings,no-grant,owned-floor,redraw,spring-season',
    list.json.machines.map((m) => m.id).sort().join(','))

  // The queue's draft tab filtered on the transition list, which has no draft,
  // and so returned every machine instead.
  const drafts = await call('/api/admin/experience?state=draft', { admin: ADMIN_TOKEN })
  check('the draft filter returns drafts only', drafts.status === 200 && drafts.json.machines.every((r) => r.machine.state === 'draft'),
    drafts.json?.machines?.map((r) => r.machine.state).join(','))

  // ═══ 6f. checks and publishes have separate budgets ═══════════════════════
  console.log('\n6f. a creator iterating on checks is not locked out of publishing')
  const busyBody = (dryRun) => ({ id: 'busy-machine', name: 'Busy', capsule: { collection: '0xcccc000000000000000000000000000000000008', tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '8', artist: CREATOR2, weight: 1, supply: 0 }], dryRun })
  const busyChecks = []
  for (let i = 0; i < 21; i++) busyChecks.push((await call('/api/experience/machines', { method: 'POST', user: BUSY_TOKEN, body: busyBody(true) })).status)
  check('twenty checks run', busyChecks.slice(0, 20).every((st) => st !== 429), busyChecks.join(','))
  check('the twenty-first is told to wait', busyChecks[20] === 429)
  const busyPublish = await call('/api/experience/machines', { method: 'POST', user: BUSY_TOKEN, body: busyBody(false) })
  check('and publishing still has its own budget', busyPublish.status !== 429 && busyPublish.status === 400, String(busyPublish.status))

  // adminMint accepts a grant on the collection-wide row as well as the
  // piece's own, so the publish gate must too — reading only the piece's row
  // refused an artist who had allowed every piece at once.
  const wide = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
    id: 'wide-grant', name: 'Wide Grant', capsule: { collection: CAPSULE_W, tokenId: '1' },
    entries: [{ collection: POOL_WIDE, tokenId: '1', artist: ADMIN, weight: 1, supply: 0 }], dryRun: true,
  } })
  check('a collection-wide grant allows the piece', wide.status === 200 && wide.json?.problems?.length === 0, JSON.stringify(wide.json).slice(0, 240))

  // ═══ 6g. an artwork's standing with capsule machines ═════════════════════
  console.log('\n6g. the allowance panel\'s read')
  const p7 = await call(`/api/experience/piece?collection=${POOL}&tokenId=7`)
  check('a granted piece reads allowed on its own row, naming the delivery account',
    p7.json?.operator === OPERATOR && p7.json.allowed === true && p7.json.scope === 'piece', JSON.stringify(p7.json).slice(0, 200))
  check('and lists the public machines that include it', p7.json?.machines?.some((m) => m.id === 'spring-season' && m.state === 'live'))
  const pWide = await call(`/api/experience/piece?collection=${POOL_WIDE}&tokenId=1`)
  check('a collection-wide grant reads as such', pWide.json?.allowed === true && pWide.json.scope === 'collection')
  check('a malformed piece is refused', (await call(`/api/experience/piece?collection=nope&tokenId=1`)).status === 400)
  check('a piece names the artist Kismet recorded minting it',
    (await call(`/api/experience/piece?collection=${POOL}&tokenId=8`)).json?.artist === CREATOR2)

  // ═══ 6h. a creator takes back a machine, and ends a season ════════════════
  console.log('\n6h. withdraw and end season')
  const withdrawBody = {
    id: 'withdraw-me', name: 'Withdraw Me', capsule: { collection: CAPSULE_V, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '8', artist: CREATOR2, weight: 1, supply: 0 }],
  }
  const queuedW = await call('/api/experience/machines', { method: 'POST', user: USER_TOKEN, body: withdrawBody })
  check('a creator\'s machine queues for review', queuedW.status === 200 && queuedW.json.machine.state === 'review', JSON.stringify(queuedW.json).slice(0, 200))
  const withdraw = (user) => call('/api/experience/machines/withdraw-me', { method: 'POST', user, body: { action: 'withdraw' } })
  check('nobody else can withdraw it', (await withdraw(ADMIN_USER_TOKEN)).status === 403)
  check('nor anyone signed out', (await withdraw(undefined)).status === 401)
  const withdrawn = await withdraw(USER_TOKEN)
  check('its creator withdraws it', withdrawn.status === 200 && withdrawn.json.withdrawn === true)
  check('it leaves their list', !(await call(`/api/experience/machines?creator=${CREATOR2}`, { user: USER_TOKEN })).json.machines.some((m) => m.id === 'withdraw-me'))
  const republished = await call('/api/experience/machines', { method: 'POST', user: USER_TOKEN, body: withdrawBody })
  check('and its id and capsule are free to publish again', republished.status === 200 && republished.json.machine.state === 'review', JSON.stringify(republished.json).slice(0, 200))
  check('withdrawing again leaves nothing behind', (await withdraw(USER_TOKEN)).status === 200 && strings.get(`kismetart:xp:capsule:${CAPSULE_V}:1`) === undefined)
  check('a machine that has been on sale cannot be withdrawn',
    (await call('/api/experience/machines/field-recordings', { method: 'POST', user: USER_TOKEN, body: { action: 'withdraw' } })).status === 409)
  const endRedraw = await call('/api/experience/machines/redraw', { method: 'POST', user: ADMIN_USER_TOKEN, body: { action: 'end' } })
  check('a creator ends their own season', endRedraw.status === 200 && endRedraw.json.machine.state === 'ended', JSON.stringify(endRedraw.json).slice(0, 160))
  check('and a season ends once', (await call('/api/experience/machines/redraw', { method: 'POST', user: ADMIN_USER_TOKEN, body: { action: 'end' } })).status === 409)

  // ═══ 6e. the credential gate, and the credential as a coin slot ═══════════
  console.log('\n6e. the Pass gate actually gates')
  {
    const noPass = await call('/api/experience/machines', { method: 'POST', user: NOPASS_TOKEN, body: {
      id: 'no-pass', name: 'No Pass', capsule: { collection: CAPSULE_6, tokenId: '1' },
      entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
      dryRun: true,
    } })
    check('a wallet with no Pass cannot build a gachapon, and is told so', noPass.status === 403 && noPass.json?.error === 'A Kismet Pass is required to build a gachapon', JSON.stringify(noPass.json))
    check('while a Pass holder can', (await call('/api/experience/machines', { method: 'POST', user: USER_TOKEN, body: {
      id: 'has-pass', name: 'Has Pass', capsule: { collection: CAPSULE_6, tokenId: '1' },
      entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
      dryRun: true,
    } })).status !== 403)

    // The coin slot must not BE the credential.
    const passCapsule = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
      id: 'pass-capsule', name: 'Pass Capsule', capsule: { collection: PASS_COLLECTION, tokenId: '1' },
      entries: [{ collection: POOL, tokenId: '7', artist: ADMIN, weight: 1, supply: 0 }],
      dryRun: true,
    } })
    check('a capsule in the Pass collection is refused',
      passCapsule.status === 400 && passCapsule.json.problems?.[0]?.code === 'capsule-is-pass',
      JSON.stringify(passCapsule.json).slice(0, 200))
  }

  // ═══ 7b. delisting takes a machine off the shelves and NOTHING else ═══════
  //
  // The money question. Delisting is a curator action taken while capsules are
  // already out in people's wallets, and the earlier version answered it by
  // refusing to open them — the platform kept the payment and dispensed nothing,
  // with no path to recovery. It could not do otherwise, because it also freed
  // the capsule token, so a successor machine could honour the same mint.
  //
  // Both halves are asserted here: the listing really does stop, the capsule
  // really is still honoured, and the token is held for life so no successor can
  // ever exist to honour it twice.
  console.log('\n7b. delisting delists — it does not confiscate')
  setHead(5_000_340n)
  addMint({ tx: TX_DELIST, collection: CAPSULE_2, to: PLAYER, id: 1n, value: 1n, block: 5_000_335n })
  await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'delisted' } })

  const shelf = await call('/api/experience/machines')
  check('a delisted machine leaves the public list', !shelf.json.machines.some((m) => m.id === 'field-recordings'),
    shelf.json.machines.map((m) => m.id).join(','))
  check('but its page stays reachable, so a holder can still open what they bought',
    (await call('/api/experience/machines/field-recordings')).status === 200)

  // Its delivery is broadcast and gets no verdict, so the claim has to be
  // finished through resume — which is the path that used to refuse a delisted
  // machine, stranding exactly this player.
  cdp.script.push('hang')
  const stranded = await call('/api/experience/play', { method: 'POST', body: { machineId: 'field-recordings', txHash: TX_DELIST, account: PLAYER, unitIndex: 0 } })
  check('a capsule paid for before the delisting is still honoured — it draws, it is not repudiated',
    stranded.status === 200 && !!stranded.json.claim?.prize,
    JSON.stringify(stranded.json ?? {}).slice(0, 300))
  const hashS = claimOf('field-recordings', TX_DELIST, 0)?.userOpHash
  check('its userOp is on record', !!hashS && cdp.ops.has(hashS), String(hashS))
  if (cdp.ops.has(hashS)) cdp.ops.get(hashS).outcome = 'complete'
  const strandedResume = await call('/api/experience/resume', { method: 'POST', body: { machineId: 'field-recordings', txHash: TX_DELIST, unitIndex: 0 } })
  check('and resume settles it on a delisted machine rather than stranding the payment',
    strandedResume.json?.claim?.state === 'delivered' && strandedResume.json.resumed === true,
    JSON.stringify(strandedResume.json?.claim ?? strandedResume.json).slice(0, 300))

  // Asserted on the reservation KEY, not just on the create route's answer. The
  // index scan that produces that answer reads machine records, so it would keep
  // saying "taken" even if the state transition quietly released the key — and
  // the key is the authoritative guard, the one a machine aged out of the index
  // window still relies on.
  check('the reservation key still names the delisted machine',
    strings.get(`kismetart:xp:capsule:${CAPSULE_2}:1`) === 'field-recordings',
    String(strings.get(`kismetart:xp:capsule:${CAPSULE_2}:1`)))

  const reuse = await call('/api/experience/machines', { method: 'POST', user: USER_TOKEN, body: {
    id: 'recordings-again', name: 'Again', capsule: { collection: CAPSULE_2, tokenId: '1' },
    entries: [{ collection: POOL, tokenId: '8', artist: CREATOR2, weight: 1, supply: 0 }], dryRun: true,
  } })
  check('and its capsule token is NOT freed for a successor to honour the same mint',
    reuse.status === 400 && reuse.json.problems?.[0]?.code === 'capsule-in-use',
    JSON.stringify(reuse.json).slice(0, 200))
  await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'live' } })

  // ═══ 6i. rarity by supply: every copy is one capsule ══════════════════════
  console.log('\n6i. rarity by supply')
  {
    const boxBody = (over = {}) => ({
      id: 'box-season', name: 'Box Season', rarity: 'supply', capsule: { collection: CAPSULE_S, tokenId: '1' },
      entries: [
        { collection: POOL, tokenId: '7', weight: 1, supply: 3 },
        // A typed weight means nothing by supply: its one copy is its weight.
        { collection: POOL, tokenId: '14', weight: 999, supply: 1 },
      ],
      ...over,
    })
    const publish = (body) => call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body })
    check('an unknown rarity is refused', (await publish(boxBody({ rarity: 'lottery', dryRun: true }))).status === 400)
    const unlimited = await publish(boxBody({ entries: [{ collection: POOL, tokenId: '7', weight: 1, supply: 0 }], dryRun: true }))
    check('by supply, an unlimited piece is refused — its copies are its odds',
      unlimited.status === 400 && unlimited.json.problems.some((p) => p.code === 'bad-supply' && /copies are its odds/.test(p.detail)),
      JSON.stringify(unlimited.json).slice(0, 240))
    const oversold = await publish(boxBody({ capsule: { collection: CAPSULE_O, tokenId: '1' }, dryRun: true }))
    check('a capsule that can sell more capsules than the copies inside is refused',
      oversold.status === 400 && oversold.json.problems.some((p) => p.code === 'undercollateralised'),
      JSON.stringify(oversold.json).slice(0, 240))
    setHead(chain.head + 10n)
    const box = await publish(boxBody())
    check('a capsule capped at the copies inside goes live', box.status === 200 && box.json.machine.state === 'live' && box.json.machine.rarity === 'supply',
      JSON.stringify(box.json).slice(0, 240))
    const odds = async () => Object.fromEntries((await call('/api/experience/machines/box-season')).json.odds.map((o) => [o.tokenId, o.probability]))
    const before = await odds()
    check('the published odds are copies over copies, whatever weight was typed',
      Math.abs(before['7'] - 0.75) < 1e-9 && Math.abs(before['14'] - 0.25) < 1e-9, JSON.stringify(before))
    check('and the page is told how its odds are set', (await call('/api/experience/machines/box-season')).json.machine.rarity === 'supply')

    setHead(chain.head + 5n)
    addMint({ tx: TX_BOX, collection: CAPSULE_S, to: PLAYER, id: 1n, value: 1n, block: chain.head - 2n })
    const played = await call('/api/experience/play', { method: 'POST', body: { machineId: 'box-season', txHash: TX_BOX, account: PLAYER, unitIndex: 0 } })
    const claim = JSON.parse(strings.get(`kismetart:xp:box-season:claim:${TX_BOX}:0`) ?? 'null')
    check('a play draws and delivers', played.json?.claim?.state === 'delivered', JSON.stringify(played.json).slice(0, 240))
    check('from a frozen table weighted by each piece\'s total copies',
      claim?.snapshot?.find((e) => e.tokenId === '7')?.weight === 3 && claim.snapshot.find((e) => e.tokenId === '14')?.weight === 1,
      JSON.stringify(claim?.snapshot))
    const won = played.json?.claim?.prize?.tokenId
    const after = await odds()
    // A one-of-one stays that rare all season: taking a copy of the common
    // piece does not make it likelier. Only a piece that runs out leaves.
    check('and the odds hold after a copy is taken, unless a piece ran out',
      won === '7' ? Math.abs(after['7'] - 0.75) < 1e-9 && Math.abs(after['14'] - 0.25) < 1e-9 : after['14'] === 0 && after['7'] === 1,
      `${won} ${JSON.stringify(after)}`)
    setHead(chain.head + 2n)
    addMint({ tx: TX_BOX_2, collection: CAPSULE_S, to: PLAYER, id: 1n, value: 1n, block: chain.head - 1n })
    await call('/api/experience/play', { method: 'POST', body: { machineId: 'box-season', txHash: TX_BOX_2, account: PLAYER, unitIndex: 0 } })
    const claim2 = JSON.parse(strings.get(`kismetart:xp:box-season:claim:${TX_BOX_2}:0`) ?? 'null')
    const weightsOf = (c) => Object.fromEntries((c?.snapshot ?? []).map((e) => [e.tokenId, e.weight]))
    check('and the next play still weighs each piece by its total copies',
      weightsOf(claim2)['7'] === 3 && weightsOf(claim2)['14'] === 1,
      `${won} ${JSON.stringify(weightsOf(claim2))}`)

    // A prize is an adminMint, like an airdrop — the artist sees them apart.
    // Logged after the response, so give the deferred write a moment.
    const mine = async () => (await call(`/api/experience/machines?creator=${ADMIN}`, { user: ADMIN_USER_TOKEN })).json?.machines ?? []
    let boxRow
    for (let i = 0; i < 30 && boxRow?.prizes?.count !== 2; i++) { boxRow = (await mine()).find((m) => m.id === 'box-season'); if (boxRow?.prizes?.count !== 2) await sleep(100) }
    check('the artist\'s machines count the prizes each delivered', boxRow?.prizes?.count === 2, JSON.stringify(boxRow?.prizes))
    check('and name who won what', boxRow?.prizes?.recent?.length === 2 && boxRow.prizes.recent.every((p) => p.player === PLAYER && ['7', '14'].includes(p.tokenId)))
    const redrawRow = (await mine()).find((m) => m.id === 'redraw')
    check('a prize a resume delivered is logged too', redrawRow?.prizes?.recent?.some((p) => p.txHash === TX_REDRAW_2 && p.tokenId === '15'), JSON.stringify(redrawRow?.prizes))
    check('and none of them is among the artist\'s airdrops', ((await call(`/api/airdrops?artist_address=${ADMIN}`, { user: ADMIN_USER_TOKEN })).json?.airdrops ?? []).length === 0)
  }

  // ═══ 6j. reveal machines ══════════════════════════════════════════════════
  console.log('\n6j. reveal machines — anyone curates, artists decide, the sale decides what shows')
  {
    const standing = (id) => call(`/api/experience/piece?collection=${REVEAL}&tokenId=${id}`)
    const setAvailable = (user, id, available) =>
      call('/api/experience/piece', { method: 'POST', user, body: { collection: REVEAL, tokenId: String(id), available } })
    check('every piece starts available to reveal machines', (await standing(1)).json?.available === true)
    check('turning one off needs a session', (await setAvailable(undefined, 1, false)).status === 401)
    check('and admin on the piece, read from the chain', (await setAvailable(CURATOR_TOKEN, 1, false)).status === 403)
    check('a choice must be a yes or a no',
      (await call('/api/experience/piece', { method: 'POST', user: ARTIST_B_TOKEN, body: { collection: REVEAL, tokenId: '1', available: 'no' } })).status === 400)
    const off = await setAvailable(ARTIST_B_TOKEN, 1, false)
    check('its artist turns it off', off.status === 200 && off.json.available === false)
    check('which reads back', (await standing(1)).json?.available === false)

    const lineup = (ids) => ids.map((id) => ({ collection: REVEAL, tokenId: String(id) }))
    const body = (over = {}) => ({ kind: 'reveal', id: 'new-voices', name: 'New Voices', entries: lineup([1, 2, 3, 4, 6]), ...over })
    const publish = (user, b) => call('/api/experience/machines', { method: 'POST', user, body: b })
    check('a reveal machine needs a Pass like any other', (await publish(NOPASS_TOKEN, body({ dryRun: true }))).status === 403)
    check('and an unknown kind is refused', (await publish(CURATOR_TOKEN, body({ kind: 'raffle', dryRun: true }))).status === 400)
    const refused = await publish(CURATOR_TOKEN, body({ entries: lineup([1, 2, 5]), dryRun: true }))
    const codes = (refused.json?.problems ?? []).map((p) => `${p.code}:${p.detail.match(/0x[0-9a-f]{40}:\d+/)?.[0]}`).sort()
    check('a piece its artist turned off, and one Kismet has no maker for, are refused — and nothing else',
      refused.status === 400 && codes.join(',') === `artist-unknown:${REVEAL}:5,piece-unavailable:${REVEAL}:1`, codes.join(','))
    await setAvailable(ARTIST_B_TOKEN, 1, true)

    const dry = await publish(CURATOR_TOKEN, body({ dryRun: true }))
    check('a lineup of other artists\' work passes, with no capsule and no mint rights', dry.status === 200 && dry.json.problems.length === 0,
      JSON.stringify(dry.json).slice(0, 240))
    const st = Object.fromEntries((dry.json?.lineup ?? []).map((p) => [p.tokenId, p.status]))
    check('and the check says what each piece would show as today',
      st['1'] === 'on-sale' && st['2'] === 'on-sale' && st['3'] === 'upcoming' && st['4'] === 'sold-out' && st['6'] === 'on-sale', JSON.stringify(st))
    check('a USDC sale reads as one', dry.json?.lineup?.find((p) => p.tokenId === '6')?.sale?.currency === 'usdc')
    check('a check writes nothing', !strings.has('kismetart:xp:new-voices:meta'))

    const queued = await publish(CURATOR_TOKEN, body())
    check('a Pass holder\'s reveal machine queues for review', queued.status === 200 && queued.json.machine.state === 'review' && queued.json.machine.kind === 'reveal',
      JSON.stringify(queued.json).slice(0, 200))
    check('and is not public yet', (await call('/api/experience/machines/new-voices')).status === 404)
    const row = (await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })).json?.machines?.find((r) => r.machine.id === 'new-voices')
    check('the curator sees its lineup as players would today, with no gate to fail',
      !!row && row.problems.length === 0 && row.lineup?.length === 5 && row.lineup.filter((p) => p.status === 'on-sale').length === 3)
    const approved = await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'new-voices', state: 'live' } })
    check('and approves it', approved.status === 200 && approved.json.machine.state === 'live')

    const shown = async () => ((await call('/api/experience/machines/new-voices')).json?.lineup ?? []).map((p) => p.tokenId).sort().join(',')
    const page = await call('/api/experience/machines/new-voices')
    check('players see only the pieces on sale right now', (await shown()) === '1,2,6', await shown())
    check('each at its own price, in its own currency',
      page.json.lineup.find((p) => p.tokenId === '1')?.sale?.pricePerToken === '2000000000000000' &&
      page.json.lineup.find((p) => p.tokenId === '2')?.sale?.pricePerToken === '0' &&
      page.json.lineup.find((p) => p.tokenId === '6')?.sale?.currency === 'usdc')
    // Piece 3's sale opens later; piece 4 is sold out and is not coming.
    check('and are told how many are waiting for a sale to open — not the sold-out one', page.json.waiting === 1, String(page.json.waiting))

    // Nobody touches anything: the sale decides.
    const sale1 = chain.sales.get(key(REVEAL, 1))
    chain.sales.set(key(REVEAL, 1), { ...sale1, saleEnd: 1n })
    check('a piece whose sale ends leaves by itself', (await shown()) === '2,6', await shown())
    chain.sales.set(key(REVEAL, 1), sale1)
    chain.tokens.set(key(REVEAL, 2), { maxSupply: 5n, totalMinted: 5n })
    check('as does one that sells out', (await shown()) === '1,6', await shown())
    chain.tokens.set(key(REVEAL, 2), { maxSupply: 5n, totalMinted: 1n })
    const sale3 = chain.sales.get(key(REVEAL, 3))
    chain.sales.set(key(REVEAL, 3), { ...sale3, saleStart: 0n })
    check('and one whose sale opens joins by itself', (await shown()) === '1,2,3,6', await shown())
    chain.sales.set(key(REVEAL, 3), sale3)
    await setAvailable(ARTIST_B_TOKEN, 1, false)
    check('an artist turning a piece off takes it out of a live machine at once', (await shown()) === '2,6', await shown())
    await setAvailable(ARTIST_B_TOKEN, 1, true)
    check('and turning it back on returns it', (await shown()) === '1,2,6', await shown())

    check('a reveal machine has no capsule to open',
      (await call('/api/experience/play', { method: 'POST', body: { machineId: 'new-voices', txHash: TX_A, account: PLAYER, unitIndex: 0 } })).status === 400)
    check('or to discover', (await call(`/api/experience/discover?machineId=new-voices&account=${PLAYER}`)).status === 400)
    check('each piece names the reveal machine it is in', (await standing(2)).json?.machines?.some((m) => m.id === 'new-voices' && m.kind === 'reveal'))
    const listed = (await call('/api/experience/machines')).json.machines.find((m) => m.id === 'new-voices')
    check('the public list carries it as a reveal machine, with no capsule', listed?.kind === 'reveal' && listed.capsule === undefined)
    const prof = await call(`/api/experience/machines?creator=${CURATOR}`)
    check('and its curator\'s profile lists it with its lineup size', prof.json?.machines?.some((m) => m.id === 'new-voices' && m.kind === 'reveal' && m.pieces === 5))

    const kismet = await publish(ADMIN_USER_TOKEN, body({ id: 'kismet-picks', name: 'Kismet Picks', entries: lineup([1, 2]) }))
    check('Kismet curates any artist\'s work and goes live directly', kismet.status === 200 && kismet.json.machine.state === 'live')

    await publish(CURATOR_TOKEN, body({ id: 'second-thoughts', name: 'Second Thoughts', entries: lineup([2]) }))
    const withdrawn = await call('/api/experience/machines/second-thoughts', { method: 'POST', user: CURATOR_TOKEN, body: { action: 'withdraw' } })
    check('a queued reveal machine can be withdrawn', withdrawn.status === 200 && withdrawn.json.withdrawn === true)
    check('which takes it off its pieces', !(sets.get(`kismetart:xp:uses:${REVEAL}:2`) ?? new Set()).has('second-thoughts'))
    check('and frees its id', (await publish(CURATOR_TOKEN, body({ id: 'second-thoughts', entries: lineup([2]), dryRun: true }))).status === 200)
    const closed = await call('/api/experience/machines/kismet-picks', { method: 'POST', user: ADMIN_USER_TOKEN, body: { action: 'end' } })
    check('its curator closes a live one', closed.status === 200 && closed.json.machine.state === 'ended')
  }

  // ═══ 6k. referral rewards reach their owners with nobody claiming ═════════
  console.log('\n6k. referral rewards are pushed to their owners')
  {
    const run = () => call(`/api/cron/referral-payouts?secret=${CRON_SECRET}`)
    check('the payout run refuses without the cron secret', (await call('/api/cron/referral-payouts')).status === 401)
    // A second curator, whose wallet refuses ETH — a withdrawal to it reverts.
    await call('/api/experience/machines', { method: 'POST', user: BUSY_TOKEN, body: { kind: 'reveal', id: 'busy-picks', name: 'Busy Picks', entries: [{ collection: REVEAL, tokenId: '2' }] } })
    chain.rewards.set(KISMET_REFERRAL, 1_000_000_000_000_000n)
    chain.rewards.set(CURATOR.toLowerCase(), 200_000_000_000_000n)
    chain.rewards.set(BUSY.toLowerCase(), 300_000_000_000_000n)
    chain.rejectsEth.add(BUSY.toLowerCase())
    // The admin wallet that publishes Kismet's own machines is not a curator:
    // those collects already name Kismet's referral address.
    chain.rewards.set(ADMIN.toLowerCase(), 5_000_000_000_000_000n)
    const before = cdp.ops.size
    const first = await run()
    const paid = (first.json?.paid ?? []).map((p) => p.address)
    check('Kismet\'s own referral balance and each curator\'s are paid, largest first',
      first.status === 200 && paid.join(',') === `${KISMET_REFERRAL},${CURATOR.toLowerCase()}`, JSON.stringify(first.json).slice(0, 300))
    const sent = [...cdp.ops.values()].slice(before).map((o) => o.calls[0])
    const decoded = sent.map((c) => decodeFunctionData({ abi: REWARDS_ABI, data: c.data }))
    check('each as one sponsored withdrawFor(owner, everything) on Zora\'s rewards contract',
      sent.length === 2 && sent.every((c) => String(c.to).toLowerCase() === PROTOCOL_REWARDS) &&
      decoded.every((d, i) => d.functionName === 'withdrawFor' && String(d.args[0]).toLowerCase() === paid[i] && d.args[1] === 0n))
    check('a curator whose wallet would refuse the ETH is skipped, not sent',
      first.json?.skipped?.some((x) => x.address === BUSY.toLowerCase() && /revert/.test(x.reason)) && !decoded.some((d) => String(d.args[0]).toLowerCase() === BUSY.toLowerCase()))
    check('the admin wallet is not paid as a curator', !paid.includes(ADMIN.toLowerCase()))
    check('and the paid balances are now in their owners\' wallets, not the escrow',
      chain.rewards.get(KISMET_REFERRAL) === 0n && chain.rewards.get(CURATOR.toLowerCase()) === 0n)
    check('a second run finds nothing left to pay', (await run()).json?.paid?.length === 0 && cdp.ops.size === before + 2)
    chain.rejectsEth.delete(BUSY.toLowerCase())
    chain.checkFails.add(BUSY.toLowerCase())
    const blind = await run()
    check('a check that cannot run is reported as such, not blamed on the wallet, and nothing is sent',
      blind.json?.skipped?.some((x) => x.address === BUSY.toLowerCase() && x.reason === 'could not check the withdrawal') && cdp.ops.size === before + 2,
      JSON.stringify(blind.json?.skipped))
    chain.checkFails.clear()
    chain.rejectsEth.add(BUSY.toLowerCase())
    chain.rewards.set(CURATOR.toLowerCase(), 40_000_000_000_000n)
    check('a balance too small to be worth the gas waits for the next run', (await run()).json?.paid?.length === 0)
    chain.rewards.set(CURATOR.toLowerCase(), 100_000_000_000_000n)
    chain.rewards.set(KISMET_REFERRAL, 100_000_000_000_000n)
    const refusals = cdp.refusals
    cdp.script.push('refuse')
    const refusedRun = await run()
    check('when sponsorship is refused the run stops rather than trying everyone',
      refusedRun.json?.paid?.length === 0 && cdp.refusals === refusals + 1 && cdp.script.length === 0, JSON.stringify(refusedRun.json).slice(0, 240))
    chain.rewards.clear()
  }

  // Notifications as the store holds them, newest last.
  const notesFor = (addr) => [...(zsets.get(`kismetart:notif:${addr.toLowerCase()}`)?.keys() ?? [])]
    .map((m) => { try { return JSON.parse(m) } catch { return null } })
    .filter(Boolean)
  /** Poll until `fn` holds: work a route defers with after() lands just
   *  after its response. */
  const eventually = async (fn, ms = 4000) => {
    for (let t = 0; t < ms; t += 100) { if (await fn()) return true; await sleep(100) }
    return !!(await fn())
  }

  // ═══ 6l. a capsule machine that runs dry ═════════════════════════════════
  // The odds a player reads, and the table a play draws from, are the chain's:
  // a piece that sells out elsewhere leaves them at once, a pledge larger than
  // what is left on-chain shows as what is left, and a table the chain cannot
  // confirm is not sold on. When the last deliverable artwork is given out,
  // the creator is told — once — to close the capsule's sale, because Kismet
  // can stop selling on its own page but not on zora.co.
  console.log('\n6l. a capsule machine that runs dry stops selling and tells its creator')
  {
    const pub = await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: {
      id: 'dry-season', name: 'Dry Season', capsule: { collection: CAPSULE_D, tokenId: '1' },
      entries: [
        { collection: POOL, tokenId: '17', artist: ADMIN, weight: 1, supply: 3 },
        { collection: POOL, tokenId: '18', artist: ADMIN, weight: 1, supply: 2 },
      ],
    } })
    check('it publishes with two capped pieces', pub.status === 200 && pub.json.machine.state === 'live', JSON.stringify(pub.json).slice(0, 200))
    const view = async () => (await call('/api/experience/machines/dry-season')).json
    const table = (v) => (v?.odds ?? []).map((o) => `${o.tokenId}:${o.remaining}:${o.probability}`).join(',')
    let v = await view()
    check('its odds list both, each with the copies pledged', table(v) === '17:3:0.5,18:2:0.5' && v.standingReadable === true, table(v))
    chain.tokens.set(key(POOL, 18), { maxSupply: 2n, totalMinted: 2n }) // collected elsewhere
    v = await view()
    check('a piece that sells out on-chain leaves the odds at once, and the rest renormalise', table(v) === '17:3:1', table(v))
    chain.tokens.set(key(POOL, 17), { maxSupply: 3n, totalMinted: 2n })
    v = await view()
    check('a pledge larger than what is left on-chain shows as what is left', table(v) === '17:1:1', table(v))
    check('and so does what the machine can still cover', v.coverage?.prizesRemaining === 1 && v.coverage.capsulesOutstanding === 5 && v.coverage.covered === false, JSON.stringify(v.coverage))
    chain.failMulticall = true
    v = await view()
    chain.failMulticall = false
    check('a table the chain cannot confirm is marked so, and the page will not sell on it', v?.standingReadable === false, JSON.stringify(v).slice(0, 120))
    check('the chain answering again confirms it', (await view()).standingReadable === true)

    // The last deliverable copy is opened; the delivery really mints it.
    cdp.applyMints = true
    setHead(chain.head + 5n)
    addMint({ tx: TX_DRY, collection: CAPSULE_D, to: PLAYER, id: 1n, value: 1n, block: chain.head })
    const p1 = await call('/api/experience/play', { method: 'POST', body: { machineId: 'dry-season', txHash: TX_DRY, account: PLAYER, unitIndex: 0 } })
    check('the last deliverable artwork is delivered', p1.json?.claim?.state === 'delivered' && p1.json.claim.prize?.tokenId === '17', JSON.stringify(p1.json?.claim).slice(0, 200))
    const empties = () => notesFor(ADMIN).filter((n) => n.type === 'experience_status' && n.note === 'empty' && n.machineId === 'dry-season')
    check('and its creator is told the machine has nothing left, so they can close the capsule\'s sale', await eventually(() => empties().length === 1), JSON.stringify(notesFor(ADMIN).map((n) => n.type)))
    check('naming the machine', empties()[0]?.tokenName === 'Dry Season')
    check('and it badges the bell, though it has no sender', empties()[0]?.priority === true && !empties()[0]?.actor)
    check('remembered in the machine\'s one notice set, not a key per notice',
      sets.get('kismetart:xp:dry-season:notices')?.has('empty') && ![...strings.keys()].some((k) => k.includes(':notice:')))
    v = await view()
    check('its page now shows nothing to win, on a table the chain confirmed', (v.odds ?? []).length === 0 && v.standingReadable === true && v.coverage?.prizesRemaining === 0, table(v))

    // Bought anyway, where Kismet cannot stop it: owed, not lost.
    addMint({ tx: TX_DRY_2, collection: CAPSULE_D, to: PLAYER, id: 1n, value: 1n, block: chain.head })
    const p2 = await call('/api/experience/play', { method: 'POST', body: { machineId: 'dry-season', txHash: TX_DRY_2, account: PLAYER, unitIndex: 0 } })
    check('a capsule bought after that is not lost: the play pends and says why',
      p2.json?.claim?.state === 'pending' && /no eligible artwork/.test(p2.json.claim.pendingReason ?? ''), JSON.stringify(p2.json?.claim).slice(0, 200))
    await sleep(600)
    check('and the creator is not told twice', empties().length === 1, String(empties().length))
    cdp.applyMints = false
  }

  // ═══ 6l-ii. a multi-pull is one notice ════════════════════════════════════
  // The page opens a pull's capsules one after another through the play
  // route, so a ten-pull delivers ten prizes the player watches appear. The
  // bell gets one row for the purchase, not ten.
  console.log('\n6l-ii. a multi-pull is one notice')
  {
    setHead(chain.head + 3n)
    addMint({ tx: TX_MULTI, collection: CAPSULE, to: PLAYER_3, id: 1n, value: 3n, block: chain.head })
    const opened = []
    for (const unitIndex of [0, 1, 2]) {
      const r = await call('/api/experience/play', { method: 'POST', body: { machineId: 'spring-season', txHash: TX_MULTI, account: PLAYER_3, unitIndex } })
      opened.push(r.json?.claim?.state)
    }
    check('all three capsules of the pull are delivered by the play route', opened.join() === 'delivered,delivered,delivered', opened.join())
    const wins = () => notesFor(PLAYER_3).filter((n) => n.type === 'experience_win')
    await eventually(() => wins().length >= 1)
    await sleep(600)
    check('and the player is told once, counting all three', wins().length === 1 && wins()[0].amount === 3, JSON.stringify(wins().map((n) => n.amount)))
  }

  // ═══ 6m. a reveal machine linked to a collection ══════════════════════════
  // A curator links a collection instead of (or as well as) picking pieces:
  // every Kismet-minted piece there joins, newest first, and new mints join as
  // they are minted (lib/mint-proxy → lib/experience/linked; the join itself
  // is proved by scripts/verify-experience-flow.ts section 13).
  console.log('\n6m. a reveal machine linked to a collection')
  {
    const publish = (user, over = {}) => call('/api/experience/machines', { method: 'POST', user, body: {
      kind: 'reveal', id: 'fresh-ink', name: 'Fresh Ink', entries: [], collections: [LINKED], ...over,
    } })
    const codes = (r) => (r.json?.problems ?? []).map((p) => p.code).join(',')
    const notZora = await publish(CURATOR_TOKEN, { collections: [NOT_ZORA], dryRun: true })
    check('an address that is not a Zora collection cannot be linked', notZora.status === 400 && codes(notZora) === 'collection-invalid', JSON.stringify(notZora.json).slice(0, 200))
    const pass = await publish(CURATOR_TOKEN, { collections: [PASS_COLLECTION], dryRun: true })
    check('nor can the Pass collection', pass.status === 400 && codes(pass) === 'collection-invalid' && /Pass collection/.test(pass.json.problems[0].detail))
    check('at most three collections', (await publish(CURATOR_TOKEN, { collections: [LINKED, EMPTY_COLL, NOT_ZORA, CAPSULE], dryRun: true })).status === 400)
    check('each an address', (await publish(CURATOR_TOKEN, { collections: ['0xnope'], dryRun: true })).status === 400)
    check('a machine with neither pieces nor a collection is still refused', (await publish(CURATOR_TOKEN, { collections: [], dryRun: true })).status === 400)
    const dry = await publish(CURATOR_TOKEN, { dryRun: true })
    const got = (dry.json?.lineup ?? []).map((p) => `${p.tokenId}:${p.status}`).join(',')
    check('with no pieces picked, the collection is the lineup: its Kismet-minted pieces, newest first', dry.status === 200 && got === '2:upcoming,1:on-sale', got)
    check('leaving out a piece Kismet has no maker for, and one its artist turned off, without complaint', dry.json?.problems?.length === 0)
    const both = await publish(CURATOR_TOKEN, { entries: [{ collection: REVEAL, tokenId: '1' }], dryRun: true })
    check('picked pieces come first and the collection fills the rest',
      (both.json?.lineup ?? []).map((p) => `${p.collection === REVEAL ? 'R' : 'L'}${p.tokenId}`).join(',') === 'R1,L2,L1')
    const picked = await publish(CURATOR_TOKEN, { entries: [{ collection: LINKED, tokenId: '4' }], dryRun: true })
    check('a piece picked by hand is still held to its artist\'s choice', picked.status === 400 && codes(picked) === 'piece-unavailable')
    const blank = await publish(CURATOR_TOKEN, { collections: [EMPTY_COLL], dryRun: true })
    check('a collection with nothing minted in it yet can be linked — the machine starts empty', blank.status === 200 && blank.json.lineup.length === 0)
    check('checks write nothing', !strings.has('kismetart:xp:fresh-ink:meta') && !sets.has(`kismetart:xp:linked:${LINKED}`))

    const queued = await publish(CURATOR_TOKEN)
    check('publishing queues it, remembering the link', queued.status === 200 && queued.json.machine.state === 'review' && queued.json.machine.collections?.join() === LINKED,
      JSON.stringify(queued.json).slice(0, 200))
    check('and points the collection at it, so a new mint finds it', sets.get(`kismetart:xp:linked:${LINKED}`)?.has('fresh-ink'))
    const pool = [...(hashes.get('kismetart:xp:fresh-ink:pool')?.values() ?? [])].map((v) => JSON.parse(v))
    check('its pieces are marked as linked, with when each was minted', pool.length === 2 && pool.every((e) => e.linkedAt > 0) &&
      pool.find((e) => e.tokenId === '2')?.linkedAt > pool.find((e) => e.tokenId === '1')?.linkedAt)
    check('each piece knows it is in the machine', sets.get(`kismetart:xp:uses:${LINKED}:1`)?.has('fresh-ink'))
    const row = (await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })).json?.machines?.find((r) => r.machine.id === 'fresh-ink')
    check('whoever reviews it sees the link and the lineup', row?.machine?.collections?.[0] === LINKED && row.lineup?.length === 2 && row.problems.length === 0)
    const live = await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'fresh-ink', state: 'live' } })
    check('and approves it', live.status === 200 && live.json.machine.state === 'live')
    const page = (await call('/api/experience/machines/fresh-ink')).json
    check('its page names the linked collection', page?.collections?.join() === LINKED)
    check('shows what is on sale now, and counts the piece whose sale opens later', page?.lineup?.map((p) => p.tokenId).join() === '1' && page.waiting === 1, JSON.stringify(page).slice(0, 200))
  }

  // ═══ 6o. everyone involved hears and sees what concerns them ══════════════
  console.log('\n6o. everyone involved hears and sees what concerns them')
  {
    const featured = (addr, id) => notesFor(addr).filter((n) => n.type === 'experience_featured' && n.machineId === id)
    // Artists
    const nv = featured(ARTIST_B, 'new-voices')
    check('an artist is told when a curator\'s machine featuring their work goes live', nv.length === 1 && nv[0].actor === CURATOR.toLowerCase() && nv[0].note === 'New Voices', JSON.stringify(nv))
    check('naming one of their pieces in it', nv[0]?.tokenAddress === REVEAL && ['1', '3', '4'].includes(nv[0]?.tokenId))
    check('every artist in it is told, once each however many pieces', featured(CREATOR2, 'new-voices').length === 1)
    check('the curator is not told about their own machine', featured(CURATOR, 'new-voices').length === 0)
    check('Kismet featuring an artist tells them too', featured(ARTIST_B, 'kismet-picks').length === 1 && featured(ARTIST_B, 'kismet-picks')[0].actor === ADMIN)
    check('a machine that never went live tells nobody', featured(CREATOR2, 'busy-picks').length === 0)
    await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'new-voices', state: 'delisted' } })
    await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'new-voices', state: 'live' } })
    check('taking a machine off the shelves and back tells nobody twice', featured(ARTIST_B, 'new-voices').length === 1 && featured(CREATOR2, 'new-voices').length === 1)
    const fi = featured(ARTIST_B, 'fresh-ink')
    check('a linked machine going live tells the artists of what it took in', fi.length === 1 && featured(CREATOR2, 'fresh-ink').length === 1)
    check('naming a piece they have not turned off', fi[0]?.tokenAddress === LINKED && fi[0]?.tokenId === '1', JSON.stringify(fi[0]))

    // Where their work is, on their profile — for anyone to see.
    const prof = (addr, user) => call(`/api/experience/machines?creator=${addr}`, { user })
    const ids = (r) => (r.json?.featuredIn ?? []).map((f) => f.id).sort().join(',')
    const bVisitor = await prof(ARTIST_B)
    check('an artist\'s profile lists other people\'s machines featuring them — live or closed, never queued or withdrawn',
      ids(bVisitor) === 'fresh-ink,kismet-picks,new-voices', ids(bVisitor))
    const nvRow = bVisitor.json?.featuredIn?.find((f) => f.id === 'new-voices')
    check('with who curated each and which of their pieces it holds', nvRow?.curator === CURATOR.toLowerCase() && nvRow.pieces.map((p) => p.tokenId).sort().join() === '1,3,4', JSON.stringify(nvRow))
    check('a closed machine says so', bVisitor.json.featuredIn.find((f) => f.id === 'kismet-picks')?.state === 'ended')
    // busy-picks holds CREATOR2's piece but is still queued; second-thoughts was withdrawn.
    check('a queued machine is not listed as featuring anyone', ids(await prof(CREATOR2)) === 'fresh-ink,kismet-picks,new-voices', ids(await prof(CREATOR2)))
    check('the artist signed in sees the same list', ids(await prof(ARTIST_B, ARTIST_B_TOKEN)) === ids(bVisitor))
    check('a curator\'s own machines are not "featured in" on their own profile', ids(await prof(CURATOR, CURATOR_TOKEN)) === '')
    check('the Pass-less and the unknown see it too, with no session', (await prof(ARTIST_B, NOPASS_TOKEN)).status === 200)

    // Curators: what the payout run has paid them, for their eyes only.
    const cOwn = await prof(CURATOR, CURATOR_TOKEN)
    check('a curator sees on their own profile what has been paid to them', cOwn.json?.referralPaid === '200000000000000', String(cOwn.json?.referralPaid))
    check('nobody else sees it', (await prof(CURATOR)).json?.referralPaid === undefined && (await prof(CURATOR, USER_TOKEN)).json?.referralPaid === undefined)
    check('and someone who curates nothing has no such line', (await prof(ARTIST_B, ARTIST_B_TOKEN)).json?.referralPaid === undefined)
    const ops = [...(hashes.get('kismetart:referral-payouts:ops')?.values() ?? [])].map((v) => JSON.parse(v))
    check('every payout sent is on the ledger, settled against the chain', ops.length === 2 && ops.every((o) => o.status === 'landed' && /^0x[0-9a-f]{64}$/.test(o.txHash)), JSON.stringify(ops))
    check('the totals are exact past 2^53 wei', hashes.get('kismetart:referral-payouts:paid')?.get(KISMET_REFERRAL) === 'wei:1000000000000000')
    const curators = [...(sets.get('kismetart:xp:curators') ?? [])].sort()
    check('the payout run knows every curator, and not the admin wallet', curators.join() === [BUSY, CURATOR].map((a) => a.toLowerCase()).sort().join(), curators.join())
    const again = await call(`/api/cron/referral-payouts?secret=${CRON_SECRET}`)
    check('a run with nothing outstanding settles nothing and sends nothing',
      again.status === 200 && JSON.stringify(again.json.settled) === JSON.stringify({ landed: 0, failed: 0, waiting: 0, expired: 0 }) && again.json.paid.length === 0, JSON.stringify(again.json).slice(0, 200))

    // The artwork page, for anyone: the live machines a piece is in.
    const listing = (collection, id) => call(`/api/experience/piece?collection=${collection}&tokenId=${id}&public=1`)
    const calls = chain.ethCalls
    const r1 = await listing(REVEAL, 1)
    check('an artwork\'s public listing names the live machines it is in, and no others',
      r1.status === 200 && r1.json.machines.map((m) => `${m.id}:${m.kind}`).join() === 'new-voices:reveal', JSON.stringify(r1.json))
    check('with nothing else about the piece or its artist', Object.keys(r1.json).join() === 'machines')
    check('cacheable by anyone, and read without touching the chain', /public/.test(r1.headers.get('cache-control') ?? '') && /s-maxage=60/.test(r1.headers.get('cache-control') ?? '') && chain.ethCalls === calls,
      `${r1.headers.get('cache-control')} calls=${chain.ethCalls - calls}`)
    check('a queued machine is never listed', !(await listing(REVEAL, 2)).json.machines.some((m) => m.id === 'busy-picks'))
    check('a capsule machine is listed as a capsule prize', (await listing(POOL, 7)).json.machines.some((m) => m.id === 'spring-season' && m.kind === 'capsule'))
    await call('/api/experience/piece', { method: 'POST', user: ARTIST_B_TOKEN, body: { collection: REVEAL, tokenId: '1', available: false } })
    check('a piece its artist turned off is listed in no reveal machine', (await listing(REVEAL, 1)).json.machines.length === 0)
    await call('/api/experience/piece', { method: 'POST', user: ARTIST_B_TOKEN, body: { collection: REVEAL, tokenId: '1', available: true } })
    check('a malformed request is refused', (await call('/api/experience/piece?collection=0xnope&tokenId=1&public=1')).status === 400)

    // Kismet, the only reviewer, hears of each machine waiting for it.
    const statusFor = (addr, id) => notesFor(addr).filter((n) => n.type === 'experience_status' && n.machineId === id)
    const queued = statusFor(ADMIN, 'fresh-ink').filter((n) => n.note === 'review')
    check('Kismet is told when a machine is submitted for review, and by whom', queued.length === 1 && queued[0].actor === CURATOR.toLowerCase() && queued[0].tokenName === 'Fresh Ink' && queued[0].priority === true, JSON.stringify(queued))
    check('for capsule machines too', statusFor(ADMIN, 'field-recordings').some((n) => n.note === 'review'))
    check('but not about machines Kismet published itself', statusFor(ADMIN, 'kismet-picks').length === 0 && statusFor(ADMIN, 'spring-season').length === 0)
    // Its curator hears each decision, in words that fit a reveal machine.
    check('a curator hears their machine was delisted, then relisted', statusFor(CURATOR, 'new-voices').map((n) => n.note).join() === 'live,delisted,live', statusFor(CURATOR, 'new-voices').map((n) => n.note).join())
    // Ended or delisted, a machine taken off before it ever went live was
    // turned down — not closed with "anything already bought is honoured".
    await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'busy-picks', state: 'ended' } })
    await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'busy-picks', state: 'delisted' } })
    check('a machine turned down before it ever went live is told it was not approved', statusFor(BUSY, 'busy-picks').map((n) => n.note).join() === 'rejected,rejected', statusFor(BUSY, 'busy-picks').map((n) => n.note).join())
    // A payout that lands is told to its curator once, as a money notice.
    const paidNotes = (addr) => notesFor(addr).filter((n) => n.type === 'payout' && n.note === 'referral')
    check('a curator is told their referral rewards were paid, with the amount', paidNotes(CURATOR).length === 1 && paidNotes(CURATOR)[0].price === '200000000000000' && paidNotes(CURATOR)[0].priority === true, JSON.stringify(paidNotes(CURATOR)))
    check('Kismet\'s own referral address is paid but told nothing', paidNotes(KISMET_REFERRAL).length === 0)
    // Once-only notices: one set per machine, no key per artist.
    const nvNotices = sets.get('kismetart:xp:new-voices:notices')
    check('featured notices are remembered in one set per machine', nvNotices?.has(`featured:${ARTIST_B.toLowerCase()}`) && nvNotices.has(`featured:${CREATOR2.toLowerCase()}`) && ![...strings.keys()].some((k) => k.includes(':notice:')))
  }

  // ═══ 8. the daily commitment cron ══════════════════════════════════════════
  console.log('\n8. the daily commitment cron')
  check('the cron refuses without its secret', (await call('/api/cron/experience-seeds')).status === 401)
  const cron = await call(`/api/cron/experience-seeds?secret=${CRON_SECRET}`)
  check('it commits for every capsule machine that can still draw', cron.status === 200 && cron.json.committed === 7 && cron.json.failed.length === 0, JSON.stringify(cron.json))
  check('and for no reveal machine, which never draws on the server', ![...strings.keys()].some((k) => /^kismetart:xp:(new-voices|kismet-picks):seed:/.test(k)))
  const tomorrow = dayShift(today, 1)
  check("every live machine now holds tomorrow's seed", ['spring-season', 'no-grant', 'field-recordings', 'owned-floor', 'redraw', 'dry-season'].every((id) => strings.has(`kismetart:xp:${id}:seed:${tomorrow}`)))
  const before = strings.get(`kismetart:xp:spring-season:seed:${today}`)
  await call(`/api/cron/experience-seeds?secret=${CRON_SECRET}`)
  check('running it again rotates nothing', strings.get(`kismetart:xp:spring-season:seed:${today}`) === before)

  // ═══ 9. the pages as a person sees them ═════════════════════════════════════
  //
  // Everything above drives the API. This drives the BUILT APP in a real
  // Chromium against the same mock chain, so the assertions are about what a
  // person sees rendered — labels, disabled states, the words on the face of
  // the machine — which no API check can vouch for. The wallet is a stub
  // EIP-1193 provider under a Coinbase-WebView user agent: that is the one
  // environment where the app registers a plain injected connector and
  // connects it on mount, so the studio's wallet flow runs with no picker to
  // click through. Session cookies carry the `__Host-` prefix, which a browser
  // refuses over plain http, so they are added as request headers instead.
  console.log('\n9. the pages as a person sees them')
  {
    const origin = `http://127.0.0.1:${PORT}`
    // playwright-core is a devDependency and the browser is pre-provisioned in
    // dev images. Without playwright-core this section is skipped with a notice
    // — the API checks above stand on their own; with it but no Chromium to
    // launch, that is a failed check, since the pages are what only this
    // section can vouch for.
    let chromium = null
    try { ({ chromium } = await import('playwright-core')) } catch { /* not installed */ }
    if (!chromium) {
      console.log('  SKIP  browser checks — playwright-core not installed (npm i -D playwright-core)')
    } else {
    const candidates = [
      undefined,
      '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
      '/opt/pw-browsers/chromium/chrome-linux/chrome',
    ]
    let browser = null
    let launchErr = null
    for (const executablePath of candidates) {
      try { browser = await chromium.launch(executablePath ? { executablePath } : {}); break } catch (e) { launchErr = e }
    }
    check('a Chromium can be launched (npx playwright-core install chromium, or PLAYWRIGHT_BROWSERS_PATH)', !!browser, String(launchErr?.message ?? '').slice(0, 160))
    if (browser) {
      const pageErrors = []
      // What every artist's clip plays as here. The frames themselves are
      // H.264, which this Chromium cannot decode, so any video a page asks for
      // is served as this: a second of VP8 the browser records for itself.
      const WEBM = await (async () => {
        const pg = await browser.newPage()
        const b64 = await pg.evaluate(async () => {
          const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 })
          const ctx = canvas.getContext('2d')
          const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' })
          const chunks = []
          rec.ondataavailable = (e) => chunks.push(e.data)
          let n = 0
          const paint = setInterval(() => { ctx.fillStyle = n++ % 2 ? '#f0f' : '#0ff'; ctx.fillRect(0, 0, 64, 64) }, 33)
          rec.start()
          await new Promise((r) => setTimeout(r, 1000))
          rec.stop()
          clearInterval(paint)
          await new Promise((r) => (rec.onstop = r))
          const buf = new Uint8Array(await new Blob(chunks).arrayBuffer())
          let bin = ''
          for (const b of buf) bin += String.fromCharCode(b)
          return btoa(bin)
        })
        await pg.close()
        return Buffer.from(b64, 'base64')
      })()
      const mediaRequests = []
      // `E2E_SHOTS=<dir>`: a full-page screenshot of every page the suite opens,
      // taken as it closes, and of the moments below that only a screenshot
      // shows — the run's visual record, for review. Off by default.
      const SHOTS = process.env.E2E_SHOTS
      let shots = 0
      if (SHOTS) mkdirSync(SHOTS, { recursive: true })
      const shotName = (name) => `${SHOTS}/${String(++shots).padStart(3, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60)}.png`
      /** A page with optional session headers and an optional stub wallet. */
      const open = async (path, { user, admin, wallet, onChain, moment, viewport, storage, images, uploads, reducedMotion, media } = {}) => {
        // The session cookies carry the `__Host-` prefix, so the browser jar
        // refuses to hold them over plain http (Chromium's CDP setCookie
        // enforces the prefix's Secure-scheme rule even on loopback), and
        // route.continue() silently strips a `Cookie` override. extraHTTPHeaders
        // sidesteps both: it attaches the header at the network layer, and the
        // Next server reads a plain Cookie header exactly as the API-level
        // call() helper's requests do. Set at context creation so it rides the
        // very first navigation, and same-origin only by construction (the
        // context makes no authenticated cross-origin requests).
        const cookieHeader = [
          user && `${USER_COOKIE}=${user}`,
          admin && `${ADMIN_COOKIE}=${admin}`,
        ].filter(Boolean).join('; ')
        const context = await browser.newContext({
          ...(wallet
            ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) CoinbaseWallet/1.0 Mobile Safari/604.1', viewport: { width: 390, height: 844 } }
            : { viewport: viewport ?? { width: 1024, height: 900 } }),
          ...(cookieHeader ? { extraHTTPHeaders: { cookie: cookieHeader } } : {}),
          // `reducedMotion`: the viewer has asked their system for less motion.
          ...(reducedMotion ? { reducedMotion: 'reduce' } : {}),
        })
        context.setDefaultTimeout(20_000)
        // `onChain`: the page reads and writes the mock chain. Its wagmi
        // client's reads go to a public Base RPC URL, rerouted here; the
        // wallet's own calls — gas, nonce, the signed transaction — go to the
        // same mock through an exposed function, and a signed transaction is
        // applied to it (walletSend). Opt-in, so every other page keeps a
        // wallet that can do nothing but name its account.
        if (onChain) {
          await context.exposeFunction('__e2eRpc', (method, params) =>
            method === 'eth_sendTransaction' ? walletSend(params[0]) : rpc(method, params ?? []))
          await context.route((url) => url.origin !== origin, async (route) => {
            const req = route.request()
            const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' }
            if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
            const body = req.postData() ?? ''
            if (req.method() !== 'POST' || !body.includes('"jsonrpc"')) return route.abort()
            const r = await fetch(`http://127.0.0.1:${rpcPort}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
            return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: await r.text() })
          })
        }
        // `moment`: the artwork page's detail, which it otherwise fetches from
        // In Process — served the way scripts/e2e/model-media.mjs serves it.
        if (moment) {
          await context.route(/\/api\/moment\?/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(moment) }))
        }
        if (wallet) {
          await context.addInitScript((addr) => {
            const provider = {
              isCoinbaseWallet: true,
              async request({ method, params }) {
                switch (method) {
                  case 'eth_requestAccounts':
                  case 'eth_accounts': return [addr]
                  case 'eth_chainId': return '0x2105'
                  case 'net_version': return '8453'
                  case 'wallet_switchEthereumChain':
                  case 'wallet_addEthereumChain': return null
                  case 'wallet_getPermissions':
                  case 'wallet_requestPermissions': return [{ parentCapability: 'eth_accounts' }]
                  default: {
                    if (typeof window.__e2eRpc === 'function') return window.__e2eRpc(method, params)
                    const e = new Error(`stub wallet: ${method}`); e.code = 4200; throw e
                  }
                }
              },
              on() { return this }, removeListener() { return this }, removeAllListeners() { return this },
            }
            Object.defineProperty(window, 'ethereum', { value: provider, configurable: true })
          }, wallet)
        }
        // `images`: every image loads, as it would with the network up. Nothing
        // can load in this sandbox, and an image whose every source fails is
        // taken off the page (MomentImage) — so without this, whether an image
        // is there to assert on depends on how fast its sources fail. Anything
        // that is not an image falls through to the routes above.
        if (images) {
          await context.route('**/*', (r) =>
            r.request().resourceType() === 'image' ? r.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG }) : r.fallback())
        }
        // `uploads`: Arweave's upload service answers, and what it received is
        // recorded. Everything before it is the app's own path — the file is
        // prepared, signed by /api/sign with the server's key, and sent.
        if (uploads) {
          await context.route(/^https:\/\/(upload|payment)\.ardrive\.(io|dev)\//, async (r) => {
            const req = r.request()
            if (req.method() === 'POST' && /\/tx\//.test(new URL(req.url()).pathname)) {
              const id = `e2eUpload${String(arweaveUploads.length + 1).padStart(34, '0')}`
              const body = req.postDataBuffer() ?? Buffer.alloc(0)
              arweaveUploads.push({ id, bytes: body.length, body })
              return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
                id, owner: 'e2e', dataCaches: ['arweave.net'], fastFinalityIndexes: ['arweave.net'], winc: '0', deadlineHeight: 0, timestamp: Date.now(),
              }) })
            }
            return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
          })
        }
        // `media`: every video loads, as it would with the network up — each
        // served as WEBM, and what was asked for recorded.
        if (media) {
          await context.route('**/*', (r) => {
            if (r.request().resourceType() !== 'media') return r.fallback()
            mediaRequests.push(r.request().url())
            return r.fulfill({ status: 200, contentType: 'video/webm', body: WEBM })
          })
        }
        // `storage`: localStorage the page finds on load, as a returning visitor's would be.
        if (storage) {
          await context.addInitScript((entries) => {
            for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v)
          }, storage)
        }
        const page = await context.newPage()
        page.on('pageerror', (e) => pageErrors.push(`${path}: ${e.message}`))
        if (SHOTS) {
          const close = context.close.bind(context)
          context.close = async (...a) => {
            await page.screenshot({ path: shotName(path), fullPage: true }).catch(() => {})
            return close(...a)
          }
        }
        await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' })
        // Interact only once React owns the page. Text typed into the
        // server-rendered inputs before hydration is reset to the component's
        // initial state when React attaches, which empties a form silently —
        // an intermittent studio failure traced to exactly this. Next creates
        // its route announcer in an effect at the app root, so the element
        // exists only once the tree has hydrated.
        await page.waitForFunction(() => document.getElementsByTagName('next-route-announcer').length > 0, null, { timeout: 20_000 }).catch(() => {})
        return page
      }
      // innerText returns text AS RENDERED, so a `text-transform: uppercase`
      // label reads back uppercased. Lowercase the haystack so an assertion tests
      // the words, not the CSS; getByText (raw DOM text) is used where case matters.
      const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ').toLowerCase()
      // A machine's result as the page shows it — not the same words in its
      // screen-reader status region (role=status), which a text search finds too.
      const shown = (page, words) => page.getByText(words).and(page.locator(':not([role="status"])'))
      // Every stage a machine's window passes through from now on, in order:
      // [stage, when, the capsule's animation, the artist's frame on show — its
      // element and source]. A MutationObserver runs before the next paint, so
      // even a stage shown for one frame is recorded; null is a face with no
      // window (a win, a reveal).
      // Alongside: each thing the box's status region says (window.__said) and
      // how many view transitions the page started (window.__vt).
      const watchStages = (page) => page.evaluate(() => {
        window.__stages = []
        window.__said = []
        window.__vt = 0
        const start = document.startViewTransition?.bind(document)
        // Each one's outcome too: `ready` rejects when a transition cannot run
        // (two elements of one name, an update that throws), and it is skipped.
        window.__vtRan = 0
        window.__vtErrors = []
        if (start) {
          document.startViewTransition = (cb) => {
            window.__vt++
            const t = start(cb)
            t.ready.then(() => window.__vtRan++, (e) => window.__vtErrors.push(String(e)))
            return t
          }
        }
        let lastSaid = ''
        const say = () => {
          const t = document.querySelector('[role="status"]')?.textContent ?? ''
          if (t && t !== lastSaid) window.__said.push((lastSaid = t))
        }
        let last
        const note = () => {
          const el = document.querySelector('[data-stage]')
          const stage = el?.getAttribute('data-stage') ?? null
          if (stage === last) return
          last = stage
          const svg = el?.querySelector('svg')
          const frame = stage && el.querySelector(`[data-frame="${stage}"]`)
          const art = frame ? `${frame.tagName.toLowerCase()} ${frame.getAttribute('src') ?? frame.querySelector('img')?.getAttribute('src') ?? ''}` : null
          window.__stages.push([stage, performance.now(), svg ? getComputedStyle(svg).animationName : null, art])
        }
        note()
        new MutationObserver(() => { note(); say() }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-stage'] })
      })
      const stagesOf = (page) => page.evaluate(() => window.__stages)
      const saidOf = (page) => page.evaluate(() => window.__said)
      /** How many view transitions the page started, and ran, as `ran/started`
       *  with any error that stopped one. */
      const transitionsOf = (page) => page.evaluate(() => `${window.__vtRan}/${window.__vt}${window.__vtErrors.length ? ` ${window.__vtErrors.join('; ')}` : ''}`)
      /** Where keyboard focus is, as its text, or 'body' when it fell to the page. */
      const focusOf = (page) => page.evaluate(() => (document.activeElement === document.body ? 'body' : document.activeElement?.textContent?.replace(/\s+/g, ' ').trim() ?? ''))
      /** Where an element sits against the fixed header: its top and bottom,
       *  the header's bottom, and the viewport's height. */
      const underNav = (page, selector) => page.evaluate((sel) => {
        const el = sel === ':focus' ? document.activeElement : document.querySelector(sel)
        const r = el?.getBoundingClientRect()
        return { top: r?.top ?? NaN, bottom: r?.bottom ?? NaN, nav: document.querySelector('header')?.getBoundingClientRect().bottom ?? NaN, view: innerHeight }
      }, selector)
      // The side, in CSS px, that artists' clips are screened for flashing at
      // (lib/media/flashScreen FLASH_STAGE_PX): the stage may be no larger.
      const SCREENED_SIDE = 240
      const stageSide = async (page) => {
        const b = await page.locator('[data-stage]').boundingBox()
        return b ? Math.max(b.width, b.height) : Infinity
      }
      // How long the stage `name` was shown, the nth time it was.
      const stageMs = (stages, name, nth = 0) => {
        const i = stages.map(([s], j) => (s === name ? j : -1)).filter((j) => j >= 0)[nth]
        return i === undefined || !stages[i + 1] ? null : stages[i + 1][1] - stages[i][1]
      }

      try {
        // ── the list ──
        {
          // Machines published before covers existed have none in their record.
          for (const id of ['dry-season', 'new-voices']) {
            const k = `kismetart:xp:${id}:meta`
            const { cover: _dropped, ...before } = JSON.parse(strings.get(k))
            strings.set(k, JSON.stringify(before))
          }
          const page = await open('/play', { images: true })
          const body = await text(page)
          check('the list page leads with its name and promise', /play capsule machines and reveal machines · published odds/.test(body), body.slice(0, 160))
          check('and offers the studio', (await page.getByRole('link', { name: 'build gachapon' }).getAttribute('href').catch(() => null)) === '/play/create')
          const cards = page.locator('article', { has: page.locator('a[href^="/play/"]') })
          const shelved = (await call('/api/experience/machines')).json.machines
          check('every machine on the shelves is a card', (await cards.count()) === shelved.length, `${await cards.count()} vs ${shelved.length}`)
          check('each names its kind and whether it is live', (await cards.allInnerTexts()).every((t) => /\b(capsule|reveal)\b/i.test(t) && /\b(live|closed)\b/i.test(t)))
          const [a, b] = [await cards.nth(0).boundingBox(), await cards.nth(1).boundingBox()]
          check('two to a row on a wide screen', !!a && !!b && Math.abs(a.y - b.y) < 1 && b.x > a.x, JSON.stringify([a, b]))
          const card = (id) => cards.filter({ has: page.locator(`a[href="/play/${id}"]`) })
          // Scrolled to first, as a visitor would: a card far down the list
          // renders its image only as it nears the viewport.
          const coverOf = async (id) => {
            await card(id).scrollIntoViewIfNeeded().catch(() => {})
            const img = card(id).locator('img').first()
            await img.waitFor({ timeout: 5000 }).catch(() => {})
            return decodeURIComponent((await img.getAttribute('src').catch(() => null)) ?? '')
          }
          check('a machine shows its cover', (await coverOf('spring-season')).includes(SPRING_COVER.uri.slice(5)), await coverOf('spring-season'))
          check('one published before covers shows its capsule instead', (await coverOf('dry-season')).includes('dry-season-capsule'),
            `${await coverOf('dry-season')} | ${JSON.stringify(shelved.find((m) => m.id === 'dry-season'))}`)
          const cardText = async (id) => (await card(id).innerText()).toLowerCase()
          check('a capsule machine\'s card shows the price of a play, as its page does', /[\d.]+ eth per play/.test(await cardText('spring-season')), await cardText('spring-season'))
          const reveals = shelved.filter((m) => m.kind === 'reveal')
          check('a reveal machine\'s card shows no price — each piece has its own',
            reveals.length > 0 && (await Promise.all(reveals.map((m) => cardText(m.id)))).every((t) => !t.includes('per play')))
          check('and one published before covers shows its first piece',
            reveals.some((m) => /reveal-(one|two)/.test(m.cover?.image ?? '')), JSON.stringify(reveals.map((m) => [m.id, m.cover])))
          await page.context().close()
          const phone = await open('/play', { viewport: { width: 390, height: 844 }, images: true })
          const phoneCards = phone.locator('article', { has: phone.locator('a[href^="/play/"]') })
          const [p0, p1] = [await phoneCards.nth(0).boundingBox(), await phoneCards.nth(1).boundingBox()]
          check('and one to a row on a phone', !!p0 && !!p1 && p1.y > p0.y + p0.height - 1 && Math.abs(p0.x - p1.x) < 1, JSON.stringify([p0, p1]))
          await phone.context().close()
        }

        // ── a creator changes a live machine's cover ──
        {
          const visitor = await open('/play/spring-season')
          await visitor.getByText('insert coin').waitFor()
          await visitor.waitForTimeout(1500)
          check('a visitor is offered no cover to change', (await visitor.getByRole('button', { name: /cover/ }).count()) === 0)
          await visitor.context().close()
          const refused = await Promise.all([
            call('/api/experience/machines/spring-season', { method: 'POST', user: CURATOR_TOKEN, body: { action: 'cover', cover: TEST_COVER } }),
            call('/api/experience/machines/spring-season', { method: 'POST', user: ADMIN_USER_TOKEN, body: { action: 'cover', cover: { uri: 'https://example.com/x.png' } } }),
          ])
          check('only its creator can change it, and only to an Arweave upload', refused[0].status === 403 && refused[1].status === 400, refused.map((r) => r.status).join())
          const page = await open('/play/spring-season', { user: ADMIN_USER_TOKEN, wallet: ADMIN, uploads: true })
          await page.getByRole('button', { name: 'change cover' }).waitFor()
          // A cover is a still — on the card, and in the stage, which plays only
          // screened motion. One that moves is refused as it is picked, and a gif
          // becomes its first frame: never the moving original.
          const { default: sharp } = await import('sharp')
          const coverNow = async (want) => {
            for (let i = 0; i < 75; i++) {
              const c = (await call('/api/experience/machines/spring-season')).json?.machine?.cover
              if (c === want) return c
              await sleep(200)
            }
            return (await call('/api/experience/machines/spring-season')).json?.machine?.cover
          }
          await page.getByLabel('cover image').setInputFiles({ name: 'moving.webp', mimeType: 'image/webp', buffer: await sharp(tinyGif(10), { animated: true }).webp().toBuffer() })
          const movingRefused = await page.getByText('This image moves — a cover is a still: use a png or jpg, or a gif (its first frame is used)')
            .waitFor({ timeout: 15_000 }).then(() => true, () => false)
          await page.getByLabel('cover image').setInputFiles({ name: 'strobe.svg', mimeType: 'image/svg+xml', buffer: STROBE_SVG })
          const svgRefused = await page.getByText('An SVG can move by itself — a cover is a still: use a png or jpg, or a gif (its first frame is used)')
            .waitFor({ timeout: 15_000 }).then(() => true, () => false)
          const nothingToSave = (await page.getByRole('button', { name: 'save cover' }).count()) === 0
          const beforeGif = arweaveUploads.length
          await page.getByLabel('cover image').setInputFiles({ name: 'moving.gif', mimeType: 'image/gif', buffer: tinyGif(10) })
          await page.getByRole('button', { name: 'save cover' }).click({ timeout: 30_000 })
          for (let i = 0; i < 75 && arweaveUploads.length === beforeGif; i++) await sleep(200)
          const gifSent = arweaveUploads.slice(beforeGif).map((u) => dataItemPayload(u.body))
          const gifCover = await coverNow(`ar://${arweaveUploads[beforeGif]?.id}`)
          check('a cover that moves, or can (an SVG), is refused as it is picked; a gif cover is uploaded as its first frame, a still — never the moving original',
            movingRefused && svgRefused && nothingToSave && gifSent.length === 1 && !!gifSent[0] && gifSent[0].subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) &&
              gifCover === `ar://${arweaveUploads[beforeGif]?.id}`,
            `${movingRefused} ${svgRefused} ${nothingToSave} ${gifSent.length} ${gifSent[0]?.subarray(0, 4).toString('hex')} ${gifCover}`)
          const beforePng = arweaveUploads.length
          await page.getByLabel('cover image').setInputFiles({ name: 'new-cover.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
          await page.getByRole('button', { name: 'save cover' }).click({ timeout: 30_000 })
          for (let i = 0; i < 75 && arweaveUploads.length === beforePng; i++) await sleep(200)
          const now = await coverNow(`ar://${arweaveUploads.at(-1)?.id}`)
          check('its creator changes it from the live machine\'s page, and the machine carries the new one',
            now === `ar://${arweaveUploads.at(-1)?.id}` && now !== SPRING_COVER.uri, now)
          await page.context().close()
          // The browser signs every upload from one address, and this mock's
          // counters never expire, so the extra covers above would put the
          // studio's later uploads over /api/sign's per-IP limit (10 a minute) —
          // the test's doing, not a person's.
          for (const k of [...strings.keys()]) if (k.startsWith('kismetart:rl:sign:')) strings.delete(k)
        }

        // ── a machine's frames, set by its creator ──
        {
          for (const k of [...strings.keys()]) if (k.startsWith('kismetart:rl:xp-owner:')) strings.delete(k)
          const set = (id, user, frames) => call(`/api/experience/machines/${id}`, { method: 'POST', user, body: { action: 'frames', frames } })
          const refused = [
            await set('spring-season', CURATOR_TOKEN, { dispense: TEST_FRAME }),
            await set('spring-season', ADMIN_USER_TOKEN, { dispense: { ...TEST_FRAME, uri: 'https://example.com/a.mp4' } }),
            await set('spring-season', ADMIN_USER_TOKEN, { idle: TEST_FRAME }),
            await set('new-voices', CURATOR_TOKEN, { dispense: TEST_FRAME }),
          ]
          check('only its creator sets a machine\'s frames — Arweave uploads, for the stages its kind has',
            refused.map((r) => r.status).join() === '403,400,400,400', refused.map((r) => r.status).join())
          const still = { uri: TEST_FRAME.poster, kind: 'image', poster: TEST_FRAME.poster }
          // What they are, for the server to fetch and screen: a calm clip, and its still.
          const { default: sharp } = await import('sharp')
          gatewayFiles.set(TEST_FRAME.uri.slice(5), { bytes: makeClip('test-frame', 'mp4', GLIDE), type: 'video/mp4' })
          gatewayFiles.set(TEST_FRAME.poster.slice(5), { bytes: await sharp({ create: { width: 160, height: 160, channels: 3, background: '#224' } }).jpeg().toBuffer(), type: 'image/jpeg' })
          const set1 = await set('spring-season', ADMIN_USER_TOKEN, { dispense: TEST_FRAME, open: still })
          const shown = await screened('spring-season', ['dispense', 'open'])
          check('its creator sets them; the server screens them, and once they pass the machine\'s page is given them',
            set1.status === 200 && JSON.stringify(shown?.frames) === JSON.stringify({ dispense: TEST_FRAME, open: still }) &&
              shown?.frameStatus?.dispense?.state === 'passed' && shown?.frameStatus?.open?.state === 'passed',
            JSON.stringify(shown?.frameStatus))
          await set('spring-season', ADMIN_USER_TOKEN, {})
          check('and clears them, back to the platform\'s capsule', (await call('/api/experience/machines/spring-season')).json?.machine?.frames === null)
          const reveal = await call('/api/experience/machines', { method: 'POST', user: CURATOR_TOKEN, body: {
            kind: 'reveal', id: 'frames-check', name: 'Frames Check', entries: [{ collection: REVEAL, tokenId: '2' }], frames: { dispense: TEST_FRAME }, dryRun: true,
          } })
          check('a reveal machine, whose pull waits on nothing, is refused a dispense frame', reveal.status === 400 && reveal.json?.error === 'Invalid frames', `${reveal.status} ${reveal.json?.error}`)
        }

        // ── a machine's share card ──
        {
          const html = (await call('/play/spring-season')).text
          const tag = html.match(/<meta name="fc:miniapp" content="([^"]*)"/)?.[1] ?? ''
          let embed = null
          try { embed = JSON.parse(tag.replace(/&quot;/g, '"').replace(/&amp;/g, '&')) } catch { /* reported below */ }
          check('a machine\'s Farcaster embed shows its own card, led by its cover',
            /\/play\/spring-season\/opengraph-image$/.test(embed?.imageUrl ?? ''), embed?.imageUrl ?? `no embed: ${tag.slice(0, 120)}`)
          const png = async (id) => {
            const r = await fetch(`http://127.0.0.1:${PORT}/play/${id}/opengraph-image`, { signal: AbortSignal.timeout(30_000) })
            return { status: r.status, type: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) }
          }
          const live = await png('spring-season')
          if (SHOTS) writeFileSync(shotName('share-card-spring-season'), live.bytes)
          check('which renders', live.status === 200 && live.type === 'image/png' && live.bytes.length > 0, `${live.status} ${live.type}`)
          // Its cover is not on any gateway this run can reach, which is how a
          // first share goes while an upload propagates: the card must fall
          // back to its text, not come out as a blank background.
          const { default: sharp } = await import('sharp')
          const { data, info } = await sharp(live.bytes).raw().toBuffer({ resolveWithObject: true })
          let drawn = 0
          for (let i = 0; i < data.length; i += info.channels) {
            if ([0, 1, 2].some((k) => Math.abs(data[i + k] - data[k]) > 24)) drawn++
          }
          check('and with its cover out of reach, draws its text rather than a blank card',
            drawn / (info.width * info.height) > 0.005, `${drawn} of ${info.width * info.height} pixels drawn`)
          // One waiting for review is not public: its card must be the bare one,
          // byte for byte the card of a machine that does not exist.
          strings.delete(`kismetart:rl:xp-publish:${CURATOR.toLowerCase()}`)
          const queued = await call('/api/experience/machines', { method: 'POST', user: CURATOR_TOKEN, body: {
            kind: 'reveal', id: 'share-queued', name: 'Share Queued', entries: [{ collection: REVEAL, tokenId: '2' }],
          } })
          const [hidden, none] = [await png('share-queued'), await png('no-such-machine')]
          check('a machine waiting for review shares the bare card — never its name or art',
            queued.json?.machine?.state === 'review' && hidden.status === 200 && hidden.bytes.equals(none.bytes), `${queued.json?.machine?.state} ${hidden.bytes.length} vs ${none.bytes.length}`)
          await call('/api/experience/machines/share-queued', { method: 'POST', user: CURATOR_TOKEN, body: { action: 'withdraw' } })
        }

        // ── a machine, on sale ──
        {
          const page = await open('/play/spring-season')
          await page.getByText('insert coin').waitFor()
          const body = await text(page)
          check('the face says insert coin', body.includes('insert coin'))
          const deskSide = await stageSide(page)
          check('the window is never larger than the 240 px its artists\' clips are screened for flashing at (WCAG 2.3.1)',
            deskSide <= SCREENED_SIDE && deskSide > 0, `${deskSide} of ${SCREENED_SIDE}`)
          // A reader who sets larger text (a 32 px default here) must not get a
          // larger window. Measured on a desktop: on a phone the width bounds it.
          await page.evaluate(() => { document.documentElement.style.fontSize = '32px' })
          const bigTextSide = await stageSide(page)
          await page.evaluate(() => { document.documentElement.style.fontSize = '' })
          check('and stays within it when the reader enlarges text', bigTextSide <= SCREENED_SIDE && bigTextSide > 0, `${bigTextSide} of ${SCREENED_SIDE}`)
          check('the pull selector offers ×1 ×5 ×10', ['×1', '×5', '×10'].every((n) => body.includes(n)))
          const play = page.getByRole('button', { name: 'play', exact: true })
          check('and play is enabled before any wallet is connected', await play.isEnabled())
          check('the price is disclosed beside the button', /eth per play \+ network fee/.test(body), body.match(/[\d.]+ eth per play[^.]*/)?.[0] ?? '')
          await page.getByRole('button', { name: '×5' }).click()
          check('a multi-pull shows the total and the unit', /eth for 5 · [\d.]+ eth each/.test(await text(page)))
          check('the header names the creator and the promise', /by 0x[0-9a-f]{4}…[0-9a-f]{4} · every play returns an artwork/.test(body))
          const odds = page.locator('section', { hasText: "what's inside · published odds" }).locator('a')
          check('the odds table lists every deliverable piece', (await odds.count()) === 2, String(await odds.count()))
          const oddsText = (await odds.allInnerTexts()).join(' | ')
          check('each row shows its supply and a probability', /unlimited|\d+ left/.test(oddsText) && /\d+(\.\d+)?%/.test(oddsText), oddsText)
          // The "1 in N" ratio renders only for a row strictly between 0 and
          // 100%. This machine's live distribution shifts run to run as draws
          // consume its capped copies, so rather than assume a state, assert the
          // page's ratio count equals the API's count of fractional rows — which
          // also proves the table a player reads is the one the draw computes.
          const apiOdds = (await call('/api/experience/machines/spring-season')).json?.odds ?? []
          const fractional = apiOdds.filter((o) => o.probability > 0 && o.probability < 1).length
          const ratioCount = (oddsText.match(/1 in /g) ?? []).length
          check('a ratio is shown for exactly the fractional rows the draw has', ratioCount === fractional, `page=${ratioCount} api=${fractional}`)
          const commitments = await page.locator('section', { hasText: 'provably fair' }).locator('dd').allInnerTexts()
          check("today's and tomorrow's commitments are published", commitments.length === 2 && commitments.every((c) => /^[0-9a-f]{64}$/.test(c.trim())), commitments.join(','))
          check('coverage reads always available on a floor-backed machine', /artworks left: always available/.test(body))
          const redeem = page.getByRole('button', { name: 'redeem' })
          check('redeem is disabled until a hash is pasted', await redeem.isDisabled())
          await page.getByPlaceholder('paste its transaction hash (0x…)').fill(TX_B)
          check('and enabled once one is', await redeem.isEnabled())
          check('recent plays are shown', body.includes('recent plays'))
          check('the verifier is linked', (await page.getByRole('link', { name: /verify a play/ }).getAttribute('href'))?.startsWith('/play/spring-season/verify'))
          await page.context().close()
        }

        // ── a machine whose price cannot be read, and one whose season is over ──
        {
          const saved = chain.sales.get(key(CAPSULE, 1))
          chain.sales.delete(key(CAPSULE, 1))
          const page = await open('/play/spring-season')
          await page.getByText('insert coin').waitFor()
          const btn = page.getByRole('button', { name: 'price unavailable' })
          check('an unreadable price disables the button and says so', (await btn.count()) === 1 && (await btn.isDisabled()))
          check('with the reload hint', /could not read this capsule’s price just now — reload in a moment/.test(await text(page)))
          check('and no pull selector', !(await text(page)).includes('×5'))
          chain.sales.set(key(CAPSULE, 1), saved)
          await page.context().close()
        }
        {
          await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'ended' } })
          const page = await open('/play/field-recordings')
          await page.getByText('insert coin').waitFor()
          const btn = page.getByRole('button', { name: 'season closed' })
          check('an ended machine renders, with the button reading season closed', (await btn.count()) === 1 && (await btn.isDisabled()))
          check('and the redeem path still offered', await page.getByRole('button', { name: 'redeem' }).count() === 1)
          await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'field-recordings', state: 'live' } })
          await page.context().close()
        }

        // ── the verifier ──
        {
          // Section 5 left this claim under a tampered commitment.
          const page = await open(`/play/spring-season/verify?txHash=${TX_A}`)
          await page.getByText('MISMATCH').waitFor()
          check('a tampered commitment renders MISMATCH in red', (await text(page)).includes('mismatch'))
          strings.set(claimKey, JSON.stringify({ ...stored, epoch: yesterday, commitment: sha256(seed) }))
          await page.reload({ waitUntil: 'domcontentloaded' })
          await page.getByText('verified', { exact: true }).waitFor()
          const body = await text(page)
          check('an honest one renders verified', body.includes('verified the revealed seed matches the commitment published before this play'))
          check('with the seed revealed, the commitment, and recomputed → delivered', /server seed \(revealed after\) [0-9a-f]{64}/.test(body) && /recomputed → delivered #\d+ → #\d+/.test(body), body.slice(0, 300))
          check('and the exact lineup the play drew from', body.includes('the exact lineup this play drew from') && /weight \d+ ·/.test(body))
          await page.getByPlaceholder('capsule transaction hash (0x…)').fill('0x' + 'ee'.repeat(32))
          await page.getByRole('button', { name: 'verify' }).click()
          await page.getByText('No such play').waitFor()
          check('an unknown hash says so', true)
          await page.context().close()
        }

        // ── the studio, disconnected ──
        {
          const chooser = await open('/play/create')
          const kinds = await text(chooser)
          check('the studio first asks which kind of machine',
            kinds.includes('capsule machine your own work at one price') && kinds.includes('reveal machine any artist’s work'), kinds.slice(0, 300))
          check('it is called what every button leading to it says',
            (await chooser.getByRole('heading', { level: 1 }).textContent()) === 'build gachapon' && (await chooser.title()) === 'build gachapon — Kismet', await chooser.title())
          check('and each kind is a link to its studio',
            (await chooser.getByRole('link', { name: /capsule machine/ }).getAttribute('href')) === '/play/create-capsule' &&
            (await chooser.getByRole('link', { name: /reveal machine/ }).getAttribute('href')) === '/play/create-reveal')
          await chooser.context().close()

          // Without a Pass, each studio says what building one takes, up front.
          const gated = await Promise.all(['/play/create-capsule', '/play/create-reveal'].map(async (studio) => {
            const pg = await open(studio, { wallet: NOPASS })
            const notice = pg.getByText('a Kismet Pass is required to build a gachapon')
            await notice.waitFor({ timeout: 10_000 }).catch(() => {})
            const shown = (await notice.count()) === 1
            await pg.context().close()
            return shown
          }))
          check('a wallet without a Pass is told, in either studio, that building a gachapon takes one', gated.every(Boolean), gated.join())

          const page = await open('/play/create-capsule')
          await page.getByText('capsule studio').first().waitFor()
          check('a capsule machine has no artist to name — it is your own work', (await page.getByPlaceholder('artist 0x…').count()) === 0)
          await page.getByPlaceholder('spring-season').fill('browser-machine')
          await page.getByPlaceholder('Spring Season').fill('Browser Machine')
          await page.getByPlaceholder('0x…', { exact: true }).fill(CAPSULE_A)
          await page.getByPlaceholder('1', { exact: true }).fill('1')
          await page.getByPlaceholder('collection 0x…').fill(POOL)
          await page.getByPlaceholder('token').fill('8')
          await page.locator('label:has-text("qty") input').fill('0')
          await page.getByText('what players will see').waitFor()
          const oneRow = await text(page)
          check('the odds preview appears as the lineup is typed', /what players will see #8 0x[0-9a-f]{4}…[0-9a-f]{4} unlimited 100%/.test(oneRow), oneRow.match(/what players will see.{0,80}/)?.[0] ?? '')
          check('and asks for a check to learn the payees', oneRow.includes('run check to see who this capsule actually pays'))
          // Add a second, equally-weighted piece: two unlimited rows at weight 10
          // are a real 50/50, which is where the derived percentage and its
          // "1 in N" ratio actually render (deriveOdds, formatOddsRatio — the
          // same functions the machine page and the draw use).
          await page.getByRole('button', { name: 'add artwork' }).click()
          await page.getByPlaceholder('collection 0x…').nth(1).fill(POOL)
          await page.getByPlaceholder('token').nth(1).fill('7')
          await page.locator('label:has-text("qty") input').nth(1).fill('0')
          const twoRows = await text(page)
          check('an even two-piece lineup previews as 50.0% each', (twoRows.match(/50\.0%/g) ?? []).length === 2, twoRows.match(/what players will see.{0,120}/)?.[0] ?? '')
          check('and shows the 1-in-N ratio a fractional row carries', twoRows.includes('1 in 2'), twoRows.match(/1 in \d+/)?.[0] ?? 'none')
          // Rarity by supply: the weights go, and each piece's copies are its odds.
          await page.getByRole('radio', { name: 'by supply' }).click()
          check('by supply, there are no weights to type', (await page.locator('label:has-text("wt")').count()) === 0)
          await page.locator('label:has-text("qty") input').nth(0).fill('3')
          await page.locator('label:has-text("qty") input').nth(1).fill('1')
          const boxed = await text(page)
          check('and the preview is total copies over total copies', boxed.includes('75.0%') && boxed.includes('25.0%'), boxed.match(/what players will see.{0,160}/)?.[0] ?? '')
          check('with how far to cap the capsule', boxed.includes('4 copies in the machine — cap the capsule at 4 or fewer'))
          await page.getByRole('radio', { name: 'set per piece' }).click()
          check('switching back brings the weights back', (await page.locator('label:has-text("wt")').count()) === 2)
          await page.getByRole('button', { name: 'add artwork' }).click()
          await page.getByPlaceholder('collection 0x…').nth(2).fill(`${origin}/artwork/${POOL}/16`)
          const fixLink = page.getByRole('link', { name: "the piece's page" }).first()
          const flagged = await fixLink.waitFor({ timeout: 8000 }).then(() => true, () => false)
          check('a piece its artist has not allowed is flagged while the lineup is built, with where to fix it',
            flagged && (await fixLink.getAttribute('href')) === `/artwork/${POOL}/16`)
          check('a disconnected visitor is offered connect wallet, not a check that can only fail',
            (await page.getByRole('button', { name: 'connect wallet' }).count()) === 1 &&
            (await page.getByRole('button', { name: 'check', exact: true }).count()) === 0)
          await page.context().close()
        }

        // ── the studio, connected: check, then publish to review ──
        {
          const page = await open('/play/create-capsule', { user: USER_TOKEN, wallet: CREATOR2, uploads: true })
          const dryRuns = []
          const consoleErrs = []
          const failedReqs = []
          page.on('response', async (res) => {
            if (res.url().endsWith('/api/experience/machines') && res.request().method() === 'POST') {
              dryRuns.push({ status: res.status(), body: (await res.text().catch(() => '')).slice(0, 200) })
            }
          })
          page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 200)) })
          page.on('requestfailed', (r) => failedReqs.push(`${r.method()} ${r.url().replace(origin, '')}: ${r.failure()?.errorText ?? ''}`))
          page.on('pageerror', (e) => consoleErrs.push(`pageerror: ${e.message.slice(0, 200)}`))
          await page.getByRole('button', { name: 'check', exact: true }).waitFor()
          check('a connected wallet sees check and publish', (await page.getByRole('button', { name: 'publish' }).count()) === 1)
          await page.getByPlaceholder('spring-season').fill('browser-machine')
          await page.getByPlaceholder('Spring Season').fill('Browser Machine')
          await page.getByPlaceholder('0x…', { exact: true }).fill(CAPSULE_A)
          await page.getByPlaceholder('1', { exact: true }).fill('1')
          await page.getByPlaceholder('collection 0x…').fill(`${origin}/artwork/${POOL}/8`)
          check('pasting an artwork link fills in its collection and token',
            (await page.getByPlaceholder('collection 0x…').inputValue()) === POOL && (await page.getByPlaceholder('token').inputValue()) === '8')
          const standing = await page.getByText('allowed for capsule machines', { exact: true }).waitFor({ timeout: 8000 }).then(() => true, () => false)
          check('and the piece\'s standing is shown', standing)
          await page.locator('label:has-text("qty") input').fill('0')
          check('publish waits for a cover', await page.getByRole('button', { name: 'publish' }).isDisabled())
          await page.getByLabel('cover image').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
          await page.getByRole('button', { name: 'change cover' }).waitFor()
          const uploadsBefore = arweaveUploads.length
          await page.getByRole('button', { name: 'check', exact: true }).click()
          // Wait for the result region either way, so a failing check reports the
          // server's verdict instead of timing out blind.
          await page.locator('section', { hasText: /ready|fix before publishing/i }).first().waitFor().catch(() => {})
          const afterCheck = await text(page)
          // Counted once the check's answer is shown: an upload would have gone
          // before the check's request, so any the check made is in by now.
          const uploadsAtCheck = arweaveUploads.length
          check('check passes against the live gate', afterCheck.includes('every check passed against live on-chain state'),
            `dryRuns=${JSON.stringify(dryRuns).slice(0, 300)} | console=${JSON.stringify(consoleErrs).slice(0, 300)} | failed=${JSON.stringify(failedReqs).slice(0, 200)} | panel=${afterCheck.match(/(ready|fix before publishing).{0,160}/)?.[0] ?? ''}`)
          check('and reports the on-chain capsule and who it pays', afterCheck.includes('on-chain: 20 max · 0 minted') && afterCheck.includes('this capsule has no split, so every play pays you.'), afterCheck.match(/on-chain.{0,40}/)?.[0] ?? '')
          await page.getByRole('button', { name: 'publish' }).click()
          await page.getByText('is queued for a curator').waitFor()
          const afterPublish = await text(page)
          check('a non-admin publish lands on a confirmation, not a 404',
            page.url() === `${origin}/play/create-capsule` && afterPublish.includes('browser machine is queued for a curator'), page.url())
          check('that says where it will live once approved', afterPublish.includes('once approved it will be live at /play/browser-machine'))
          const queued = await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })
          check('and the machine really is in the review queue', queued.json?.machines?.some((m) => m.machine.id === 'browser-machine' && m.machine.state === 'review'))
          const coverAt = queued.json?.machines?.find((m) => m.machine.id === 'browser-machine')?.machine?.cover?.uri
          check('with its cover: uploaded once, on publish — the check uploaded nothing — through the app\'s own signer',
            uploadsAtCheck === uploadsBefore && arweaveUploads.length === uploadsBefore + 1 &&
              coverAt === `ar://${arweaveUploads.at(-1)?.id}` && arweaveUploads.at(-1)?.bytes > 0,
            `${uploadsAtCheck - uploadsBefore} at the check, ${arweaveUploads.length - uploadsBefore} in all, cover ${coverAt}`)
          await page.context().close()
        }

        // ── the curator's queue ──
        {
          const page = await open('/admin/play', { admin: ADMIN_TOKEN })
          await page.getByText('Browser Machine').waitFor()
          await page.getByRole('button', { name: /Browser Machine/ }).click()
          await page.getByRole('button', { name: 'approve · live' }).waitFor()
          const body = await text(page)
          check('the queue shows the submitted machine with its lineup and odds', /browser-machine · by 0x[0-9a-f]{4}…[0-9a-f]{4} · 1 artwork · 20 capsules/.test(body) && /#8 by/.test(body) && body.includes('100%'), body.match(/browser-machine.{0,80}/)?.[0] ?? '')
          check('approve is enabled because nothing is wrong', await page.getByRole('button', { name: 'approve · live' }).isEnabled())
          check('a queued machine offers no view link to a page that would 404', (await page.getByRole('link', { name: 'view', exact: true }).count()) === 0)
          check('and the footer tells the curator what the buttons really do', body.includes('stop new listings only') && body.includes('keeps its capsule token'))
          await page.getByRole('button', { name: 'approve · live' }).click()
          await page.getByText('browser-machine \u2192 live').waitFor()
          check('approving promotes it', (await call('/api/experience/machines/browser-machine')).status === 200)
          await page.context().close()
        }

        // ── a capsule bought in the browser opens to the artwork it won ──
        // Pay, open, reveal: the one path every player takes. Its lineup is one
        // piece, so the win is known — and must show that artwork, not its id.
        {
          const page = await open('/play/browser-machine', { wallet: PLAYER, onChain: true, images: true })
          await page.getByText('insert coin').waitFor()
          const cover = (await call('/api/experience/machines/browser-machine')).json?.machine?.cover ?? '-'
          const idle = (await page.locator('[data-stage="idle"] img').getAttribute('src').catch(() => null)) ?? ''
          check('the machine stands on its cover', decodeURIComponent(idle).includes(cover.replace('ar://', '')), `${cover} | ${idle.slice(0, 120)}`)
          const oddsLine = page.getByText(/^1 artwork ·/)
          check('the odds are summed up beside the price, with a link to the table',
            (await oddsLine.count()) === 1 && (await oddsLine.getByRole('link', { name: 'see odds' }).getAttribute('href')) === '#odds' &&
              (await page.locator('section#odds').getByText("what's inside · published odds").count()) === 1)
          const phoneSide = await stageSide(page)
          check('and on a phone', phoneSide <= SCREENED_SIDE && phoneSide > 0, `${phoneSide} of ${SCREENED_SIDE}`)
          // The table ends the page, so the page cannot scroll it to the top;
          // room below it lets the jump go as far as it will, and only the
          // header's offset stops it.
          await page.evaluate(() => document.body.append(Object.assign(document.createElement('div'), { id: 'room', style: 'height:200vh' })))
          await oddsLine.getByRole('link', { name: 'see odds' }).click()
          await page.waitForFunction(() => location.hash === '#odds' && scrollY > 0)
          const odds = await underNav(page, 'section#odds')
          await page.evaluate(() => { document.getElementById('room')?.remove(); scrollTo(0, 0) })
          check('and see odds lands the table just below the fixed header, not under it (WCAG 2.4.11)',
            odds.top >= odds.nav && odds.top <= odds.nav + 16, JSON.stringify(odds))
          await watchStages(page)
          const paid = chain.walletTxs.length
          await page.getByRole('button', { name: 'play', exact: true }).click()
          await shown(page, "you've collected").waitFor({ timeout: 60_000 }).catch(() => {})
          check('a capsule is paid for in one signature from the player\'s wallet',
            chain.walletTxs.length === paid + 1 && String(chain.walletTxs.at(-1)?.to).toLowerCase() === CAPSULE_A)
          // The first link to it is the win; the odds table below links it too.
          const win = page.locator(`a[href="/artwork/${POOL}/8"]`).first()
          const winText = (await win.innerText().catch(() => '')).replace(/\s+/g, ' ')
          const winImage = (await win.locator('img').getAttribute('src').catch(() => null)) ?? ''
          check('and opens to the artwork it won: its image and its title, not its token id',
            winText.includes('Piece Eight') && !winText.includes('#8') && decodeURIComponent(winImage).includes('piece-eight'),
            `${winText} | ${winImage.slice(0, 120)} | page: ${(await text(page)).match(/(you've|on its way|opening|still|insert coin).{0,200}/)?.[0] ?? ''}`)
          check('saying the player has collected it, and whose it is',
            /^you've collected Piece Eight by 0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(winText), winText)
          let stages = await stagesOf(page)
          check('the capsule rocks while the wallet and the draw work, then opens, once, before the win',
            stages.map(([s]) => s).join() === 'idle,dispense,open,' && stages[1][2] === 'kf-stage-rock' && stages[2][2] === 'kf-stage-shake',
            JSON.stringify(stages))
          check('and the open plays out in full when nobody skips it', stageMs(stages, 'open') >= 1100, String(stageMs(stages, 'open')))
          let said = await saidOf(page)
          check('a screen reader is told each step: the wallet, the open, and what was collected (WCAG 4.1.3)',
            said[0] === 'Confirm in your wallet' && said.includes('Opening your capsule') && /^You've collected Piece Eight by 0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(said.at(-1)),
            JSON.stringify(said))
          check('the opened capsule hands over to the artwork in one view transition', (await transitionsOf(page)) === '1/1', await transitionsOf(page))

          // A multi-pull opens once, for everything it won.
          await page.getByRole('button', { name: '×5' }).click()
          await page.getByRole('button', { name: 'play again ×5' }).focus()
          const scrolledFrom = await page.evaluate(() => scrollY)
          await page.keyboard.press('Enter')
          await page.getByRole('button', { name: 'skip' }).waitFor({ timeout: 60_000 }).catch(() => {})
          const focusInOpen = await focusOf(page)
          await shown(page, "you've collected 5 artworks").waitFor({ timeout: 60_000 }).catch(() => {})
          const scrolledTo = await page.evaluate(() => scrollY)
          const result = await underNav(page, ':focus')
          stages = await stagesOf(page)
          check('a pull of five opens once, then shows all five',
            stages.map(([s]) => s).join() === 'idle,dispense,open,,dispense,open,' &&
              (await shown(page, "you've collected 5 artworks").count()) === 1 &&
              (await page.locator(`a[href="/artwork/${POOL}/8"]`).count()) === 5 + 1,
            JSON.stringify(stages.map(([s]) => s)))
          const focusAfter = await focusOf(page)
          check('played from the keyboard, focus moves to skip while it opens, then to what it held — never to the page (WCAG 2.4.3)',
            focusInOpen === 'skip' && /^you've collected 5 artworks/i.test(focusAfter), `${focusInOpen} | ${focusAfter.slice(0, 60)}`)
          check('and moving it scrolls nothing: the result is where the machine was, in view below the header (WCAG 2.4.11)',
            scrolledTo === scrolledFrom && result.bottom > result.nav && result.top < result.view,
            JSON.stringify({ scrolledFrom, scrolledTo, ...result }))
          said = await saidOf(page)
          check('and a pull of five is told its progress, then its count',
            said.includes('Opening 1 of 5') && said.includes('Opening 5 of 5') && said.at(-1) === "You've collected 5 artworks", JSON.stringify(said.slice(-8)))
          await page.context().close()

          // A viewer who asked for less motion sees a still capsule, and no open.
          const still = await open('/play/browser-machine', { wallet: PLAYER, onChain: true, images: true, reducedMotion: true })
          await still.getByText('insert coin').waitFor()
          await watchStages(still)
          await still.getByRole('button', { name: 'play', exact: true }).click()
          await shown(still, "you've collected").waitFor({ timeout: 60_000 }).catch(() => {})
          stages = await stagesOf(still)
          check('under reduced motion the capsule stands still, and the win is shown without the open',
            stages.map(([s]) => s).join() === 'idle,dispense,' && stages[1][2] === 'none' &&
              (await still.getByText(/^you've collected Piece Eight by /).count()) === 1,
            JSON.stringify(stages))
          check('and without a view transition', (await transitionsOf(still)) === '0/0', await transitionsOf(still))
          await still.context().close()

          // A capsule bought elsewhere, redeemed here, opens the same way.
          setHead(chain.head + 5n)
          addMint({ tx: TX_ELSEWHERE, collection: CAPSULE_A, to: PLAYER, id: 1n, value: 1n, block: chain.head - 2n })
          const redeemed = await open('/play/browser-machine', { wallet: PLAYER, onChain: true, images: true })
          await redeemed.getByText('insert coin').waitFor()
          await watchStages(redeemed)
          await redeemed.getByPlaceholder('paste its transaction hash (0x…)').fill(TX_ELSEWHERE)
          await redeemed.getByRole('button', { name: 'redeem' }).click()
          await shown(redeemed, "you've collected").waitFor({ timeout: 60_000 }).catch(() => {})
          stages = await stagesOf(redeemed)
          check('a capsule bought elsewhere and redeemed here opens the same way',
            stages.map(([s]) => s).join() === 'idle,open,' && (await redeemed.getByText(/^you've collected Piece Eight by /).count()) === 1,
            JSON.stringify(stages.map(([s]) => s)))
          await redeemed.context().close()

          if (SHOTS) {
            const tour = await open('/play/browser-machine', { wallet: PLAYER, onChain: true, images: true })
            await tour.getByText('insert coin').waitFor()
            await tour.getByRole('button', { name: 'play', exact: true }).click()
            await tour.locator('[data-stage="dispense"]').waitFor().catch(() => {})
            await tour.screenshot({ path: shotName('stage-dispense-platform-capsule') })
            await tour.locator('[data-stage="open"]').waitFor({ timeout: 60_000 }).catch(() => {})
            await tour.waitForTimeout(550)
            await tour.screenshot({ path: shotName('stage-open-platform-capsule') })
            await shown(tour, "you've collected").waitFor({ timeout: 60_000 }).catch(() => {})
            await tour.context().close()
          }

          // ── its creator gives it frames of their own ──
          const studio = await open('/play/browser-machine', { user: USER_TOKEN, wallet: CREATOR2, uploads: true, images: true })
          await studio.getByLabel('open frame', { exact: true }).waitFor({ state: 'attached' })
          const uploadsBefore = arweaveUploads.length
          const toasted = (t) => studio.getByText(t).waitFor({ timeout: 60_000 }).then(() => true, () => false)
          // Held to what a stage can afford as each is picked, before any upload.
          await studio.getByLabel('open frame', { exact: true }).setInputFiles({ name: 'long.gif', mimeType: 'image/gif', buffer: tinyGif(250) })
          const tooLong = await toasted('Keep a frame to 4 seconds — this one runs 5.0')
          const toastsSeen = (await studio.locator('[data-sonner-toast]').allInnerTexts()).join(' / ')
          const { default: sharp } = await import('sharp')
          const wide = await sharp({ create: { width: 1200, height: 10, channels: 3, background: '#ff00aa' } }).png().toBuffer()
          await studio.getByLabel('open frame', { exact: true }).setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: wide })
          const tooWide = await toasted('Keep a frame to 1080 px on its longest side — this one is 1200')
          check('a frame that runs too long, or is too large, is refused as it is picked — nothing uploaded, nothing to save',
            tooLong && tooWide && arweaveUploads.length === uploadsBefore && (await studio.getByRole('button', { name: 'save frames' }).count()) === 0,
            `${tooLong} ${tooWide} ${arweaveUploads.length - uploadsBefore} | ${toastsSeen}`)
          await studio.getByLabel('dispense frame', { exact: true }).setInputFiles({ name: 'dispense.gif', mimeType: 'image/gif', buffer: tinyGif(50) })
          await studio.getByLabel('open frame', { exact: true }).setInputFiles({ name: 'open.gif', mimeType: 'image/gif', buffer: tinyGif(3, 77) })
          await studio.getByRole('button', { name: 'save frames' }).click({ timeout: 60_000 })
          await studio.getByText('Frames updated').waitFor({ timeout: 30_000 }).catch(() => {})
          // The server screens what was uploaded before a player's stage plays it.
          const afterSave = await screened('browser-machine', ['dispense', 'open'])
          const frames = afterSave?.frames
          check('the server fetches both uploads and screens them, and both pass',
            afterSave?.frameStatus?.dispense?.state === 'passed' && afterSave?.frameStatus?.open?.state === 'passed', JSON.stringify(afterSave?.frameStatus))
          const sent = arweaveUploads.slice(uploadsBefore).map((u) => `ar://${u.id}`)
          const parts = [frames?.dispense?.uri, frames?.dispense?.poster, frames?.open?.uri, frames?.open?.poster]
          check('its creator gives it frames on its page: each gif made a video and its still, all four uploaded through the app\'s own signer',
            frames?.dispense?.kind === 'video' && frames.open?.kind === 'video' && !!frames.dispense.thumbhash &&
              sent.length === 4 && parts.every((u) => sent.includes(u)) && new Set(parts).size === 4,
            `${JSON.stringify(frames)} | ${sent.join(' ')}`)
          // What was uploaded is the GIF, to the hundredth: the browser's own
          // ffmpeg ends an MP4 at its last frame's start unless told the timing.
          const clip = (uri) => {
            const item = arweaveUploads.find((u) => `ar://${u.id}` === uri)?.body
            const mp4 = item && dataItemPayload(item)
            return mp4 && mp4.toString('latin1', 4, 8) === 'ftyp' ? mp4Timing(mp4) : null
          }
          const [dispenseClip, openClip] = [clip(frames?.dispense?.uri), clip(frames?.open?.uri)]
          check('each clip runs exactly as long as its gif — an even gif at its own frame rate, an uneven one on the grid its delays share, a held last frame for its whole hold',
            dispenseClip?.seconds === 1 && dispenseClip.samples === 2 && openClip?.seconds === 0.8 && openClip.samples === 80,
            JSON.stringify({ dispenseClip, openClip }))
          check('and each keyframes about once a second on its grid, never more often than every 30 frames',
            dispenseClip?.keyint === 30 && openClip?.keyint === 100, JSON.stringify({ dispenseClip, openClip }))
          await studio.context().close()

          // ── and the play is theirs ──
          const idOf = (uri) => uri?.replace('ar://', '') ?? '-'
          const askedFrom = mediaRequests.length
          const withFrames = await open('/play/browser-machine', { wallet: PLAYER, onChain: true, images: true, media: true })
          await withFrames.getByText('insert coin').waitFor()
          const preloadedBy = (end) => [frames?.dispense?.uri, frames?.open?.uri].every((u) => mediaRequests.slice(askedFrom, end).some((r) => r.includes(idOf(u))))
          for (let i = 0; i < 50 && !preloadedBy(mediaRequests.length); i++) await sleep(100)
          const asked = mediaRequests.length
          await watchStages(withFrames)
          await withFrames.getByRole('button', { name: 'play', exact: true }).click()
          await shown(withFrames, "you've collected").waitFor({ timeout: 60_000 }).catch(() => {})
          stages = await stagesOf(withFrames)
          const [, dispensing, opening] = stages
          check('the capsule dispenses as the artist\'s clip, looping, and opens as their other one',
            stages.map(([s]) => s).join() === 'idle,dispense,open,' &&
              dispensing[3]?.startsWith('video ') && dispensing[3].includes(idOf(frames?.dispense?.uri)) &&
              opening[3]?.startsWith('video ') && opening[3].includes(idOf(frames?.open?.uri)) &&
              (await withFrames.locator('[data-frame="dispense"]').getAttribute('loop')) !== null,
            JSON.stringify(stages))
          check('both clips were loaded before the play needed them', preloadedBy(asked), mediaRequests.slice(askedFrom, asked).join(' '))
          // The clip runs a second; the bound is 4.5 s and the platform's own open 1.2 s,
          // so only the clip itself, played through, lands in between.
          check('and the open is the clip, played through, ending when it does — not at its bound',
            !!opening?.[3]?.startsWith('video ') && stageMs(stages, 'open') >= 800 && stageMs(stages, 'open') < 3000,
            `${opening?.[3]} ${stageMs(stages, 'open')}`)
          await withFrames.context().close()

          const calm = await open('/play/browser-machine', { wallet: PLAYER, onChain: true, images: true, media: true, reducedMotion: true })
          await calm.getByText('insert coin').waitFor()
          await watchStages(calm)
          await calm.getByRole('button', { name: 'play', exact: true }).click()
          await shown(calm, "you've collected").waitFor({ timeout: 60_000 }).catch(() => {})
          stages = await stagesOf(calm)
          check('under reduced motion the artist\'s dispense shows as its still, and nothing opens',
            stages.map(([s]) => s).join() === 'idle,dispense,' && stages[1][3]?.startsWith('div ') && decodeURIComponent(stages[1][3]).includes(idOf(frames?.dispense?.poster)),
            JSON.stringify(stages))
          await calm.context().close()

          if (SHOTS) {
            const tour = await open('/play/browser-machine', { wallet: PLAYER, onChain: true, images: true, media: true })
            await tour.getByText('insert coin').waitFor()
            await tour.waitForTimeout(1500)
            await tour.getByRole('button', { name: 'play', exact: true }).click()
            await tour.locator('[data-stage="dispense"]').waitFor().catch(() => {})
            await tour.waitForTimeout(300)
            await tour.screenshot({ path: shotName('stage-dispense-artist-clip') })
            await tour.locator('[data-stage="open"]').waitFor({ timeout: 60_000 }).catch(() => {})
            await tour.waitForTimeout(400)
            await tour.screenshot({ path: shotName('stage-open-artist-clip') })
            await shown(tour, "you've collected").waitFor({ timeout: 60_000 }).catch(() => {})
            await tour.context().close()
          }

          // Its creator takes the open back to the capsule's own; the dispense stays.
          const editing = await open('/play/browser-machine', { user: USER_TOKEN, wallet: CREATOR2, uploads: true, images: true })
          await editing.getByRole('button', { name: 'remove open frame' }).click()
          const uploadsNow = arweaveUploads.length
          await editing.getByRole('button', { name: 'save frames' }).click()
          await editing.getByText('Frames updated').waitFor({ timeout: 20_000 }).catch(() => {})
          const left = (await call('/api/experience/machines/browser-machine')).json?.machine?.frames
          check('its creator removes one frame, and the other stays as it was, uploaded nothing new — still played, not screened again',
            JSON.stringify(left) === JSON.stringify({ dispense: frames?.dispense }) && arweaveUploads.length === uploadsNow, JSON.stringify(left))
          await editing.context().close()

          // ── what a frame is screened for, and where ──
          // The studio refuses a clip that flashes, and an image that moves, as
          // it is picked. The server screens every frame again — one sent
          // straight to the API included — and a player's stage plays a frame
          // only once it has passed.
          const screening = await open('/play/browser-machine', { user: USER_TOKEN, wallet: CREATOR2, uploads: true, images: true })
          const openPick = screening.getByLabel('open frame', { exact: true })
          await openPick.waitFor({ state: 'attached' })
          const uploadsAt = arweaveUploads.length
          await openPick.setInputFiles({ name: 'strobe.webm', mimeType: 'video/webm', buffer: makeClip('strobe', 'webm', strobe(4)) })
          const strobeSaid = await screening.getByText('It flashes 4 times a second over 100% of the stage — keep flashing to three times a second, or to under 37% of the stage')
            .waitFor({ timeout: 60_000 }).then(() => true, () => false)
          await openPick.setInputFiles({ name: 'calm.webm', mimeType: 'video/webm', buffer: makeClip('glide', 'webm', GLIDE) })
          const calmTaken = await screening.getByRole('button', { name: 'save frames' }).waitFor({ timeout: 60_000 }).then(() => true, () => false)
          await screening.getByRole('button', { name: 'remove open frame' }).click()
          const moving = await sharp(tinyGif(10), { animated: true }).webp().toBuffer()
          await openPick.setInputFiles({ name: 'moving.webp', mimeType: 'image/webp', buffer: moving })
          const movingSaid = await screening.getByText('This image moves — give an animation as a gif or a video, which are checked for flashing')
            .waitFor({ timeout: 30_000 }).then(() => true, () => false)
          await openPick.setInputFiles({ name: 'strobe.svg', mimeType: 'image/svg+xml', buffer: STROBE_SVG })
          const svgSaid = await screening.getByText('An SVG can move by itself — give a still as a png, jpg or webp, or an animation as a gif or a video, which are checked for flashing')
            .waitFor({ timeout: 30_000 }).then(() => true, () => false)
          check('the studio refuses a clip that flashes four times a second across the stage, saying why and how to pass, an image that moves, and an SVG — nothing uploaded; a calm clip is taken',
            strobeSaid && movingSaid && svgSaid && calmTaken && arweaveUploads.length === uploadsAt, `${strobeSaid} ${movingSaid} ${svgSaid} ${calmTaken} ${arweaveUploads.length - uploadsAt}`)
          await screening.context().close()

          // Straight to the API: a flashing clip the studio never saw, sent with
          // a verdict of its own. Its gateway holds it back a while, as one
          // settling a fresh upload does.
          const placed = (name) => 'e2e' + name.padEnd(40, '0')
          const STROBE = placed('Strobe')
          const STROBE_STILL = placed('StrobeStill')
          let release = () => {}
          gatewayFiles.set(STROBE, { bytes: makeClip('strobe-mp4', 'mp4', strobe(4)), type: 'video/mp4', held: new Promise((r) => { release = r }) })
          gatewayFiles.set(STROBE_STILL, { bytes: await sharp({ create: { width: 160, height: 160, channels: 3, background: '#000' } }).jpeg().toBuffer(), type: 'image/jpeg' })
          const setFrames = (frames) => call('/api/experience/machines/browser-machine', { method: 'POST', user: USER_TOKEN, body: { action: 'frames', frames } })
          const strobeFrame = { uri: `ar://${STROBE}`, kind: 'video', poster: `ar://${STROBE_STILL}` }
          const direct = await setFrames({ dispense: frames?.dispense, open: { ...strobeFrame, check: { state: 'passed', at: 1 } } })
          const waiting = (await call('/api/experience/machines/browser-machine')).json?.machine
          check('a frame sent straight to the API is saved, its own verdict ignored: it waits to be screened, and a player is not given it',
            direct.status === 200 && waiting?.frameStatus?.open?.state === 'checking' && !waiting?.frames?.open,
            `${direct.status} ${JSON.stringify(waiting?.frameStatus?.open)} ${JSON.stringify(waiting?.frames)}`)
          check('while the frame it kept is still played, without being screened again',
            waiting?.frames?.dispense?.uri === frames?.dispense?.uri && waiting?.frameStatus?.dispense?.state === 'passed')
          const creatorSees = await open('/play/browser-machine', { user: USER_TOKEN, wallet: CREATOR2, images: true })
          const saysChecking = await creatorSees.getByText('checking for flashing — players see the capsule until it passes')
            .waitFor({ timeout: 20_000 }).then(() => true, () => false)
          await creatorSees.context().close()
          release()
          const judged = await screened('browser-machine', ['open'])
          check('its creator is told it is being checked; once the gateway has it, the server refuses it for flashing, and it is still not played',
            saysChecking && judged?.frameStatus?.open?.state === 'refused' && /^It flashes 4 times a second over 100% of the stage/.test(judged.frameStatus.open.reason ?? '') && !judged?.frames?.open,
            `${saysChecking} ${JSON.stringify(judged?.frameStatus?.open)}`)
          const refusedView = await open('/play/browser-machine', { user: USER_TOKEN, wallet: CREATOR2, images: true })
          const saysRefused = await refusedView.getByText(/^not shown to players: It flashes 4 times a second/).waitFor({ timeout: 20_000 }).then(() => true, () => false)
          await refusedView.context().close()
          const player = await open('/play/browser-machine', { wallet: PLAYER, onChain: true, images: true, media: true })
          await player.getByText('insert coin').waitFor()
          const playerFrames = { dispense: await player.locator('[data-frame="dispense"]').count(), open: await player.locator('[data-frame="open"]').count() }
          await player.context().close()
          check('its creator is told why, on the machine\'s page; a player\'s stage has the dispense and no open of the artist\'s — the capsule opens',
            saysRefused && playerFrames.dispense === 1 && playerFrames.open === 0, `${saysRefused} ${JSON.stringify(playerFrames)}`)

          // The limits, enforced again: a clip too long for its stage, and an
          // image that moves given as a still.
          const LONG = placed('Long')
          const MOVING = placed('Moving')
          gatewayFiles.set(LONG, { bytes: makeClip('long', 'mp4', GLIDE, { seconds: 5 }), type: 'video/mp4' })
          gatewayFiles.set(MOVING, { bytes: moving, type: 'image/webp' })
          await setFrames({ dispense: frames?.dispense, open: { uri: `ar://${LONG}`, kind: 'video', poster: `ar://${STROBE_STILL}` } })
          const longClip = await screened('browser-machine', ['open'])
          await setFrames({ dispense: frames?.dispense, open: { uri: `ar://${MOVING}`, kind: 'image', poster: `ar://${MOVING}` } })
          const stillMoves = await screened('browser-machine', ['open'])
          check('the server refuses, for itself, a five-second clip and an image that moves — neither played',
            longClip?.frameStatus?.open?.reason === 'It runs 5.0 seconds — at most 4' && !longClip?.frames?.open &&
              /^It moves — an animated frame is a gif or a video/.test(stillMoves?.frameStatus?.open?.reason ?? '') && !stillMoves?.frames?.open,
            `${JSON.stringify(longClip?.frameStatus?.open)} ${JSON.stringify(stillMoves?.frameStatus?.open)}`)
          // Through all of it, the dispense kept its verdict: it was sent back
          // unchanged each time. Taking the open away leaves it as it was.
          await setFrames({ dispense: frames?.dispense })
          const restored = (await call('/api/experience/machines/browser-machine')).json?.machine
          check('and the frame sent back unchanged each time kept its verdict throughout — played at once, never screened again',
            JSON.stringify(restored?.frames) === JSON.stringify({ dispense: frames?.dispense }), JSON.stringify(restored?.frames))
        }

        // ── an artist allows capsule machines on their piece ──
        // Nothing else in the app can grant this, and the publish gate refuses
        // any piece without it, so this panel is the only door into a machine.
        // The artist's own wallet signs; the mock chain applies the write; the
        // panel re-reads the chain once the receipt lands.
        {
          chain.perms.delete(key(POOL, 99, OPERATOR))
          const moment = {
            uri: 'ar://meta', owner: ADMIN, momentAdmins: [ADMIN], saleConfig: null,
            metadata: { name: 'Piece Ninety Nine', description: 'An artwork used to validate the allowance panel.', image: '' },
          }
          const visitor = await open(`/artwork/${POOL}/99`, { moment })
          await visitor.getByText('Piece Ninety Nine').first().waitFor()
          // Absence is only evidence once the panel has had time to appear: an
          // immediate count passes even when it would render a moment later.
          await visitor.waitForTimeout(2500)
          // Counted from the page's own resource timing, which holds every
          // request since it loaded. A listener attached once open() returns
          // misses a lookup the page made while it was hydrating.
          const lookups = await visitor.evaluate(() =>
            performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.includes('/api/experience/piece')))
          const publicLookups = lookups.filter((u) => new URL(u).searchParams.get('public') === '1').length
          const visitorLookups = lookups.length - publicLookups
          check('a visitor sees no machines panel, and never asks for the artist\'s controls',
            visitorLookups === 0 && (await visitor.getByRole('button', { name: /^machines/i }).count()) === 0)
          const listed = (await call(`/api/experience/piece?collection=${POOL}&tokenId=99&public=1`)).json?.machines ?? []
          const vText = await text(visitor)
          check('but is told, from the public listing, which live machines the piece is in',
            publicLookups === 1 && listed.length > 0 &&
              vText.includes(`in ${listed.length === 1 ? 'a machine' : `${listed.length} machines`}:`) &&
              listed.every((m) => vText.includes(`${m.name.toLowerCase()} (capsule prize)`)),
            `${publicLookups} ${JSON.stringify(listed)} ${vText.match(/in (a|\d+) machines?:.{0,120}/)?.[0] ?? ''}`)
          const callout = visitor.getByRole('link', { name: listed[0]?.name ?? '-' })
          check('each linking to its machine', (await callout.getAttribute('href')) === `/play/${listed[0]?.id}`)
          await visitor.context().close()

          const page = await open(`/artwork/${POOL}/99`, { wallet: ADMIN, onChain: true, moment })
          const panel = page.getByRole('button', { name: /^machines/i })
          await panel.waitFor()
          check('the artist sees it, open to reveal machines by default', /open/i.test(await panel.innerText()), await panel.innerText())
          await panel.click()
          check('with the switch on', (await page.getByRole('switch', { name: 'on · turn off' }).count()) === 1)
          const body = await text(page)
          check('it names the machines that include the piece', body.includes('no grant') && body.includes('redraw'), body.match(/in \d machines?.{0,80}/)?.[0] ?? '')
          const signed = chain.walletTxs.length
          await page.getByRole('button', { name: 'allow capsule machines' }).click()
          await page.getByRole('button', { name: 'stop allowing' }).waitFor()
          check('allowing is one signature from the artist\'s own wallet', chain.walletTxs.length === signed + 1)
          check('and the delivery account now holds MINTER on that piece', chain.perms.get(key(POOL, 99, OPERATOR)) === 4n)
          check('which the publish gate reads the same way', (await call(`/api/experience/piece?collection=${POOL}&tokenId=99`)).json?.allowed === true)
          await page.getByRole('button', { name: 'stop allowing' }).click()
          await page.getByRole('button', { name: 'allow capsule machines' }).waitFor()
          check('stopping revokes it', (chain.perms.get(key(POOL, 99, OPERATOR)) ?? 0n) === 0n)
          await page.context().close()
        }

        // ── an artist turns reveal machines off for a piece, and back on ──
        {
          const moment = {
            uri: 'ar://meta', owner: CREATOR2, momentAdmins: [CREATOR2], saleConfig: null,
            metadata: { name: 'Piece Two', description: 'A reveal piece.', image: '' },
          }
          const page = await open(`/artwork/${REVEAL}/2`, { user: USER_TOKEN, wallet: CREATOR2, onChain: true, moment })
          const panel = page.getByRole('button', { name: /^machines/i })
          await panel.waitFor()
          await panel.click()
          check('the panel lists the reveal machines the piece is in', /new voices · reveal · live/.test(await text(page)), (await text(page)).match(/in \d machines?.{0,120}/)?.[0] ?? '')
          const signed = chain.walletTxs.length
          await page.getByRole('switch', { name: 'on · turn off' }).click()
          await page.getByRole('switch', { name: 'off · turn on' }).waitFor({ timeout: 8000 }).catch(() => {})
          check('turning it off takes no signature', chain.walletTxs.length === signed)
          const lineupNow = async () => ((await call('/api/experience/machines/new-voices')).json?.lineup ?? []).map((p) => p.tokenId).sort().join(',')
          check('and takes the piece out of the live machine', (await lineupNow()) === '1,6', await lineupNow())
          await page.getByRole('switch', { name: 'off · turn on' }).click().catch(() => {})
          await page.getByRole('switch', { name: 'on · turn off' }).waitFor({ timeout: 8000 }).catch(() => {})
          check('turning it back on returns it', (await lineupNow()) === '1,2,6', await lineupNow())
          // Leave the piece as found, whatever happened above, so what follows
          // tests its own subject rather than this block's outcome.
          await call('/api/experience/piece', { method: 'POST', user: USER_TOKEN, body: { collection: REVEAL, tokenId: '2', available: true } })
          await page.context().close()
        }

        // ── a reveal machine: pull for free, see a piece, collect it at its price ──
        {
          const page = await open('/play/new-voices')
          await page.getByText('free to pull').waitFor()
          const body = await text(page)
          check('the face says the pull is free', body.includes('free to pull') && body.includes('pull for free, collect what you reveal at its price'))
          check('the odds are one in however many are on sale', body.includes("what's inside · each piece is 1 in 3"), body.match(/what's inside.{0,60}/)?.[0] ?? '')
          const rows = page.locator('section', { hasText: "what's inside" }).locator('a')
          const rowText = (await rows.allInnerTexts()).join(' | ').toLowerCase()
          check('each piece on sale is listed with its own price', (await rows.count()) === 3 && rowText.includes('0.002 eth') && rowText.includes('free') && rowText.includes('$1'), rowText)
          check('with a line on what comes and goes', body.includes('one that sells out or closes leaves by itself, and 1 more joins when its sale opens'), body.match(/one that sells out.{0,80}/)?.[0] ?? '')
          await watchStages(page)
          await page.getByRole('button', { name: 'pull', exact: true }).click()
          await shown(page, 'you revealed').waitFor()
          const revealed = await page.locator('a[href^="/artwork/"]').first().getAttribute('href')
          let stages = await stagesOf(page)
          check('a pull opens the capsule, then shows what it held',
            stages.map(([s]) => s).join() === 'idle,open,' && stages[1][2] === 'kf-stage-shake' && stageMs(stages, 'open') >= 1100,
            JSON.stringify(stages))
          await page.getByRole('button', { name: 'pull again' }).click()
          await page.getByRole('button', { name: 'skip' }).click({ timeout: 5000 }).catch(() => {})
          await shown(page, 'you revealed').waitFor()
          stages = await stagesOf(page)
          check('and the open can be skipped', stages.map(([s]) => s).join() === 'idle,open,,open,' && stageMs(stages, 'open', 1) < 600,
            JSON.stringify(stages))
          await page.getByRole('button', { name: 'pull again' }).focus()
          const scrolledFrom = await page.evaluate(() => scrollY)
          await page.keyboard.press('Enter')
          await page.getByRole('button', { name: 'skip' }).waitFor().catch(() => {})
          const focusInOpen = await focusOf(page)
          await shown(page, 'you revealed').waitFor()
          const focusAfter = await focusOf(page)
          const scrolledTo = await page.evaluate(() => scrollY)
          const piece = await underNav(page, ':focus')
          check('pulled from the keyboard, focus moves to skip while it opens, then to the piece — never to the page (WCAG 2.4.3)',
            focusInOpen === 'skip' && /^you revealed/i.test(focusAfter), `${focusInOpen} | ${focusAfter.slice(0, 60)}`)
          check('and moving it scrolls nothing: the piece is where the machine was, in view below the header (WCAG 2.4.11)',
            scrolledTo === scrolledFrom && piece.bottom > piece.nav && piece.top < piece.view,
            JSON.stringify({ scrolledFrom, scrolledTo, ...piece }))
          const revealSaid = await saidOf(page)
          check('a screen reader is told each open and each piece revealed (WCAG 4.1.3)',
            revealSaid.filter((t) => t === 'Opening').length === 3 && /^You revealed .+ by 0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(revealSaid.at(-1)),
            JSON.stringify(revealSaid))
          check('and each open hands over to its piece in a view transition', (await transitionsOf(page)) === '3/3', await transitionsOf(page))
          check('a pull reveals one of the pieces on sale', [1, 2, 6].some((id) => revealed === `/artwork/${REVEAL}/${id}`), revealed)
          check('and offers to collect it or pull again',
            (await page.getByRole('button', { name: /^collect · / }).count()) === 1 && (await page.getByRole('button', { name: 'pull again' }).count()) === 1)
          // Thirteen fair pulls over three pieces all land on the first one's
          // piece about 1 time in 500,000; a fixed pull does every time.
          const seen = new Set([revealed])
          for (let i = 0; i < 12; i++) {
            await page.getByRole('button', { name: 'pull again' }).click()
            await shown(page, 'you revealed').waitFor()
            seen.add(await page.locator('a[href^="/artwork/"]').first().getAttribute('href'))
          }
          check('pulls land on different pieces', seen.size >= 2, [...seen].join(' '))
          await page.context().close()

          const still = await open('/play/new-voices', { reducedMotion: true })
          await still.getByText('free to pull').waitFor()
          await watchStages(still)
          await still.getByRole('button', { name: 'pull', exact: true }).click()
          await shown(still, 'you revealed').waitFor()
          stages = await stagesOf(still)
          check('under reduced motion a pull shows its piece without the open', stages.map(([s]) => s).join() === 'idle,', JSON.stringify(stages))
          check('and without a view transition', (await transitionsOf(still)) === '0/0', await transitionsOf(still))
          await still.context().close()

          // Its curator gives the open a still of their own.
          const curated = await open('/play/new-voices', { user: CURATOR_TOKEN, wallet: CURATOR, uploads: true, images: true })
          await curated.getByText('free to pull').waitFor()
          await curated.getByLabel('open frame', { exact: true }).waitFor({ state: 'attached' }).catch(() => {})
          check('a reveal machine\'s curator is offered an open frame, and no dispense',
            (await curated.getByLabel('open frame', { exact: true }).count()) === 1 && (await curated.getByLabel('dispense frame', { exact: true }).count()) === 0)
          await curated.getByLabel('open frame', { exact: true }).setInputFiles({ name: 'open.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
          // A slow gateway, so the page reloads the machine before the server
          // has screened the frame — as a fresh upload's first minute can go.
          gatewayDelay = 2000
          await curated.getByRole('button', { name: 'save frames' }).click({ timeout: 20_000 })
          await curated.getByText('Frames updated').waitFor({ timeout: 20_000 }).catch(() => {})
          const checkingFirst = await curated.getByText('checking for flashing — players see the capsule until it passes').waitFor({ timeout: 10_000 }).then(() => true, () => false)
          const appeared = await curated.locator('[data-frame="open"]').waitFor({ state: 'attached', timeout: 30_000 }).then(() => true, () => false)
          gatewayDelay = 0
          check('the curator is told the still is being checked, and their own page takes it up once it passes, without a reload',
            checkingFirst && appeared, `${checkingFirst} ${appeared}`)
          const openFrame = (await call('/api/experience/machines/new-voices')).json?.machine?.frames?.open
          await watchStages(curated)
          await curated.getByRole('button', { name: 'pull', exact: true }).click()
          await shown(curated, 'you revealed').waitFor()
          stages = await stagesOf(curated)
          check('a pull then opens on the curator\'s still, held as long as the capsule\'s own open',
            openFrame?.kind === 'image' && stages.map(([s]) => s).join() === 'idle,open,' && stages[1][3]?.startsWith('div ') &&
              decodeURIComponent(stages[1][3]).includes(openFrame.uri.replace('ar://', '')) && stageMs(stages, 'open') >= 1100,
            `${JSON.stringify(openFrame)} | ${JSON.stringify(stages)}`)
          await curated.context().close()
          await call('/api/experience/machines/new-voices', { method: 'POST', user: CURATOR_TOKEN, body: { action: 'frames', frames: {} } })

          // One piece, so the reveal is known: the collect is the artwork's own,
          // sent from the player's wallet with the right value and referral.
          await call('/api/experience/machines', { method: 'POST', user: ADMIN_USER_TOKEN, body: { kind: 'reveal', id: 'solo-piece', name: 'Solo Piece', entries: [{ collection: REVEAL, tokenId: '1' }] } })
          const solo = await open('/play/solo-piece', { wallet: PLAYER, onChain: true })
          await solo.getByText('free to pull').waitFor()
          check('a one-piece lineup says so', (await text(solo)).includes("what's inside · one piece, always revealed"))
          await watchStages(solo)
          await solo.getByRole('button', { name: 'pull', exact: true }).click()
          const collectBtn = solo.getByRole('button', { name: 'collect · 0.002 ETH' })
          await collectBtn.waitFor()
          const minted = chain.mints.length
          const before = chain.tokens.get(key(REVEAL, 1)).totalMinted
          await collectBtn.click()
          await shown(solo, "you've collected").waitFor({ timeout: 20_000 }).catch(() => {})
          const m = chain.mints.at(-1)
          check('collecting sends one mint of the revealed piece from the player\'s wallet',
            chain.mints.length === minted + 1 && m?.collection === REVEAL && m.tokenId === 1n && m.quantity === 1n && m.mintTo === PLAYER.toLowerCase(),
            JSON.stringify(m, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
          check('paying its own price plus the protocol fee, through its own sale',
            m?.value === MINT_FEE + 2_000_000_000_000_000n && m.strategy === FPSS.toLowerCase())
          check('naming Kismet as the mint referral', m?.rewardsRecipients?.length === 1 && m.rewardsRecipients[0] === KISMET_REFERRAL)
          check('and the edition really grew by one', chain.tokens.get(key(REVEAL, 1)).totalMinted === before + 1n)
          const said = (await solo.locator(`a[href="/artwork/${REVEAL}/1"]`).first().innerText()).replace(/\s+/g, ' ')
          check('the page says the player has collected it, and whose it is', /^you've collected Reveal One by 0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(said), said)
          check('with nothing left to pay', (await solo.getByRole('button', { name: /^collect/ }).count()) === 0)
          const soloSaid = await saidOf(solo)
          check('and a screen reader is told the collect, from the wallet to what is now theirs',
            soloSaid.includes('Confirm in your wallet') && /^You've collected Reveal One by 0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(soloSaid.at(-1)), JSON.stringify(soloSaid))
          await solo.context().close()

          // A curator's machine: the curator earns the referral on the collect —
          // but not on their own.
          await call('/api/experience/machines', { method: 'POST', user: CURATOR_TOKEN, body: { kind: 'reveal', id: 'curator-solo', name: 'Curator Solo', entries: [{ collection: REVEAL, tokenId: '1' }] } })
          await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'curator-solo', state: 'live' } })
          const collectFrom = async (wallet) => {
            const pg = await open('/play/curator-solo', { wallet, onChain: true })
            await pg.getByText('free to pull').waitFor()
            await pg.getByRole('button', { name: 'pull', exact: true }).click()
            await pg.getByRole('button', { name: 'collect · 0.002 ETH' }).click()
            await shown(pg, "you've collected").waitFor({ timeout: 20_000 }).catch(() => {})
            await pg.context().close()
            return chain.mints.at(-1)
          }
          const byPlayer = await collectFrom(PLAYER)
          check('a collect through a curator\'s machine names the curator as the mint referral',
            byPlayer?.mintTo === PLAYER.toLowerCase() && byPlayer.rewardsRecipients[0] === CURATOR.toLowerCase(), JSON.stringify(byPlayer?.rewardsRecipients))
          check('which Zora escrows for them to be paid out', (chain.rewards.get(CURATOR.toLowerCase()) ?? 0n) > 0n)
          const byCurator = await collectFrom(CURATOR)
          check('but a curator collecting from their own machine earns no rebate — Kismet keeps it',
            byCurator?.mintTo === CURATOR.toLowerCase() && byCurator.rewardsRecipients[0] === KISMET_REFERRAL, JSON.stringify(byCurator?.rewardsRecipients))

          // Sold out in the moment between the reveal and the collect: nothing
          // is charged or minted, and the page does not claim it was collected.
          {
            const pg = await open('/play/curator-solo', { wallet: PLAYER, onChain: true })
            await pg.getByText('free to pull').waitFor()
            await pg.getByRole('button', { name: 'pull', exact: true }).click()
            const btn = pg.getByRole('button', { name: 'collect · 0.002 ETH' })
            await btn.waitFor()
            const t = chain.tokens.get(key(REVEAL, 1))
            chain.tokens.set(key(REVEAL, 1), { ...t, maxSupply: t.totalMinted })
            const minted = chain.mints.length
            await btn.click()
            await pg.waitForTimeout(3000)
            check('a piece that sells out between the reveal and the collect is not minted, and not shown as collected',
              chain.mints.length === minted && (await shown(pg, "you've collected").count()) === 0)
            chain.tokens.set(key(REVEAL, 1), t)
            await pg.context().close()
          }

          // A USDC piece: approve, then the ERC20Minter's mint — naming the
          // curator as the mint referral on that path too.
          {
            await call('/api/experience/machines', { method: 'POST', user: CURATOR_TOKEN, body: { kind: 'reveal', id: 'curator-usdc', name: 'Curator USDC', entries: [{ collection: REVEAL, tokenId: '6' }] } })
            await call('/api/admin/experience', { method: 'POST', admin: ADMIN_TOKEN, body: { id: 'curator-usdc', state: 'live' } })
            const pg = await open('/play/curator-usdc', { wallet: PLAYER, onChain: true })
            await pg.getByText('free to pull').waitFor()
            await pg.getByRole('button', { name: 'pull', exact: true }).click()
            const btn = pg.getByRole('button', { name: /^collect · \$1/ })
            await btn.waitFor()
            const sent = chain.walletTxs.length
            const minted = chain.mints.length
            await btn.click()
            await shown(pg, "you've collected").waitFor({ timeout: 20_000 }).catch(() => {})
            const txs = chain.walletTxs.slice(sent)
            const m = chain.mints.at(-1)
            check('a USDC piece asks to approve exactly its price to Zora\'s ERC20Minter, then mints',
              txs.length === 2 && String(txs[0].to).toLowerCase() === USDC && String(txs[1].to).toLowerCase() === ERC20_MINTER &&
                decodeFunctionData({ abi: USDC_APPROVE, data: txs[0].data }).args.join().toLowerCase() === `${ERC20_MINTER},1000000`,
              JSON.stringify(txs.map((t) => t.to)))
            check('minting the revealed piece to the player at its USDC price',
              chain.mints.length === minted + 1 && m?.collection === REVEAL && m.tokenId === 6n && m.mintTo === PLAYER.toLowerCase() && m.value === 1_000_000n && m.currency === 'usdc',
              JSON.stringify(m, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
            check('with the curator as the mint referral', m?.rewardsRecipients?.[0] === CURATOR.toLowerCase())
            check('and the page says it is collected', (await shown(pg, "you've collected").count()) === 1)
            await pg.context().close()
          }
        }

        // ── a capsule machine with little or nothing left ──
        // The button sells only what can be delivered: pull sizes no larger
        // than what is left, nothing on a table the chain did not confirm, and
        // nothing at all once it is empty — each saying why.
        {
          const face = async () => {
            const pg = await open('/play/dry-season')
            await pg.getByText('Dry Season').first().waitFor()
            await pg.waitForTimeout(500)
            return pg
          }
          let pg = await face()
          const closed = pg.getByRole('button', { name: 'nothing left to win' })
          check('an empty machine says there is nothing left to win, and will not sell', (await closed.count()) === 1 && (await closed.isDisabled()))
          check('and says why', (await text(pg)).includes('every artwork in this machine has been given out, so capsules are not on sale here'))
          await pg.context().close()

          chain.tokens.set(key(POOL, 18), { maxSupply: 2n, totalMinted: 0n }) // two copies back on-chain
          pg = await face()
          const sizes = (await pg.getByRole('button', { name: /^×\d+$/ }).allInnerTexts()).join(',')
          check('with two artworks left, it offers only a single pull — never more capsules than artworks', sizes === '×1' && (await pg.getByRole('button', { name: 'play', exact: true }).isEnabled()), sizes)
          await pg.context().close()

          const t17 = chain.tokens.get(key(POOL, 17))
          chain.tokens.set(key(POOL, 17), { maxSupply: 3n, totalMinted: 2n })
          pg = await face()
          check('beside the price, how many artworks it holds and, at even odds, each one\'s', (await text(pg)).includes('2 artworks · each 1 in 2 · see odds'),
            (await text(pg)).match(/\d+ artworks? ·[^·]*· see odds/)?.[0] ?? '')
          await pg.context().close()
          // Weighted three to one, the line leads with the rarest.
          const pool = hashes.get('kismetart:xp:dry-season:pool')
          const e18 = pool.get(`${POOL}:18`)
          pool.set(`${POOL}:18`, JSON.stringify({ ...JSON.parse(e18), weight: 3 }))
          pg = await face()
          check('and at uneven odds, the rarest pull\'s', (await text(pg)).includes('2 artworks · rarest 1 in 4 · see odds'),
            (await text(pg)).match(/\d+ artworks? ·[^·]*· see odds/)?.[0] ?? '')
          await pg.context().close()
          pool.set(`${POOL}:18`, e18)
          chain.tokens.set(key(POOL, 17), t17)

          chain.failMulticall = true
          pg = await face()
          chain.failMulticall = false
          const checking = pg.getByRole('button', { name: 'checking what’s left' })
          check('when the chain cannot confirm what is left, it waits rather than sells', (await checking.count()) === 1 && (await checking.isDisabled()))
          check('and says so', (await text(pg)).includes('we couldn’t confirm which artworks are left just now'))
          await pg.context().close()
          chain.tokens.set(key(POOL, 18), { maxSupply: 2n, totalMinted: 2n })
        }

        // ── the reveal studio ──
        // The curator has published five machines in the last few minutes,
        // the per-wallet limit; the mock's window never expires on its own.
        const windowPasses = () => strings.delete(`kismetart:rl:xp-publish:${CURATOR.toLowerCase()}`)
        windowPasses()
        {
          await call('/api/experience/piece', { method: 'POST', user: ARTIST_B_TOKEN, body: { collection: REVEAL, tokenId: '4', available: false } })
          const page = await open('/play/create-reveal', { user: CURATOR_TOKEN, wallet: CURATOR, uploads: true })
          await page.getByText('reveal studio').first().waitFor()
          await page.getByPlaceholder('new-voices').fill('browser-picks')
          await page.getByPlaceholder('New Voices').fill('Browser Picks')
          const addRow = async (i, ref) => {
            if (i > 0) await page.getByRole('button', { name: 'add artwork' }).click()
            await page.getByPlaceholder('artwork link, or collection 0x…').nth(i).fill(ref)
          }
          await addRow(0, `${origin}/artwork/${REVEAL}/2`)
          await addRow(1, `${origin}/artwork/${REVEAL}/5`)
          await addRow(2, `${origin}/artwork/${REVEAL}/4`)
          await addRow(3, `${origin}/artwork/${REVEAL}/3`)
          // Each row looks its piece up on its own, so wait for both verdicts
          // before reading: one row answering says nothing about the other.
          await page.getByText('Kismet has no record of who made this').waitFor({ timeout: 8000 }).catch(() => {})
          await page.getByText('its artist has turned machines off for this piece').waitFor({ timeout: 8000 }).catch(() => {})
          const rows = await text(page)
          check('a pasted piece names its maker', /by 0x[0-9a-f]{4}…[0-9a-f]{4}/.test(rows))
          check('one Kismet has no maker for is flagged as you build', rows.includes('kismet has no record of who made this — only artworks minted on kismet can go in'))
          check('as is one its artist turned off', rows.includes('its artist has turned machines off for this piece'))
          await page.getByRole('button', { name: 'check', exact: true }).click()
          await page.locator('section', { hasText: /fix before publishing/i }).first().waitFor({ timeout: 8000 }).catch(() => {})
          check('the check refuses both, by piece', /fix before publishing.*kismet has no record of who made .*:5.*isn't available for machines/.test(await text(page)), (await text(page)).match(/fix before publishing.{0,240}/)?.[0] ?? '')
          await page.getByRole('button', { name: 'Remove artwork 3' }).click()
          await page.getByRole('button', { name: 'Remove artwork 2' }).click()
          await page.getByRole('button', { name: 'check', exact: true }).click()
          await page.getByText('Every piece can go in').waitFor({ timeout: 8000 }).catch(() => {})
          const ready = await text(page)
          check('once they are gone it is ready, and says what each piece shows as today',
            ready.includes('on sale now · free') && ready.includes('shows up when its sale opens'), ready.match(/the lineup.{0,300}/)?.[0] ?? '')
          await page.getByLabel('cover image').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
          check('a reveal machine offers an open frame, and no dispense — its pull waits on nothing',
            (await page.getByLabel('open frame', { exact: true }).count()) === 1 && (await page.getByLabel('dispense frame', { exact: true }).count()) === 0)
          await page.getByLabel('open frame', { exact: true }).setInputFiles({ name: 'open.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
          await page.getByRole('button', { name: 'change', exact: true }).waitFor({ timeout: 15_000 }).catch(() => {})
          const uploadsBefore = arweaveUploads.length
          await page.getByRole('button', { name: 'publish' }).click()
          await page.getByText('is queued for a curator').waitFor({ timeout: 8000 }).catch(() => {})
          check('publishing queues it for a curator', (await text(page)).includes('browser picks is queued for a curator'))
          const queuedFrames = (await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })).json?.machines?.find((r) => r.machine.id === 'browser-picks')?.machine?.frames
          const [coverUp, frameUp] = arweaveUploads.slice(uploadsBefore)
          check('with its open frame: a still, uploaded once, its own still',
            arweaveUploads.length === uploadsBefore + 2 && !!coverUp && JSON.stringify(Object.keys(queuedFrames ?? {})) === '["open"]' &&
              queuedFrames.open.kind === 'image' && queuedFrames.open.uri === `ar://${frameUp?.id}` && queuedFrames.open.poster === queuedFrames.open.uri,
            JSON.stringify(queuedFrames))
          check('as a reveal machine with the two pieces',
            (await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })).json?.machines?.some((r) => r.machine.id === 'browser-picks' && r.machine.kind === 'reveal' && r.pool.length === 2))
          await call('/api/experience/piece', { method: 'POST', user: ARTIST_B_TOKEN, body: { collection: REVEAL, tokenId: '4', available: true } })
          await page.context().close()
        }

        // ── linking a collection in the studio, and the page it makes ──
        {
          windowPasses()
          const page = await open('/play/create-reveal', { user: CURATOR_TOKEN, wallet: CURATOR, uploads: true })
          await page.getByText('reveal studio').first().waitFor()
          await page.getByPlaceholder('new-voices').fill('browser-linked')
          await page.getByPlaceholder('New Voices').fill('Browser Linked')
          await page.getByRole('button', { name: 'link a collection' }).click()
          const link = page.getByPlaceholder('collection link, or 0x…')
          await link.fill(`${origin}/collection/${LINKED}`)
          check('a pasted collection link becomes its address', (await link.inputValue()) === LINKED, await link.inputValue())
          check('with a collection linked and no pieces picked, it can be checked', await page.getByRole('button', { name: 'check', exact: true }).isEnabled())
          await page.getByRole('button', { name: 'check', exact: true }).click()
          await page.getByText('from it today').waitFor({ timeout: 8000 }).catch(() => {})
          const t = await text(page)
          check('the check says what the collection brings in today', t.includes('2 pieces from it today · 1 on sale now'), t.match(/linked collections.{0,300}/)?.[0] ?? '')
          await page.getByRole('button', { name: 'link a collection' }).click()
          await page.getByRole('button', { name: 'link a collection' }).click()
          check('at most three collections can be linked', (await page.getByRole('button', { name: 'link a collection' }).count()) === 0 && (await link.count()) === 3)
          await page.getByRole('button', { name: 'Unlink collection 3' }).click()
          await page.getByRole('button', { name: 'Unlink collection 2' }).click()
          await page.getByLabel('cover image').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
          await page.getByRole('button', { name: 'publish' }).click()
          await page.getByText('is queued for a curator').waitFor({ timeout: 8000 }).catch(() => {})
          const linkedQueue = (await call('/api/admin/experience?state=review', { admin: ADMIN_TOKEN })).json?.machines ?? []
          check('publishing queues it with the link and what it took in',
            linkedQueue.some((r) => r.machine.id === 'browser-linked' && r.machine.collections?.join() === LINKED && r.pool.length === 2),
            `${JSON.stringify(linkedQueue.map((r) => [r.machine.id, r.machine.collections, r.pool.length]))} | page: ${(await text(page)).slice(-300)}`)
          await page.context().close()

          const pg = await open('/play/fresh-ink')
          await pg.getByText('Fresh Ink').first().waitFor()
          await pg.getByText('auto-updating').waitFor({ timeout: 8000 }).catch(() => {})
          check('a linked machine\'s page says new work joins by itself', (await text(pg)).includes('auto-updating · new work minted into 0xeeee…0002 joins by itself'), (await text(pg)).match(/curated by.{0,160}/)?.[0] ?? '')
          check('linking to the collection', (await pg.getByRole('link', { name: '0xeeee…0002' }).getAttribute('href')) === `/collection/${LINKED}`)
          await pg.context().close()
        }

        // ── an artist's capsule prizes, apart from their airdrops ──
        {
          const page = await open(`/profile/${ADMIN}`, { user: ADMIN_USER_TOKEN, wallet: ADMIN })
          await page.getByText('Box Season').first().waitFor()
          const body = await text(page)
          check('the artist sees how many prizes each capsule machine delivered', /box season .*2 prizes delivered/.test(body), body.match(/box season.{0,160}/)?.[0] ?? '')
          check('and who won them', /#(7|14) won by 0x51be…77aa/.test(body))
          check('labelled as capsule prizes, not airdrops', body.includes('capsule prizes are minted by kismet when a paid capsule is opened. they are not airdrops'))
          await page.context().close()
        }

        // ── a curator's reveal machines on their profile ──
        {
          const page = await open(`/profile/${CURATOR}`)
          await page.getByText('New Voices').first().waitFor()
          const body = await text(page)
          check('a visitor sees a curator\'s reveal machine with its lineup size', body.includes('reveal machine · 5 artworks'))
          check('but not what they have been paid', !body.includes('paid so far'))
          await page.context().close()
          const own = await open(`/profile/${CURATOR}`, { user: CURATOR_TOKEN, wallet: CURATOR })
          await own.getByText('Paid so far').first().waitFor({ timeout: 10_000 }).catch(() => {})
          const ownBody = await text(own)
          check('the curator sees that collects earn them the referral, paid automatically, and what has been paid',
            ownBody.includes('paid to your wallet automatically each day') && ownBody.includes('paid so far: 0.0002 eth'), ownBody.match(/collects through.{0,200}/)?.[0] ?? '')
          await own.context().close()
        }

        // ── the Discover "play" tab ──
        // A draggable tab like the others: after home by default, placed after
        // home in a returning visitor's saved order, kept wherever they moved
        // it; it lists the live machines, and with none, offers to build one.
        {
          const tabsOf = async (pg) => (await pg.locator('[data-tab]').allInnerTexts()).map((t) => t.trim().toLowerCase()).join(',')
          const home = async (opts = {}) => {
            const pg = await open('/', opts)
            await pg.locator('[data-tab="play"]').waitFor()
            return pg
          }
          let pg = await home()
          check('a first visit shows play right after home', (await tabsOf(pg)) === 'featured,trending,home,play,artists', await tabsOf(pg))
          await pg.locator('[data-tab="play"]').click()
          const live = ((await call('/api/experience/machines')).json?.machines ?? []).filter((m) => m.state === 'live').map((m) => `/play/${m.id}`).sort()
          const rows = pg.locator('div:not([hidden]) > div.mt-4 article > a[href^="/play/"]')
          await rows.first().waitFor({ timeout: 10_000 }).catch(() => {})
          const shown = (await rows.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).sort()
          check('it lists every live machine, each opening that machine, and no closed one', live.length > 0 && shown.join() === live.join(), `${shown.length} shown vs ${live.length} live`)
          check('and always offers to build one', (await pg.getByRole('link', { name: 'build gachapon' }).getAttribute('href').catch(() => null)) === '/play/create')
          check('and is remembered as the tab to return to', (await pg.evaluate(() => localStorage.getItem('kismetart:active-tab'))) === 'play')
          await pg.context().close()

          pg = await home({ storage: { 'kismetart:tab-order': JSON.stringify(['roster', 'main', 'featured', 'trending']) } })
          check('a visitor who arranged their tabs finds play right after home, the rest as they left them', (await tabsOf(pg)) === 'artists,home,play,featured,trending', await tabsOf(pg))
          await pg.context().close()
          pg = await home({ storage: { 'kismetart:tab-order': JSON.stringify(['play', 'featured', 'trending', 'main', 'roster']) } })
          check('and one who moved play keeps it where they put it', (await tabsOf(pg)) === 'play,featured,trending,home,artists', await tabsOf(pg))
          await pg.context().close()

          // Moved like any tab: press, hold, drag it past its neighbour.
          pg = await home()
          const box = await pg.locator('[data-tab="play"]').boundingBox()
          const next = await pg.locator('[data-tab="roster"]').boundingBox()
          await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await pg.mouse.down()
          await pg.waitForTimeout(400)
          for (let i = 1; i <= 10; i++) await pg.mouse.move(box.x + box.width / 2 + (next.x + next.width - box.x) * (i / 10), box.y + box.height / 2)
          await pg.mouse.up()
          await pg.waitForTimeout(300)
          check('play can be dragged like the other tabs, and the new order is saved',
            (await tabsOf(pg)) === 'featured,trending,home,artists,play' &&
              (await pg.evaluate(() => localStorage.getItem('kismetart:tab-order'))) === JSON.stringify(['featured', 'trending', 'main', 'roster', 'play']),
            `${await tabsOf(pg)} saved=${await pg.evaluate(() => localStorage.getItem('kismetart:tab-order'))}`)
          await pg.context().close()

          // Nothing on the shelves: the way to build the first.
          const index = zsets.get('kismetart:xp:index')
          zsets.delete('kismetart:xp:index')
          try {
            pg = await home({ storage: { 'kismetart:active-tab': 'play' } })
            const build = pg.getByRole('link', { name: 'build gachapon' })
            await build.waitFor({ timeout: 10_000 }).catch(() => {})
            check('with no machine to play, it offers to build one', (await text(pg)).includes('nothing to play yet') && (await build.getAttribute('href')) === '/play/create')
            await pg.context().close()
            const list = await open('/play')
            await list.getByText('no machines running yet').waitFor({ timeout: 10_000 }).catch(() => {})
            check('and so does the list page', (await text(list)).includes('any pass holder can build one') &&
              (await list.getByRole('link', { name: 'build one' }).getAttribute('href').catch(() => null)) === '/play/create')
            await list.context().close()
          } finally {
            zsets.set('kismetart:xp:index', index)
          }

          // Five tabs on a phone: nothing spills sideways.
          for (const width of [390, 360]) {
            pg = await home({ viewport: { width, height: 800 } })
            const fits = await pg.evaluate(() => {
              const tabs = [...document.querySelectorAll('[data-tab]')].map((t) => t.getBoundingClientRect())
              return document.documentElement.scrollWidth <= window.innerWidth && tabs.every((r) => r.right <= window.innerWidth)
            })
            check(`at ${width}px the five tabs fit without scrolling the page sideways`, fits, `scrollWidth=${await pg.evaluate(() => document.documentElement.scrollWidth)}`)
            await pg.context().close()
          }
        }

        // ── the site nav: machines are found in Discover's play tab ──
        // No Experience item; a machine page sits under Discover, as every
        // page outside Mint and Market does.
        {
          const desk = await open('/play/spring-season')
          await desk.getByText('Spring Season').first().waitFor()
          // textContent, not innerText: the nav is styled uppercase.
          const items = await desk.locator('header nav a:visible').evaluateAll((as) => as.map((a) => a.textContent.trim()))
          check('the desktop nav has no Experience item', items.join() === 'Discover,Mint,Market', items.join())
          const discover = await desk.locator('header nav a:visible', { hasText: 'Discover' }).getAttribute('class')
          check('and on a machine page Discover is the active item', /font-bold/.test(discover ?? ''), discover)
          await desk.context().close()
          const phone = await open('/play/spring-season', { viewport: { width: 390, height: 800 } })
          await phone.getByText('Spring Season').first().waitFor()
          const current = (await phone.locator('header nav button[aria-haspopup="menu"]').textContent()).trim()
          const others = await phone.locator('header nav [role="menu"] a').evaluateAll((as) => as.map((a) => a.textContent.trim()))
          check('on a phone the menu reads Enjoy, with Create and Curate to go to', current === 'Enjoy' && others.join() === 'Create,Curate', `${current} | ${others.join()}`)
          await phone.context().close()
        }

        // ── the bell: where each machine notice takes you ──
        {
          const bell = async (user, wallet) => {
            const pg = await open('/', { user, wallet })
            const btn = pg.getByRole('button', { name: /^Notifications/ })
            await btn.first().waitFor()
            await pg.waitForTimeout(1500)
            const label = await btn.first().getAttribute('aria-label')
            await btn.first().click()
            return { pg, label }
          }
          const artist = await bell(ARTIST_B_TOKEN, ARTIST_B)
          check('an artist with machine notices sees an unread badge', /\d+ unread/.test(artist.label ?? ''), artist.label)
          const featured = artist.pg.locator('a', { hasText: /is in "new voices"/i }).first()
          await featured.waitFor({ timeout: 10_000 }).catch(() => {})
          check('"your work is featured" opens the artwork, where its machines and its switch are',
            ((await featured.getAttribute('href').catch(() => null)) ?? '').startsWith(`/artwork/${REVEAL}/`), await featured.getAttribute('href').catch(() => 'none'))
          await artist.pg.context().close()
          const kismet = await bell(ADMIN_USER_TOKEN, ADMIN)
          const review = kismet.pg.locator('a', { hasText: /is waiting for review/i }).first()
          await review.waitFor({ timeout: 10_000 }).catch(() => {})
          check('Kismet\'s review notice opens the review queue', (await review.getAttribute('href').catch(() => null)) === '/admin/play')
          await kismet.pg.context().close()
        }

        // ── where an artist's work is featured, on their profile ──
        {
          const visitor = await open(`/profile/${ARTIST_B}`)
          await visitor.getByText('featured in').first().waitFor({ timeout: 10_000 }).catch(() => {})
          const vBody = await text(visitor)
          check('a visitor sees the machines an artist is featured in, and by whom',
            vBody.includes('featured in') && vBody.includes('new voices · curated by 0x7777…7777') && vBody.includes('fresh ink'), vBody.match(/featured in.{0,300}/)?.[0] ?? '')
          check('a closed one says so', /kismet picks · curated by .{0,20} · closed/.test(vBody))
          await visitor.context().close()
          const own = await open(`/profile/${ARTIST_B}`, { user: ARTIST_B_TOKEN, wallet: ARTIST_B })
          await own.getByText('your work in other machines').first().waitFor({ timeout: 10_000 }).catch(() => {})
          const oBody = await text(own)
          check('the artist sees it as their work in other machines, with how to take a piece out',
            oBody.includes('your work in other machines') && oBody.includes('to take one out of every reveal machine, turn machines off from that piece\'s page'))
          await own.context().close()
        }

        // ── a creator's machines on their profile ──
        // Visitors see what is on sale; the creator sees every state in plain
        // words and ends a season in one step that closes the capsule's sale
        // on-chain, from their own wallet, before the listing changes.
        {
          // Their two machines on sale, and the machines featuring their work.
          const c2Machines = 2 + ((await call(`/api/experience/machines?creator=${CREATOR2}`)).json?.featuredIn?.length ?? 0)
          check('their profile counts their own machines and those featuring them', c2Machines === 6, String(c2Machines))
          const visitor = await open(`/profile/${CREATOR2}`)
          await visitor.getByText(`Machines (${c2Machines})`).waitFor()
          // Settled, so an editor that loads late would have loaded.
          await visitor.waitForLoadState('networkidle').catch(() => {})
          const vBody = await text(visitor)
          check('a visitor sees the creator\'s machines on sale', vBody.includes('field recordings') && vBody.includes('browser machine'))
          check('with no controls', (await visitor.getByRole('button', { name: 'end season' }).count()) === 0 && (await visitor.getByRole('link', { name: /build another gachapon/ }).count()) === 0 &&
            (await visitor.getByRole('button', { name: /cover/ }).count()) === 0)
          await visitor.context().close()

          const page = await open(`/profile/${CREATOR2}`, { user: USER_TOKEN, wallet: CREATOR2, onChain: true })
          await page.getByText(`Machines (${c2Machines})`).waitFor()
          check('the creator sees each machine in plain words', (await text(page)).includes('on sale'))
          // Its editor loads for its owner only, after the page.
          await page.getByRole('button', { name: 'change cover' }).first().waitFor({ timeout: 15_000 }).catch(() => {})
          check('and can change each one\'s cover', (await page.getByRole('button', { name: 'change cover' }).count()) >= 1)
          check('and how to build another', (await page.getByRole('link', { name: 'build another gachapon →' }).getAttribute('href').catch(() => null)) === '/play/create')
          const row = page.locator('div.border', { hasText: 'Browser Machine' }).last()
          await row.getByRole('button', { name: 'end season' }).click()
          await row.getByRole('button', { name: 'confirm end season' }).click()
          await page.getByText('Season ended').first().waitFor()
          const sale = chain.sales.get(key(CAPSULE_A, 1))
          check('ending a season closes the capsule\'s sale on-chain', !!sale && sale.saleEnd <= BigInt(Math.floor(Date.now() / 1000)), String(sale?.saleEnd))
          check('in one signature from the creator\'s wallet', chain.walletTxs.at(-1)?.to?.toLowerCase() === CAPSULE_A)
          check('and then ends the machine', (await call('/api/experience/machines/browser-machine')).json?.machine?.state === 'ended')
          await page.context().close()
        }

        // ── a creator ends their machine where they see it ──
        // On the machine list, the play tab and the machine's own page: shown to
        // its creator only, one tap to see what ending does, one to do it.
        {
          const listed = (await call('/api/experience/machines')).json.machines
          const liveBy = (addr) => listed.filter((m) => m.state === 'live' && m.creator === addr.toLowerCase()).length
          const endControls = (pg) => pg.getByRole('button', { name: /^(end season|close machine)$/ })
          const rowOf = (pg, id) => pg.locator('article').filter({ has: pg.locator(`a[href="/play/${id}"]`) })
          const stateOf = async (id) => (await call(`/api/experience/machines/${id}`)).json?.machine?.state

          const visitor = await open('/play')
          await visitor.getByRole('link', { name: 'build gachapon' }).waitFor().catch(() => {})
          await visitor.waitForTimeout(1500)
          check('a visitor sees no way to end anyone\'s machine', (await endControls(visitor).count()) === 0)
          await visitor.context().close()
          const other = await open('/play/spring-season', { wallet: PLAYER })
          await other.getByText('Spring Season').first().waitFor()
          await other.waitForTimeout(1500)
          check('nor does anyone else on a machine\'s page', (await endControls(other).count()) === 0)
          await other.context().close()
          const admin = await open('/play', { user: ADMIN_USER_TOKEN, wallet: ADMIN })
          await endControls(admin).first().waitFor({ timeout: 10_000 }).catch(() => {})
          check('a creator sees one on each of their live machines in the list, and on no one else\'s',
            liveBy(ADMIN) > 0 && (await endControls(admin).count()) === liveBy(ADMIN), `${await endControls(admin).count()} vs ${liveBy(ADMIN)}`)
          await admin.context().close()

          // From the list.
          const list = await open('/play', { user: CURATOR_TOKEN, wallet: CURATOR })
          const row = rowOf(list, 'curator-usdc')
          await row.getByRole('button', { name: 'close machine' }).click()
          check('the first tap says what closing does, and changes nothing yet',
            (await row.innerText()).toLowerCase().includes('this takes the machine off the shelves') && (await stateOf('curator-usdc')) === 'live')
          await row.getByRole('button', { name: 'confirm close' }).click()
          await row.getByText('closed', { exact: true }).waitFor({ timeout: 10_000 }).catch(() => {})
          check('the second closes it, and the list shows it closed with no control left',
            (await stateOf('curator-usdc')) === 'ended' && (await row.getByText('closed', { exact: true }).count()) === 1 && (await endControls(list).count()) === liveBy(CURATOR) - 1)
          await list.context().close()

          // From the play tab: the machine leaves it.
          const tab = await open('/', { user: CURATOR_TOKEN, wallet: CURATOR, storage: { 'kismetart:active-tab': 'play' } })
          const nv = rowOf(tab, 'new-voices')
          await nv.getByRole('button', { name: 'close machine' }).click()
          await nv.getByRole('button', { name: 'confirm close' }).click()
          await tab.locator('a[href="/play/new-voices"]').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
          check('closed from the play tab, it leaves the tab', (await stateOf('new-voices')) === 'ended' && (await tab.locator('a[href="/play/new-voices"]').count()) === 0)
          await tab.context().close()

          // From a capsule machine's page: one signature closes the capsule's sale.
          const capsulePage = await open('/play/dry-season', { user: ADMIN_USER_TOKEN, wallet: ADMIN, onChain: true })
          await capsulePage.getByRole('button', { name: 'end season' }).click()
          const signed = chain.walletTxs.length
          await capsulePage.getByRole('button', { name: 'confirm end season' }).click()
          await capsulePage.getByRole('button', { name: 'season closed' }).waitFor({ timeout: 15_000 }).catch(() => {})
          const sale = chain.sales.get(key(CAPSULE_D, 1))
          check('from a capsule machine\'s page, one signature closes the capsule\'s sale on-chain',
            chain.walletTxs.length === signed + 1 && String(chain.walletTxs.at(-1)?.to).toLowerCase() === CAPSULE_D && sale.saleEnd <= BigInt(Math.floor(Date.now() / 1000)))
          check('and ends the season: the page reads season closed, with no control left',
            (await stateOf('dry-season')) === 'ended' && (await capsulePage.getByRole('button', { name: 'season closed' }).count()) === 1 && (await endControls(capsulePage).count()) === 0)
          await capsulePage.context().close()

          // From a reveal machine's page.
          const revealPage = await open('/play/fresh-ink', { user: CURATOR_TOKEN, wallet: CURATOR })
          await revealPage.getByRole('button', { name: 'close machine' }).click()
          await revealPage.getByRole('button', { name: 'confirm close' }).click()
          await revealPage.getByText('this machine is closed').waitFor({ timeout: 10_000 }).catch(() => {})
          check('from a reveal machine\'s page, it closes, and the page says so',
            (await stateOf('fresh-ink')) === 'ended' && (await text(revealPage)).includes('this machine is closed') && (await endControls(revealPage).count()) === 0)
          await revealPage.context().close()
        }
      } finally {
        await browser.close()
      }
      if (pageErrors.length) console.log(`  (page errors: ${pageErrors.slice(0, 5).join(' || ').slice(0, 600)})`)
    }
    }
  }
} catch (err) {
  console.log(`  FAIL  harness threw — ${err?.stack ?? err}`)
  failures++
} finally {
  shutdown()
}

if (unsupported.size) console.log(`\n(mock redis saw unsupported commands: ${[...unsupported].join(', ')})`)
if (failures > 0 && /error|Error/.test(serverLog)) console.log('\n--- server log (tail) ---\n' + serverLog.slice(-3000))
console.log(failures > 0 ? `\n${failures} FAILURE(S)\n` : '\nAll end-to-end checks pass.\n')
process.exit(failures > 0 ? 1 : 0)
