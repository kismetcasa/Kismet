import { NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { getSessionAddress } from '@/lib/session'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { serverBaseClient } from '@/lib/rpc'
import {
  addAirdropDelegate,
  removeAirdropDelegate,
  getAirdropDelegates,
} from '@/lib/airdropDelegates'
import { errorResponse } from '@/lib/apiResponse'

// Airdrop delegation records — who a collection admin has authorized to
// airdrop a specific moment. KV is a discovery hint only; the on-chain
// MINTER grant + Zora's adminMint gate are the real authority, and the
// timeline re-verifies on-chain before surfacing (lib/airdropDelegates).
//
// Writes are gated anyway (anti-pollution): the caller must hold ADMIN over
// the piece — the same scope Zora requires to addPermission for that token,
// i.e. ADMIN at tokenId 0 (collection-wide) OR at the specific tokenId.

async function requirePieceAdmin(
  req: NextRequest,
  collection: string,
  tokenId: string,
): Promise<NextResponse | null> {
  const viewer = await getSessionAddress(req)
  if (!viewer) return errorResponse(401, 'Sign in to continue')
  try {
    const client = serverBaseClient()
    const [collPerms, tokenPerms] = await Promise.all([
      readPermissions(client, collection as Address, 0n, viewer as Address),
      readPermissions(
        client,
        collection as Address,
        BigInt(tokenId),
        viewer as Address,
      ),
    ])
    if (!hasAdminBit(collPerms | tokenPerms)) {
      return errorResponse(403, 'Only a collection admin can delegate airdrops')
    }
  } catch {
    return errorResponse(502, 'Could not verify collection admin on-chain')
  }
  return null
}

// GET ?collection=&tokenId= — list the delegates recorded on a moment.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collection = searchParams.get('collection')
  const tokenId = searchParams.get('tokenId')
  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (!tokenId || !isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }
  const delegates = await getAirdropDelegates(collection, tokenId)
  return NextResponse.json(
    { delegates },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

interface PostBody {
  collection?: string
  tokenId?: string
  delegate?: string
}

// POST { collection, tokenId, delegate } — record a delegation. The admin
// signs the on-chain MINTER grant separately (client-side); this only writes
// the discovery record so the delegate's picker can surface the piece (a
// MINTER grant isn't in inprocess's ADMIN-only admins[] index).
export async function POST(req: NextRequest) {
  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  const { collection, tokenId, delegate } = body
  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (!tokenId || !isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }
  if (!delegate || !isAddress(delegate)) {
    return errorResponse(400, 'Invalid delegate address')
  }
  const denied = await requirePieceAdmin(req, collection, tokenId)
  if (denied) return denied
  await addAirdropDelegate(collection, tokenId, delegate)
  return NextResponse.json({ ok: true })
}

// DELETE ?collection=&tokenId=&delegate= — drop a delegation. The on-chain
// removePermission happens separately on the client; the chain is the source
// of truth for authority, this only removes the discovery hint.
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collection = searchParams.get('collection')
  const tokenId = searchParams.get('tokenId')
  const delegate = searchParams.get('delegate')
  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (!tokenId || !isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }
  if (!delegate || !isAddress(delegate)) {
    return errorResponse(400, 'Invalid delegate address')
  }
  const denied = await requirePieceAdmin(req, collection, tokenId)
  if (denied) return denied
  await removeAirdropDelegate(collection, tokenId, delegate)
  return NextResponse.json({ ok: true })
}
