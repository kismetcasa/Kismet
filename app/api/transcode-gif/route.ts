import { NextRequest, NextResponse } from 'next/server'
import { TurboFactory } from '@ardrive/turbo-sdk'
import { getPaidBy } from '@/lib/arweave/paidBy'
import { gatewayUrls } from '@/lib/arweave/gateways'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { errorResponse } from '@/lib/apiResponse'
import { consumeUserQuota } from '@/lib/userQuota'
import { transcodeGifToMp4Node } from '@/lib/media/transcodeGifNode'

export const runtime = 'nodejs'
// Encoding a large GIF takes longer than the default function budget.
export const maxDuration = 300

// Hard cap on the source GIF. Past the client's 100MB ffmpeg.wasm limit
// (this route exists precisely for the GIFs that exceed it) but kept tight:
// the whole GIF is buffered into one Node Buffer (Buffer.from(arrayBuffer))
// alongside the ffmpeg working set + sharp decode + the output buffers, so on
// the single uncapped box one near-max transcode racing a heavy request is a
// real OOM-kill contributor. 128MB comfortably covers the GIFs that exceed the
// in-browser path while halving that peak. (OWASP API4:2023 — bound resource
// consumption.) A streaming source→tempfile→ffmpeg refactor would remove the
// buffer entirely and is the follow-up if the cap ever needs to rise.
const MAX_GIF_BYTES = 128 * 1024 * 1024

// One transcode at a time per process. ffmpeg is CPU- and memory-heavy;
// on a resource-constrained host, two concurrent large encodes could push
// the container into the OOM-killer and take down the web server with it.
// Excess callers get a 503 and retry — far better than risking the box.
let active = 0
const MAX_CONCURRENT = 1

function getTurbo() {
  const key = process.env.ARWEAVE_JWK
  if (!key) throw new Error('ARWEAVE_JWK not configured')
  const jwk = JSON.parse(Buffer.from(key, 'base64').toString())
  return TurboFactory.authenticated({ privateKey: jwk })
}

async function fetchGif(gifUri: string): Promise<Buffer> {
  const urls = gatewayUrls(gifUri)
  let lastErr: unknown
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) {
        lastErr = new Error(`${res.status} ${url}`)
        continue
      }
      const len = Number(res.headers.get('content-length') ?? 0)
      if (len > MAX_GIF_BYTES) throw new Error('GIF exceeds size limit')
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > MAX_GIF_BYTES) throw new Error('GIF exceeds size limit')
      return buf
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`could not fetch ${gifUri}: ${lastErr instanceof Error ? lastErr.message : 'unknown'}`)
}

async function turboUpload(
  turbo: ReturnType<typeof getTurbo>,
  data: Buffer,
  contentType: string,
): Promise<string> {
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

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`transcode-gif:${ip}`, 5, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const address = await getSessionAddress(req)
  if (!address) return errorResponse(401, 'Sign in to continue')

  let body: { gifUri?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid JSON')
  }
  const gifUri = body.gifUri
  // Restrict to the content URIs we recognize — closes data:/file:/etc.
  if (!gifUri || (!gifUri.startsWith('ar://') && !gifUri.startsWith('ipfs://') && !gifUri.startsWith('https://'))) {
    return errorResponse(400, 'gifUri must be ar://, ipfs://, or https://')
  }

  if (active >= MAX_CONCURRENT) {
    return errorResponse(503, 'Transcoder busy — try again shortly')
  }
  active++
  try {
    const gif = await fetchGif(gifUri)
    const { mp4, poster, thumbhash } = await transcodeGifToMp4Node(gif)

    // Debit the platform upload budget for the bytes we're about to store.
    const withinQuota = await consumeUserQuota('upload-bytes', address, mp4.byteLength + poster.byteLength)
    if (!withinQuota) {
      return errorResponse(429, 'Daily upload size limit reached — try again tomorrow')
    }

    const turbo = getTurbo()
    const [animationUri, posterUri] = await Promise.all([
      turboUpload(turbo, mp4, 'video/mp4'),
      turboUpload(turbo, poster, 'image/jpeg'),
    ])

    // Block on propagation before returning so the caller can write these
    // URIs into metadata without the 404-at-index race the mint flow
    // otherwise guards against.
    const [animOk, posterOk] = await Promise.all([
      verifyArweaveAvailable(animationUri, 90_000),
      verifyArweaveAvailable(posterUri, 90_000),
    ])
    if (!animOk || !posterOk) {
      return errorResponse(502, 'Arweave still settling — try again in a minute')
    }

    return NextResponse.json({ animationUri, posterUri, thumbhash })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transcode failed'
    console.error(`[transcode-gif] ${message} | gifUri: ${gifUri}`)
    return errorResponse(500, message)
  } finally {
    active--
  }
}
