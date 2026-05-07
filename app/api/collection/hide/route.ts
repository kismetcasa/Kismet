import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { base } from 'viem/chains'
import { getSessionAddress } from '@/lib/session'
import {
  hideCollection,
  unhideCollection,
  isCollectionHidden,
} from '@/lib/hiddenCollections'

// Same on-chain ADMIN check used by /api/collections POST. tokenId 0 is the
// collection-wide permission row in Zora 1155; PERMISSION_BIT_ADMIN = 2.
const PERMISSION_BIT_ADMIN = 2n

const COLLECTION_PERMISSIONS_ABI = [
  {
    name: 'permissions',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'user', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

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
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })
  }

  let body: HideBody
  try {
    body = (await req.json()) as HideBody
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { address, hidden } = body
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'Invalid collection address' }, { status: 400 })
  }
  if (typeof hidden !== 'boolean') {
    return NextResponse.json({ error: 'hidden must be a boolean' }, { status: 400 })
  }

  try {
    const client = createPublicClient({ chain: base, transport: http() })
    const perms = (await client.readContract({
      address: address as Address,
      abi: COLLECTION_PERMISSIONS_ABI,
      functionName: 'permissions',
      args: [0n, viewer as Address],
    })) as bigint
    const isAdmin = (perms & PERMISSION_BIT_ADMIN) === PERMISSION_BIT_ADMIN
    if (!isAdmin) {
      return NextResponse.json(
        { error: 'Only a collection admin can hide it' },
        { status: 403 },
      )
    }
  } catch {
    return NextResponse.json(
      { error: 'Could not verify collection admin on-chain' },
      { status: 502 },
    )
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
    return NextResponse.json({ error: 'Invalid query params' }, { status: 400 })
  }
  const hidden = await isCollectionHidden(address)
  return NextResponse.json({ hidden })
}
