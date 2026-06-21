import { NextResponse, type NextRequest } from 'next/server'
import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { getSessionAddress } from '@/lib/session'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { serverBaseClient } from '@/lib/rpc'
import { addTrackedCollection, getCollectionMeta } from '@/lib/kv'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Match the limits enforced client-side (and OpenSea's 1000-char collection
// description). The name is now stored on-chain via updateContractMetadata,
// so the cap also bounds calldata/storage gas, not just layout.
const MAX_NAME = 64
const MAX_DESCRIPTION = 1000

/**
 * POST /api/collection/update-meta — refresh the KV `CollectionMeta` fallback
 * after a successful on-chain `updateContractMetadata`. The chain + the
 * ContractURIUpdated event are authoritative (inprocess reindexes on its own
 * cadence); this only keeps the KV-fallback read paths (profile/artist feeds,
 * inprocess-down) from showing the stale name/image/description in the gap.
 *
 * Auth mirrors authorized-creators POST: a Kismet session AND on-chain ADMIN
 * at tokenId 0, so a session alone can't spoof a collection's KV record. The
 * write MERGES over the existing record so artist/coverTokenId aren't dropped.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`update-meta:${ip}`, 10, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const viewer = await getSessionAddress(req)
  if (!viewer) return errorResponse(401, 'Sign in to continue')

  let body: {
    address?: string
    name?: string
    description?: string
    image?: string
    kismet_thumbhash?: string
  }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const { address } = body
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'valid address required')
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return errorResponse(400, 'name required')
  if (name.length > MAX_NAME) {
    return errorResponse(400, `name must be ${MAX_NAME} characters or fewer`)
  }
  const description =
    typeof body.description === 'string' ? body.description.trim() : undefined
  if (description && description.length > MAX_DESCRIPTION) {
    return errorResponse(400, `description must be ${MAX_DESCRIPTION} characters or fewer`)
  }

  // Caller must hold ADMIN on-chain (tokenId 0 = collection-wide) — the same
  // authority the contract enforced on the edit tx. Closes the KV-spoof gap.
  try {
    const client = serverBaseClient()
    const perms = await readPermissions(client, address as Address, 0n, viewer as Address)
    if (!hasAdminBit(perms)) {
      return errorResponse(403, 'Only a collection admin can edit metadata')
    }
  } catch {
    return errorResponse(502, 'Could not verify collection admin on-chain')
  }

  // Merge over the existing record so deploy-time fields (artist, coverTokenId)
  // survive an edit that only touches name/description/image.
  const existing = await getCollectionMeta(address)
  const thumbhash = body.kismet_thumbhash ?? existing?.kismet_thumbhash
  await addTrackedCollection(
    address,
    {
      name,
      image: body.image ?? existing?.image,
      description,
      artist: existing?.artist ?? viewer.toLowerCase(),
      ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
      ...(existing?.coverTokenId ? { coverTokenId: existing.coverTokenId } : {}),
    },
    'create-form',
  )

  return NextResponse.json({ ok: true })
}
