import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { CREATE_REFERRAL } from '@/lib/config'
import { generateTextCollectionCoverDataUri } from '@/lib/generateTextCover'
import { validateSplitsArray } from '@/lib/splits'
import { isBlacklisted } from '@/lib/blacklist'
import { getGateConfig, getPassCollectionName, hasGateAccess, isPlatformPausedFor } from '@/lib/gate'
import { consumeUserQuota } from '@/lib/userQuota'
import { checkSmartWalletAdmin } from '@/lib/smartWalletPreflight'
import { issueIntentNonce } from '@/lib/intentAuth'
import { ingestMintMedia, type MediaKind } from '@/lib/agent/mintMedia'
import { uploadBytesToArweave, uploadJsonToArweave } from '@/lib/arweave/uploadServer'
import { buildMomentMetadata, buildMintEnvelope, type MintMediaKind, type MintParams } from '@/lib/agent/mint'
import type { AgentActionEnvelope } from '@/lib/agent/types'

export const runtime = 'nodejs'

/**
 * Prepare a "mint" (create a new moment) for an AI agent to execute via Base
 * MCP's `sign`. UNLIKE the other prepare endpoints, this one is NOT a pure inert
 * read: creating a moment means hosting its media + metadata on Arweave (billed
 * to the platform ARWEAVE_JWK), so the artifact isn't free to produce. The
 * inert-artifact safety model the collect/buy/list prepares rely on is therefore
 * replaced here by the SAME authorization the app mint enforces before it spends:
 *   - Pass gate  (hasGateAccess) — only eligible artists can mint
 *   - blacklist / platform-pause — same emergency stops as /api/mint
 *   - per-address upload-bytes quota — bounds Arweave spend per identity
 *   - a platform-wide daily ceiling — the Sybil backstop the per-identity quota
 *     structurally can't provide (mirrors /api/sign's PLATFORM_SIGN_DAILY_CAP)
 * The returned envelope is still inert in the money sense: it's an unsigned
 * EIP-712 `MintIntent`. Nothing is minted until the artist signs it and the
 * signed body is POSTed to /api/mint (media) or /api/write (text), where the
 * signature is re-verified against the exact body and every gate/quota runs
 * again. This endpoint just does the one thing a server must do for an assistant
 * that a browser does for the app: ingest the media and upload it.
 *
 * POST-only, on purpose: unlike the inert read-prepares (collect/buy/list), which
 * expose a GET variant for Base MCP's chat-only GET-paste rung, this endpoint
 * SPENDS. A GET that spends is passively triggerable cross-site (an `<img>`/
 * prefetch on any page could fire it from a victim's browser to burn platform
 * Arweave credit), so mint is not on the GET rung — a minting assistant already
 * holds the media locally and POSTs it as a data: URI.
 *
 * The mint reuses the app's builders verbatim (lib/agent/mint) — same
 * salesConfig, metadata shape, CREATE_REFERRAL, MintIntent typed data — so there
 * is zero drift between minting in the Kismet app and minting from an assistant.
 * App defaults apply (free, ETH, open edition, artist keeps a copy).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return errorResponse(400, 'Invalid body')
  return prepareMint(req, body)
}

// Fixed byte overhead debited on top of the media bytes to cover the metadata
// JSON (and, on auto-deploy, the collection JSON) we upload. Both are small
// (name/description/URIs) but a maximal text auto-deploy uploads two docs each
// carrying the description + an inline SVG cover, so this is a flat approximation,
// not a hard ceiling — the per-identity byte quota and the platform-wide daily
// cap are the real spend bounds; this just keeps the byte meter honest.
const JSON_OVERHEAD_BYTES = 16 * 1024
// Platform-wide daily ceiling on prepare-mint operations — the durable Sybil
// backstop the per-identity upload-bytes quota can't provide (each identity gets
// its own bucket, so N addresses multiply the per-user cap). Bounds TOTAL
// Arweave spend from this unauthenticated endpoint regardless of address/IP
// rotation. Day-bucketed, fail-open on Redis error (same policy as the limiter),
// tuned via PLATFORM_MINT_DAILY_CAP. Mirrors /api/sign's sign-global ceiling.
const PLATFORM_MINT_DAILY_CAP = Number(process.env.PLATFORM_MINT_DAILY_CAP) || 2000
// Match the app's writing-moment character cap (MintForm TEXT_MAX); mint-proxy's
// 10 MB byte cap is the backstop, this is the friendlier front-line limit.
const TEXT_MAX = 5000
const NAME_MAX = 200
const DESCRIPTION_MAX = 5000

const firstString = (...vals: unknown[]): string =>
  (vals.find((v) => typeof v === 'string' && v.trim().length > 0) as string | undefined)?.trim() ?? ''

function normalizeKind(raw: unknown): MintMediaKind | null {
  if (typeof raw !== 'string') return null
  const k = raw.trim().toLowerCase()
  return k === 'image' || k === 'video' || k === 'text' ? k : null
}

async function prepareMint(req: NextRequest, body: Record<string, unknown>) {
  if (!(await checkRateLimit(`agent-prepare-mint:${getClientIp(req)}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  // ── validate identity + core inputs (all cheap, before any network/spend) ──
  const account = typeof body.account === 'string' ? body.account : ''
  if (!isAddress(account)) {
    return errorResponse(400, 'Invalid account — pass the Base Account address from get_wallets')
  }

  const name = firstString(body.name, body.title).slice(0, NAME_MAX)
  if (!name) return errorResponse(400, 'name is required — the title of the moment')
  const description = firstString(body.description).slice(0, DESCRIPTION_MAX)

  const explicitKind = normalizeKind(body.mediaType ?? body.kind)
  const media = firstString(body.media, body.mediaUri)
  // `text`/`tokenContent` only — no `content` alias (it collides with media
  // "content" and MomentMetadata.content, and would silently route a media
  // caller who forgot `media` into a text moment).
  const text = firstString(body.text, body.tokenContent)
  const isText = explicitKind === 'text' || (!media && !!text)
  if (isText) {
    if (!text) return errorResponse(400, 'text is required for a writing moment')
    if (text.length > TEXT_MAX) return errorResponse(400, `text exceeds the ${TEXT_MAX}-character limit`)
  } else if (!media) {
    return errorResponse(400, 'media is required — a data: URI or an ar://|ipfs:// URI (or pass text for a writing moment)')
  }

  const price = firstString(body.price) || '0'
  if (!/^\d+(\.\d+)?$/.test(price)) {
    return errorResponse(400, 'price must be a non-negative decimal string like "0.01" (or "0" for free)')
  }
  const currency: 'eth' | 'usdc' = body.currency === 'usdc' ? 'usdc' : 'eth'
  if (body.currency !== undefined && body.currency !== 'eth' && body.currency !== 'usdc') {
    return errorResponse(400, 'currency must be "eth" or "usdc"')
  }

  let editions: number | undefined
  if (body.editions !== undefined && body.editions !== '' && body.editions !== null) {
    const n = Number(body.editions)
    if (!Number.isInteger(n) || n < 1) return errorResponse(400, 'editions must be a positive integer (omit for an open edition)')
    editions = n
  }

  // Artist keeps a copy by default (app default: mintToCreatorCount 1). Only an
  // explicit false / "false" / "0" disables it.
  const artistMint = !(body.artistMint === false || body.artistMint === 'false' || body.artistMint === '0')

  // Existing collection (address) vs auto-deploy (no collection → we create one
  // named after the moment, exactly like the app's default mint).
  const collection = firstString(body.collection, body.collectionAddress)
  if (collection && !isAddress(collection)) {
    return errorResponse(400, 'collection must be a valid contract address (omit it to auto-create a new collection)')
  }
  const collectionName = firstString(body.collectionName) || name

  const payoutRecipientRaw = firstString(body.payoutRecipient)
  if (payoutRecipientRaw && !isAddress(payoutRecipientRaw)) {
    return errorResponse(400, 'payoutRecipient must be a valid address')
  }
  const payoutRecipient = payoutRecipientRaw ? (payoutRecipientRaw as `0x${string}`) : undefined

  // Validate splits up front (before spending Arweave) so a malformed payout
  // array fails fast here rather than after upload at /api/mint. Same validator
  // mint-proxy runs. GET carries splits as a JSON string.
  let splits: unknown
  const rawSplits = typeof body.splits === 'string' && body.splits.trim() ? safeJson(body.splits) : body.splits
  if (Array.isArray(rawSplits) && rawSplits.length > 0) {
    const v = validateSplitsArray(rawSplits)
    if (!v.ok) return errorResponse(400, v.error)
    splits = v.splits
  }

  // ── authorization: the gate that replaces the inert-artifact model, run
  //    BEFORE any Arweave spend (mirrors mint-proxy's gate order). ──
  const targetForGate = collection || '0x0000000000000000000000000000000000000000'
  let blocked: boolean, paused: boolean, gateOk: boolean
  try {
    ;[blocked, paused, gateOk] = await Promise.all([
      isBlacklisted(account),
      isPlatformPausedFor(account),
      hasGateAccess(targetForGate, account),
    ])
  } catch (err) {
    return upstreamError(502, 'Could not check mint eligibility — try again', err, 'agent-prepare-mint')
  }
  if (blocked) return errorResponse(403, 'Address is blocked from minting')
  if (paused) return errorResponse(503, 'Platform is temporarily paused')
  if (!gateOk) {
    const config = await getGateConfig()
    const passName = config.passCollection ? await getPassCollectionName(config.passCollection) : null
    return errorResponse(403, `An artwork from ${passName ?? 'the required collection'} is required to mint`)
  }

  // Existing-collection preflight — BEFORE any Arweave spend. Minting into a
  // collection the artist's inprocess smart wallet doesn't have ADMIN on reverts
  // at /api/mint's gas estimation, so without this we'd upload the media, hand
  // back an intent, collect a signature — then dead-end. The app runs this same
  // guard before it uploads; mirror it (and mint-proxy's structured 403s) so the
  // assistant gets an actionable answer up front instead of a wasted mint.
  // Auto-deploy (no collection) skips it — inprocess provisions the wallet on
  // first mint — exactly as mint-proxy does. 'unknown' (flaky RPC) falls through:
  // /api/mint re-runs the check and is the authority, so a transient blip never
  // blocks a legitimately-authorized artist.
  if (collection) {
    const preflight = await checkSmartWalletAdmin(account, collection, [0n])
    if (preflight.status === 'no_account') {
      return NextResponse.json(
        {
          code: 'NO_ACCOUNT',
          error:
            "This wallet has no Kismet creator account yet, so it can't mint into an existing collection. Mint your first moment without a collection (we'll create one) to set up your account, then mint into existing collections.",
          collectionAddress: collection,
        },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    if (preflight.status === 'unauthorized') {
      return NextResponse.json(
        {
          code: 'AUTHORIZE_REQUIRED',
          error:
            "This collection hasn't authorized Kismet for minting. Grant Kismet minter access to this collection once (from the Kismet app), then mint here.",
          collectionAddress: collection,
          smartWallet: preflight.smartWallet,
          perms: preflight.perms,
        },
        { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
  }

  // Platform-wide daily cap — the Sybil backstop, checked right before we spend.
  // The per-identity byte quota below can't bound aggregate abuse (each address
  // is its own bucket); this ceiling bounds TOTAL platform Arweave spend from
  // this unauthenticated endpoint. Fails open on Redis error, same as the limiter.
  const dayBucket = new Date().toISOString().slice(0, 10)
  if (!(await checkRateLimit(`agent-mint-global:${dayBucket}`, PLATFORM_MINT_DAILY_CAP, 24 * 60 * 60))) {
    return errorResponse(429, 'Daily platform mint capacity reached — please try again later')
  }

  // ── ingest media (data: bytes or ar://|ipfs:// passthrough — no remote fetch) ──
  const kind: MintMediaKind = isText ? 'text' : (explicitKind === 'image' || explicitKind === 'video' ? explicitKind : 'image')
  let mediaUri: string | undefined
  let posterUri: string | undefined
  let mediaMime: string | undefined
  let mediaBytes = 0
  let resolvedKind: MintMediaKind = kind

  if (!isText) {
    const declared: MediaKind | undefined = kind === 'video' ? 'video' : kind === 'image' ? 'image' : undefined
    const ingested = ingestMintMedia(media, declared)
    if ('error' in ingested) return errorResponse(400, ingested.error)
    resolvedKind = ingested.kind // authoritative kind from the actual mime
    mediaMime = ingested.mime
    if (ingested.bytes) mediaBytes += ingested.bytes.length

    // Optional video poster: an already-permanent URI or a data: URI. Browser-
    // canvas poster extraction isn't reproducible server-side, so the poster is
    // caller-supplied (optional).
    const poster = firstString(body.poster, body.posterUri)
    let posterBytesBuf: Buffer | undefined
    let posterMime = 'image/png'
    if (resolvedKind === 'video' && poster) {
      const ip = ingestMintMedia(poster, 'image')
      if ('error' in ip) return errorResponse(400, `poster: ${ip.error}`)
      if (ip.kind !== 'image') return errorResponse(400, 'poster must be an image')
      if (ip.passthroughUri) posterUri = ip.passthroughUri
      else if (ip.bytes) { posterBytesBuf = ip.bytes; posterMime = ip.mime; mediaBytes += ip.bytes.length }
    }

    // Debit the Arweave spend BEFORE uploading. Media bytes + a flat JSON
    // allowance (metadata, and collection metadata on auto-deploy).
    const debit = mediaBytes + JSON_OVERHEAD_BYTES
    const within = await consumeUserQuota('upload-bytes', account, debit)
    if (!within) return errorResponse(429, 'Daily upload limit reached — try again tomorrow or use the Kismet app')

    try {
      mediaUri = ingested.passthroughUri ?? (await uploadBytesToArweave(ingested.bytes!, mediaMime))
      if (posterBytesBuf) posterUri = await uploadBytesToArweave(posterBytesBuf, posterMime)
    } catch (err) {
      return upstreamError(502, 'Media upload to Arweave failed — try again', err, 'agent-prepare-mint')
    }
  } else {
    // Text moment: no media bytes, just the metadata + collection JSON. Debit
    // the flat JSON allowance so text prepares are metered too.
    const within = await consumeUserQuota('upload-bytes', account, JSON_OVERHEAD_BYTES)
    if (!within) return errorResponse(429, 'Daily upload limit reached — try again tomorrow or use the Kismet app')
  }

  // ── build + upload token metadata (byte-for-byte the app's shape) ──
  const isAutoDeploy = !collection
  // Text moments have no uploaded image; give them the same generated SVG cover
  // the app uses so feed/marketplace cards render instead of a broken image.
  const textCover = resolvedKind === 'text' ? generateTextCollectionCoverDataUri(name) : undefined
  const metadata = buildMomentMetadata({
    name,
    description,
    kind: resolvedKind,
    mediaUri,
    posterUri,
    mime: mediaMime,
    coverUri: textCover,
  })

  let tokenMetadataURI: string
  let collectionUri: string | undefined
  try {
    tokenMetadataURI = await uploadJsonToArweave(metadata)
    if (isAutoDeploy) {
      // Auto-deploy: the moment's cover doubles as the collection cover (image
      // moment → its image; video → its poster; text → the generated cover).
      const collectionCover =
        resolvedKind === 'text' ? textCover : resolvedKind === 'video' ? posterUri : mediaUri
      const collectionMetadata = {
        name: collectionName,
        description,
        ...(collectionCover ? { image: collectionCover } : {}),
        createReferral: CREATE_REFERRAL,
      }
      collectionUri = await uploadJsonToArweave(collectionMetadata)
    }
  } catch (err) {
    return upstreamError(502, 'Metadata upload to Arweave failed — try again', err, 'agent-prepare-mint')
  }

  // ── issue the single-use nonce + assemble the signed intent envelope ──
  // Wrapped like the uploads above: issueIntentNonce is a Redis write and runs
  // AFTER the spend, so a blip here must surface as a 502 (spend already
  // incurred) rather than a bare 500.
  const params: MintParams = {
    account: account as `0x${string}`,
    kind: resolvedKind,
    tokenMetadataURI,
    ...(resolvedKind === 'text' ? { tokenContent: text } : {}),
    name,
    price,
    currency,
    editions,
    artistMint,
    ...(collection ? { collection } : { collectionName, collectionUri }),
    ...(payoutRecipient ? { payoutRecipient } : {}),
    ...(splits ? { splits } : {}),
  }

  let envelope: AgentActionEnvelope
  try {
    const { nonce, expiresAt } = await issueIntentNonce()
    envelope = buildMintEnvelope(params, nonce, expiresAt)
  } catch (err) {
    return upstreamError(502, 'Could not finalize the mint intent — try again', err, 'agent-prepare-mint')
  }
  return NextResponse.json(envelope, { headers: { 'Cache-Control': 'private, no-store' } })
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}
