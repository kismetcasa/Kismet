import { NextRequest, NextResponse } from 'next/server'
import { getAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { consumeUserQuota } from '@/lib/userQuota'
import { isBlacklisted } from '@/lib/blacklist'
import { holdsValidPass, isPlatformPausedFor } from '@/lib/gate'
import { CREATE_REFERRAL } from '@/lib/config'
import { ONE_OF_ONE_SALE } from '@/lib/creatorCopy'
import { buildMintBody, buildMomentMetadata } from '@/lib/agent/mint'
import { uploadBytesToArweave, uploadJsonToArweave } from '@/lib/arweave/uploadServer'
import { DROP_MEDIA_MAX_BYTES, isDropOpen, isEntityKey, normalizeEntityKey, settlementRecipients } from '@/lib/drops'
import { getDropDetail, getSettleProgress, isDropsEnabled, setSettleProgress } from '@/lib/dropsStore'
import { fetchFromSwarm } from '@/lib/swarm'

export const runtime = 'nodejs'

// The JSON the mint uploads besides the image: token + collection metadata.
const JSON_OVERHEAD_BYTES = 16 * 1024

/**
 * POST /api/drops/{key}/settle/prepare — step 1 of settling: build the mint
 * of the drop's edition, for the artist to sign as an ordinary MintIntent
 * and POST to /api/mint (the sponsored mint, with all its own gates).
 *
 * The edition is exactly the recipient list (every claim's owner plus the
 * artist's copy) and its sale is closed at creation (lib/creatorCopy
 * ONE_OF_ONE_SALE, the configuration 1/1s already mint with): nobody else can
 * mint it, so no claimer can be crowded out before the airdrop. The artwork
 * is copied from Swarm to Arweave here, because minted art is permanent.
 *
 * Artist-only (their own session), after the window closes, once. A repeat
 * call returns the same prepared body, so a cancelled signature never
 * uploads the artwork twice.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!(await checkRateLimit(`drops-settle:${getClientIp(req)}`, 10, 60))) return errorResponse(429, 'Too many requests')
  if (!isDropsEnabled()) return errorResponse(404, 'Not found')

  const { key: raw } = await params
  if (!isEntityKey(raw)) return errorResponse(400, 'Invalid drop key')
  const dropKey = normalizeEntityKey(raw)

  const session = await getSessionAddress(req)
  if (!session) return errorResponse(401, 'Sign in to continue')

  let detail
  try {
    detail = await getDropDetail(dropKey)
  } catch (err) {
    return upstreamError(503, 'Arkiv is unavailable — try again shortly', err, 'drops-settle')
  }
  if (!detail) return errorResponse(404, 'Drop not found — it may have expired')
  const { drop, claims, settlement } = detail
  if (session.toLowerCase() !== drop.artist) return errorResponse(403, 'Only the artist can settle this drop')
  if (isDropOpen(drop.closesAt, Math.floor(Date.now() / 1000))) return errorResponse(409, 'The drop is still open')
  if (settlement) return errorResponse(409, 'This drop is already delivered')
  if (claims.length === 0) return errorResponse(409, 'No claims — nothing to deliver')

  const existing = await getSettleProgress(dropKey)
  if (existing) {
    const minted = existing.minted ? { collection: existing.minted.collection, tokenId: existing.minted.tokenId } : null
    return NextResponse.json({ body: existing.body, recipients: existing.recipients, minted })
  }

  const [blocked, paused, hasPass] = await Promise.all([
    isBlacklisted(drop.artist),
    isPlatformPausedFor(drop.artist),
    holdsValidPass(drop.artist),
  ])
  if (blocked) return errorResponse(403, 'Address is blocked')
  if (paused) return errorResponse(503, 'Platform is temporarily paused')
  if (!hasPass) return errorResponse(403, 'A Kismet Pass is required to mint')

  const upstream = await fetchFromSwarm(drop.swarmRef)
  if (!upstream) return errorResponse(502, 'Swarm did not return the artwork — try again')
  const bytes = Buffer.from(await upstream.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > DROP_MEDIA_MAX_BYTES) return errorResponse(502, 'The artwork could not be read')

  if (!(await consumeUserQuota('upload-bytes', drop.artist, bytes.byteLength + JSON_OVERHEAD_BYTES))) {
    return errorResponse(429, 'Daily upload limit reached — try again tomorrow')
  }

  let tokenMetadataURI: string
  let collectionUri: string
  try {
    const mediaUri = await uploadBytesToArweave(bytes, drop.mime)
    tokenMetadataURI = await uploadJsonToArweave(
      buildMomentMetadata({ name: drop.title, description: drop.description, kind: 'image', mediaUri, mime: drop.mime }),
    )
    collectionUri = await uploadJsonToArweave({
      name: drop.title,
      description: drop.description,
      image: mediaUri,
      createReferral: CREATE_REFERRAL,
    })
  } catch (err) {
    return upstreamError(502, 'Upload to Arweave failed — try again', err, 'drops-settle')
  }

  const recipients = settlementRecipients(claims, drop.artist)
  const body = buildMintBody({
    account: getAddress(drop.artist),
    kind: 'image',
    tokenMetadataURI,
    name: drop.title,
    price: '0',
    currency: 'eth',
    editions: recipients.length,
    // The artist's copy rides the airdrop with the claims (and In Process
    // drops mintToCreatorCount whenever a supply is set — lib/creatorCopy).
    artistMint: false,
    collectionName: drop.title,
    collectionUri,
  }) as unknown as Record<string, unknown>
  ;(body.token as Record<string, unknown>).salesConfig = { ...ONE_OF_ONE_SALE }

  await setSettleProgress(dropKey, drop.closesAt, { body, recipients })
  return NextResponse.json({ body, recipients, minted: null })
}
