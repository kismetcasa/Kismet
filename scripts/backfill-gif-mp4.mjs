#!/usr/bin/env node
// Backfill: re-encode legacy raw-GIF moments to iOS-safe MP4 + poster and
// re-point their tokenURI. These are moments minted before (or around) the
// GIF->MP4 transcode pipeline whose metadata still points `image`/`content.uri`
// at the original animated .gif with no `animation_url`. iOS WebKit can't
// decode large animated GIFs, so they render on desktop but show "no preview"
// (post-fix) / a black box (pre-fix) on mobile. Every other moment is already
// an MP4, which is why only these are broken.
//
// Per token this script:
//   1. reads the on-chain tokenURI and fetches the current metadata JSON
//   2. resolves the raw GIF (content.uri ?? image) and downloads it
//   3. transcodes to H.264 yuv420p + faststart MP4 + a JPEG poster
//      (same ffmpeg args as lib/media/transcodeGif.ts, but server-side so the
//      100MB ffmpeg.wasm cap that let these escape transcode doesn't apply)
//   4. uploads the MP4, poster, and rewritten metadata via Turbo
//   5. re-points the tokenURI through inprocess's update-uri upstream
//
// The rewritten metadata drops the stale `content: { mime: 'image/gif' }` and
// adds `animation_url` so the renderer classifies the moment as a video.
//
// REQUIREMENTS (run in an env that has these — e.g. the deploy/server env):
//   - `ffmpeg` on PATH
//   - ARWEAVE_JWK            base64-encoded Arweave JWK (same var /api/upload uses)
//   - INPROCESS_API_KEY      x-api-key for inprocess (its smart wallet must be
//                            an admin on the target tokens)
//   - NEXT_PUBLIC_BASE_RPC_URL   Base RPC (for reading tokenURI)
//   - NEXT_PUBLIC_ARWEAVE_PAID_BY (optional) comma-sep Turbo payer addresses
//   - INPROCESS_API          (optional) defaults to https://api.inprocess.world/api
//
// USAGE:
//   node scripts/backfill-gif-mp4.mjs                  # default 2 targets below
//   node scripts/backfill-gif-mp4.mjs 0xcoll:tokenId [0xcoll:tokenId ...]
//   node scripts/backfill-gif-mp4.mjs --dry-run        # transcode only, no upload/update
//
// --dry-run transcodes each GIF locally to ./backfill-out/ and prints the
// metadata it WOULD write, without spending Arweave credit or touching chain.

import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

// --- config ---------------------------------------------------------------
const ARWEAVE_GATEWAYS = ['https://arweave.net', 'https://permagate.io']
const IPFS_GATEWAYS = ['https://ipfs.io/ipfs', 'https://dweb.link/ipfs']
const INPROCESS_API = process.env.INPROCESS_API || 'https://api.inprocess.world/api'
const CHAIN_ID = 8453

// The two known raw-GIF moments. Override via CLI args (0xcoll:tokenId).
const DEFAULT_TARGETS = [
  { collectionAddress: '0x83c9309e7945d514907be7535dac7a7002169892', tokenId: '2' },
  { collectionAddress: '0x4023801efccd18f9355012aa7b33b8f4a66ce227', tokenId: '1' },
]

const ERC1155_URI_ABI = [
  { type: 'function', name: 'uri', stateMutability: 'view', inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'string' }] },
]

// --- helpers ---------------------------------------------------------------
function gatewayUrls(uri) {
  if (!uri) return []
  if (uri.startsWith('ar://')) return ARWEAVE_GATEWAYS.map((g) => `${g}/${uri.slice(5)}`)
  if (uri.startsWith('ipfs://')) return IPFS_GATEWAYS.map((g) => `${g}/${uri.slice(7)}`)
  return [uri]
}

async function fetchFromGateways(uri, { asBuffer = false, timeoutMs = 60_000 } = {}) {
  const urls = gatewayUrls(uri)
  let lastErr
  for (const url of urls) {
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeoutMs)
      const res = await fetch(url, { signal: ac.signal }).finally(() => clearTimeout(t))
      if (!res.ok) { lastErr = new Error(`${res.status} ${url}`); continue }
      return asBuffer ? Buffer.from(await res.arrayBuffer()) : await res.json()
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`all gateways failed for ${uri}: ${lastErr?.message ?? 'unknown'}`)
}

// Node's fetch reliably pulls small JSON but fails ("fetch failed") on the
// large GIF body through CDN77 in front of arweave.net. curl handles the
// redirect + large transfer + retries far better, so use it for binary
// assets. Downloads to a temp file then reads it back.
async function downloadBuffer(uri) {
  const urls = gatewayUrls(uri)
  let lastErr
  for (const url of urls) {
    const tmp = join(tmpdir(), `dl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await execFileAsync(
        'curl',
        ['-fSL', '--retry', '3', '--retry-delay', '2', '--max-time', '900', '-o', tmp, url],
        { maxBuffer: 1024 * 1024 },
      )
      const buf = await readFile(tmp)
      if (buf.length === 0) throw new Error('empty download')
      return buf
    } catch (err) {
      lastErr = err
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }
  throw new Error(`could not download ${uri}: ${lastErr?.message ?? 'unknown'}`)
}

async function waitForPropagation(uri, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const url of gatewayUrls(uri)) {
      try {
        // curl -I (HEAD) for the same reason downloads use curl: Node's
        // fetch is flaky against this CDN. -f makes a non-2xx exit nonzero.
        await execFileAsync('curl', ['-fsIL', '--max-time', '20', url], { maxBuffer: 1024 * 1024 })
        return true
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  return false
}

const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.ogv', '.m4v']

// Is the moment ALREADY a video (an MP4 we shouldn't touch)? The raw
// on-chain metadata is often minimal — just {name, description, image} —
// so there's usually no mime to read; fall back to extension sniffing.
function isAlreadyVideo(meta) {
  if (meta.content?.mime?.startsWith('video/')) return true
  const anim = (meta.animation_url ?? '').split(/[?#]/, 1)[0].toLowerCase()
  return VIDEO_EXTS.some((ext) => anim.endsWith(ext))
}

// The animated/primary asset to inspect. Real on-chain metadata here is
// just `image`; animation_url / content.uri are the marketplace variants.
function mediaSource(meta) {
  return meta.animation_url ?? meta.content?.uri ?? meta.image ?? null
}

// ar:// URIs carry no extension and the raw metadata has no reliable mime,
// so the only trustworthy GIF signal is the file's own magic number.
function isGifBytes(buf) {
  return buf.length >= 6 && buf.toString('ascii', 0, 4) === 'GIF8'
}

async function transcode(gifBuf, outDir) {
  await mkdir(outDir, { recursive: true })
  const inPath = join(outDir, 'in.gif')
  const mp4Path = join(outDir, 'out.mp4')
  const posterPath = join(outDir, 'poster.jpg')
  await writeFile(inPath, gifBuf)
  // Poster = frame 0. Comma in the select filter is escaped for ffmpeg's
  // filtergraph parser (matches lib/media/transcodeGif.ts).
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', inPath,
    '-vf', 'select=eq(n\\,0)', '-vframes', '1', '-q:v', '5', posterPath,
  ])
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', inPath,
    '-movflags', 'faststart', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-g', '30', '-an',
    mp4Path,
  ], { maxBuffer: 1024 * 1024 * 64 })
  const [mp4, poster] = await Promise.all([readFile(mp4Path), readFile(posterPath)])
  if (mp4.byteLength === 0 || poster.byteLength === 0) throw new Error('ffmpeg produced empty output')
  return { mp4, poster }
}

function getPaidBy() {
  const raw = process.env.NEXT_PUBLIC_ARWEAVE_PAID_BY
  if (!raw) return undefined
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length > 0 ? list : undefined
}

async function makeTurbo() {
  const key = process.env.ARWEAVE_JWK
  if (!key) throw new Error('ARWEAVE_JWK not configured')
  const { TurboFactory } = await import('@ardrive/turbo-sdk')
  const jwk = JSON.parse(Buffer.from(key, 'base64').toString())
  return TurboFactory.authenticated({ privateKey: jwk })
}

async function turboUpload(turbo, data, contentType) {
  const paidBy = getPaidBy()
  const { id } = await turbo.upload({
    data,
    dataItemOpts: {
      tags: [{ name: 'Content-Type', value: contentType }],
      ...(paidBy && { paidBy }),
    },
  })
  return `ar://${id}`
}

async function updateTokenUri(collectionAddress, tokenId, newUri) {
  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) throw new Error('INPROCESS_API_KEY not configured')
  const res = await fetch(`${INPROCESS_API}/moment/update-uri`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ moment: { collectionAddress, tokenId, chainId: CHAIN_ID }, newUri }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`inprocess update-uri ${res.status}: ${text.slice(0, 300)}`)
  return text
}

// --- main ------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const targetArgs = args.filter((a) => !a.startsWith('--'))
  const targets = targetArgs.length
    ? targetArgs.map((a) => {
        const [collectionAddress, tokenId] = a.split(':')
        if (!/^0x[a-fA-F0-9]{40}$/.test(collectionAddress || '') || !/^\d+$/.test(tokenId || '')) {
          throw new Error(`bad target "${a}" — expected 0xcollection:tokenId`)
        }
        return { collectionAddress, tokenId }
      })
    : DEFAULT_TARGETS

  // Fail fast if ffmpeg is missing.
  try {
    await execFileAsync('ffmpeg', ['-version'])
  } catch {
    throw new Error('ffmpeg not found on PATH — install it before running this backfill')
  }

  const rpc = createPublicClient({ chain: base, transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL) })
  const turbo = dryRun ? null : await makeTurbo()

  for (const { collectionAddress, tokenId } of targets) {
    const label = `${collectionAddress}:${tokenId}`
    console.log(`\n=== ${label} ===`)
    const workDir = dryRun
      ? join(process.cwd(), 'backfill-out', label.replace(/[:]/g, '_'))
      : await mkdtemp(join(tmpdir(), 'gifbackfill-'))
    try {
      const metaUri = await rpc.readContract({
        address: collectionAddress,
        abi: ERC1155_URI_ABI,
        functionName: 'uri',
        args: [BigInt(tokenId)],
      })
      console.log(`  tokenURI: ${metaUri}`)
      const meta = await fetchFromGateways(metaUri)

      if (isAlreadyVideo(meta)) {
        console.log('  SKIP — already a video (mp4). No change.')
        continue
      }
      const gifUri = mediaSource(meta)
      if (!gifUri) {
        console.log('  SKIP — no media URL in metadata. No change.')
        continue
      }
      console.log(`  media: ${gifUri}`)
      const gifBuf = await downloadBuffer(gifUri)
      // The raw metadata has no reliable mime/extension, so confirm it's
      // actually a GIF from its magic number before transcoding.
      if (!isGifBytes(gifBuf)) {
        console.log(`  SKIP — asset is not a GIF (magic ${gifBuf.toString('hex', 0, 4)}). No change.`)
        continue
      }
      console.log(`  raw gif confirmed, ${(gifBuf.length / 1024 / 1024).toFixed(1)} MB`)

      const { mp4, poster } = await transcode(gifBuf, workDir)
      console.log(`  transcoded -> mp4 ${(mp4.length / 1024 / 1024).toFixed(1)} MB, poster ${(poster.length / 1024).toFixed(0)} KB`)

      if (dryRun) {
        const newMeta = {
          ...meta,
          image: 'ar://<poster>',
          animation_url: 'ar://<mp4>',
          content: { uri: 'ar://<mp4>', mime: 'video/mp4' },
        }
        console.log(`  DRY RUN — wrote ${workDir}/out.mp4 + poster.jpg`)
        console.log('  would write metadata:', JSON.stringify(newMeta, null, 2).replace(/\n/g, '\n  '))
        continue
      }

      const [mp4Uri, posterUri] = await Promise.all([
        turboUpload(turbo, mp4, 'video/mp4'),
        turboUpload(turbo, poster, 'image/jpeg'),
      ])
      console.log(`  uploaded mp4 ${mp4Uri}  poster ${posterUri}`)

      // Rewritten metadata: preserve every existing field (name,
      // description, createReferral, …), swap image → poster, and add
      // animation_url + content = the mp4 with mime video/mp4. content.mime
      // is load-bearing — ar:// URIs have no extension, so isVideoMoment()
      // classifies by content.mime; writing it explicitly guarantees the
      // moment renders as a playing video regardless of indexer behavior.
      const newMeta = {
        ...meta,
        image: posterUri,
        animation_url: mp4Uri,
        content: { uri: mp4Uri, mime: 'video/mp4' },
      }
      const newUri = await turboUpload(turbo, JSON.stringify(newMeta), 'application/json')
      console.log(`  uploaded metadata ${newUri}`)

      // Don't re-point at an unpropagated bundle — every viewer would 404.
      console.log('  verifying Arweave propagation…')
      const ok = await Promise.all([
        waitForPropagation(newUri),
        waitForPropagation(mp4Uri),
        waitForPropagation(posterUri),
      ])
      if (ok.some((v) => !v)) throw new Error('Arweave still settling — re-run in a minute')

      const result = await updateTokenUri(collectionAddress, tokenId, newUri)
      console.log(`  update-uri OK: ${result.slice(0, 200)}`)
      console.log(`  DONE ${label} -> ${newUri}`)
    } catch (err) {
      console.error(`  FAILED ${label}: ${err?.message ?? err}`)
    } finally {
      if (!dryRun) await rm(workDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
