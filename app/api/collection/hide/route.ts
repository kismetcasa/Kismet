import { NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { getSessionAddress } from '@/lib/session'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { serverBaseClient } from '@/lib/rpc'
import {
  hideCollection,
  unhideCollection,
  isCollectionHidden,
} from '@/lib/hiddenCollections'
import { errorResponse } from '@/lib/apiResponse'

interface HideBody {
  address?: string
  hidden?: boolean
}

// POST /api/collection/hide — toggle a collection's visibility. Auth required;
// caller must hold the on-chain ADMIN permission bit on the collection (same
// gate Zora itself uses for setSale/addPermission). Matches the auth model
// of /api/collections POST.
export async function POST(req: NextRequest) {
  const viewer = await getSessionAddress(req)
  if (!viewer) {
    return errorResponse(401, 'Sign in to continue')
  }

  let body: HideBody
  try {
    body = (await req.json()) as HideBody
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const { address, hidden } = body
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (typeof hidden !== 'boolean') {
    return errorResponse(400, 'hidden must be a boolean')
  }

  try {
    // tokenId 0 is the collection-wide permission row in Zora 1155;
    // defaultAdmin lives there. readPermissions retries 4× on RPC blip
    // and includes a runtime bigint guard against ABI drift.
    const client = serverBaseClient()
    const perms = await readPermissions(client, address as Address, 0n, viewer as Address)
    if (!hasAdminBit(perms)) {
      return errorResponse(403, 'Only a collection admin can hide it')
    }
  } catch {
    return errorResponse(502, 'Could not verify collection admin on-chain')
  }

  if (hidden) {
    await hideCollection(address)
  } else {
    await unhideCollection(address)
  }

  return NextResponse.json({ hidden })
}

// GET /api/collection/hide?address=… — public read. UIs use it to seed the
// toggle's initial state without an extra round-trip on every page render.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'Invalid query params')
  }
  const hidden = await isCollectionHidden(address)
  return NextResponse.json({ hidden })
}
