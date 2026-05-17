import { NextRequest, NextResponse, after } from 'next/server'
import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { getSessionAddress } from '@/lib/session'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { serverBaseClient } from '@/lib/rpc'
import { resolveSmartWallet } from '@/lib/resolveSmartWallet'
import {
  addAuthorizedCreator,
  removeAuthorizedCreator,
  getAuthorizedCreators,
  getCollectionMeta,
  type AuthorizedCreator,
} from '@/lib/kv'
import { writeNotification } from '@/lib/notifications'
import { errorResponse } from '@/lib/apiResponse'

// GET /api/collection/authorized-creators?collection=0x… — returns the
// EOA → smart-wallet mappings recorded by our panel at grant time. KV
// is the source of truth for grants made through this UI; off-platform
// addPermission writes (etherscan, foundry) won't surface here. That's
// an accepted tradeoff: scanning every UpdatedPermissions log from
// genesis hits eth_getLogs block-range caps on most non-paid RPCs, and
// the off-platform case is a power-user edge that doesn't justify the
// dependency. Admins who need to revoke an unmapped grant can do it
// from etherscan directly.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collection = searchParams.get('collection')
  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  const creators = await getAuthorizedCreators(collection)
  return NextResponse.json({ creators })
}

interface PostBody {
  collection?: string
  /** EOA the admin authorized — what they typed (or the address an
   *  ENS name resolved to client-side). */
  eoa?: string
  /** Pre-resolved smart wallet for `eoa`. Server re-resolves to verify
   *  the client didn't fabricate a mapping. */
  smartWallet?: string
  /** Optional ENS / display label captured at grant time. */
  label?: string
}

// POST /api/collection/authorized-creators — record an EOA→smart-wallet
// mapping. Auth required; caller must hold ADMIN on-chain (same gate
// Zora enforces on addPermission). Server re-resolves the smart wallet
// to defeat a malicious client supplying a bogus mapping.
export async function POST(req: NextRequest) {
  const viewer = await getSessionAddress(req)
  if (!viewer) {
    return errorResponse(401, 'Sign in to continue')
  }

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const { collection, eoa, smartWallet, label } = body
  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (!eoa || !isAddress(eoa)) {
    return errorResponse(400, 'Invalid eoa')
  }
  if (!smartWallet || !isAddress(smartWallet)) {
    return errorResponse(400, 'Invalid smartWallet')
  }

  // 1. Caller must hold ADMIN on the collection.
  try {
    const client = serverBaseClient()
    const perms = await readPermissions(
      client,
      collection as Address,
      0n,
      viewer as Address,
    )
    if (!hasAdminBit(perms)) {
      return errorResponse(403, 'Only a collection admin can authorize creators')
    }
  } catch {
    return errorResponse(502, 'Could not verify collection admin on-chain')
  }

  // 2. Re-resolve the smart wallet for the supplied EOA — refuse if the
  //    client supplied a different smartWallet than inprocess returns.
  const expected = await resolveSmartWallet(eoa)
  if (!expected || expected.toLowerCase() !== smartWallet.toLowerCase()) {
    return errorResponse(400, 'eoa / smartWallet mismatch — re-resolve and retry')
  }

  const entry: AuthorizedCreator = {
    eoa: eoa.toLowerCase(),
    smartWallet: smartWallet.toLowerCase(),
    label: label?.trim() || undefined,
    grantedBy: viewer,
    grantedAt: Date.now(),
  }
  const ok = await addAuthorizedCreator(collection, entry)
  if (!ok) {
    return errorResponse(502, 'Failed to persist authorized-creator mapping; check server logs')
  }

  // Click-through routes to /collection/<addr>. On-chain addPermission is a
  // separate admin tx, so the copy hedges ("added you as a creator").
  after(async () => {
    try {
      const meta = await getCollectionMeta(collection)
      await writeNotification({
        type: 'authorized',
        recipient: eoa,
        actor: viewer,
        tokenAddress: collection,
        tokenName: meta?.name,
      })
    } catch {}
  })

  return NextResponse.json({ ok: true, creator: entry })
}

// DELETE /api/collection/authorized-creators?collection=…&eoa=… — drop a
// mapping. Same admin gate as POST; the on-chain revoke happens
// separately on the client (the admin signs a `removePermission` tx).
// We don't conflate the two: the chain is the source of truth for
// permissions, KV only carries the EOA-display reverse lookup.
export async function DELETE(req: NextRequest) {
  const viewer = await getSessionAddress(req)
  if (!viewer) {
    return errorResponse(401, 'Sign in to continue')
  }
  const { searchParams } = new URL(req.url)
  const collection = searchParams.get('collection')
  const eoa = searchParams.get('eoa')
  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (!eoa || !isAddress(eoa)) {
    return errorResponse(400, 'Invalid eoa')
  }
  try {
    const client = serverBaseClient()
    const perms = await readPermissions(
      client,
      collection as Address,
      0n,
      viewer as Address,
    )
    if (!hasAdminBit(perms)) {
      return errorResponse(403, 'Only a collection admin can revoke creators')
    }
  } catch {
    return errorResponse(502, 'Could not verify collection admin on-chain')
  }
  await removeAuthorizedCreator(collection, eoa)
  return NextResponse.json({ ok: true })
}
