import { NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { getSessionAddress } from '@/lib/session'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { serverBaseClient } from '@/lib/rpc'
import { resolveSmartWallet } from '@/lib/resolveSmartWallet'
import { findAdminHoldersAtZero } from '@/lib/findMintableCollections'
import { OPERATOR_SMART_WALLET } from '@/lib/config'
import {
  addAuthorizedCreator,
  removeAuthorizedCreator,
  getAuthorizedCreators,
  type AuthorizedCreator,
} from '@/lib/kv'

// GET /api/collection/authorized-creators?collection=0x…[&deployer=0x…]
// — list every address with on-chain ADMIN at tokenId 0, hydrated with
// the EOA / label mapping our panel records at grant time. KV alone
// would miss off-platform grants (etherscan, foundry); chain alone
// would miss the human-readable label inprocess can't reverse-derive
// from a smart wallet. Merging surfaces the full picture.
//
// `deployer` is optional; when supplied, server resolves their inprocess
// smart wallet and excludes it (along with OPERATOR_SMART_WALLET) from
// the chain scan, since both are granted ADMIN at deploy via setupActions
// and would otherwise pollute the list. Without `deployer` the chain
// merge is skipped — we fall back to KV-only.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collection = searchParams.get('collection')
  const deployer = searchParams.get('deployer')
  if (!collection || !isAddress(collection)) {
    return NextResponse.json({ error: 'Invalid collection address' }, { status: 400 })
  }
  const kvCreators = await getAuthorizedCreators(collection)

  if (!deployer || !isAddress(deployer)) {
    return NextResponse.json({ creators: kvCreators })
  }

  try {
    // Best-effort resolve of the deployer's SW so we can exclude it
    // from the chain scan. If inprocess is unreachable we fall through
    // with just the EOA + operator excluded — Alice's SW may then
    // surface as a row, which is better UX than an empty list when
    // there are real delegated grants.
    const deployerSw = await resolveSmartWallet(deployer)
    if (!deployerSw) {
      console.warn(
        '[authorized-creators GET] could not resolve deployer SW; chain merge will run without SW exclude',
        { deployer, collection },
      )
    }
    // Filter out the deployer (constructor-set ADMIN doesn't emit, but
    // a redundant self-addPermission could), their smart wallet
    // (granted via setupActions when resolvable), and the operator
    // smart wallet (also setupActions). Anything left is a real
    // delegated grant.
    const exclude: Address[] = [deployer as Address]
    if (deployerSw && isAddress(deployerSw)) {
      exclude.push(deployerSw as Address)
    }
    if (OPERATOR_SMART_WALLET && isAddress(OPERATOR_SMART_WALLET)) {
      exclude.push(OPERATOR_SMART_WALLET as Address)
    }
    const client = serverBaseClient()
    const chainHolders = await findAdminHoldersAtZero(
      client,
      collection as Address,
      exclude,
    )
    // Dedup by both SW and EOA — the creator-tier grant lands ADMIN
    // on both targets, so the chain scan returns both. Without
    // matching the EOA path we'd surface the same person twice.
    const kvKeys = new Set<string>()
    for (const c of kvCreators) {
      kvKeys.add(c.smartWallet.toLowerCase())
      if (c.eoa) kvKeys.add(c.eoa.toLowerCase())
    }
    // Synthesize chain-only entries (no KV reverse-lookup) so the panel
    // can still surface them. UI renders these as "(unmapped)" with the
    // raw smart wallet — admin sees they exist and can revoke.
    const merged: AuthorizedCreator[] = [...kvCreators]
    for (const addr of chainHolders) {
      const lower = addr.toLowerCase()
      if (kvKeys.has(lower)) continue
      merged.push({
        eoa: undefined,
        smartWallet: lower,
        label: undefined,
        grantedBy: '',
        grantedAt: 0,
      })
    }
    return NextResponse.json({ creators: merged })
  } catch (err) {
    console.error('[authorized-creators GET] chain merge failed', {
      collection,
      err: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ creators: kvCreators })
  }
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
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })
  }

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { collection, eoa, smartWallet, label } = body
  if (!collection || !isAddress(collection)) {
    return NextResponse.json({ error: 'Invalid collection address' }, { status: 400 })
  }
  if (!eoa || !isAddress(eoa)) {
    return NextResponse.json({ error: 'Invalid eoa' }, { status: 400 })
  }
  if (!smartWallet || !isAddress(smartWallet)) {
    return NextResponse.json({ error: 'Invalid smartWallet' }, { status: 400 })
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
      return NextResponse.json(
        { error: 'Only a collection admin can authorize creators' },
        { status: 403 },
      )
    }
  } catch {
    return NextResponse.json(
      { error: 'Could not verify collection admin on-chain' },
      { status: 502 },
    )
  }

  // 2. Re-resolve the smart wallet for the supplied EOA — refuse if the
  //    client supplied a different smartWallet than inprocess returns.
  const expected = await resolveSmartWallet(eoa)
  if (!expected || expected.toLowerCase() !== smartWallet.toLowerCase()) {
    return NextResponse.json(
      { error: 'eoa / smartWallet mismatch — re-resolve and retry' },
      { status: 400 },
    )
  }

  const entry: AuthorizedCreator = {
    eoa: eoa.toLowerCase(),
    smartWallet: smartWallet.toLowerCase(),
    label: label?.trim() || undefined,
    grantedBy: viewer,
    grantedAt: Date.now(),
  }
  await addAuthorizedCreator(collection, entry)
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
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })
  }
  const { searchParams } = new URL(req.url)
  const collection = searchParams.get('collection')
  const eoa = searchParams.get('eoa')
  if (!collection || !isAddress(collection)) {
    return NextResponse.json({ error: 'Invalid collection address' }, { status: 400 })
  }
  if (!eoa || !isAddress(eoa)) {
    return NextResponse.json({ error: 'Invalid eoa' }, { status: 400 })
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
      return NextResponse.json(
        { error: 'Only a collection admin can revoke creators' },
        { status: 403 },
      )
    }
  } catch {
    return NextResponse.json(
      { error: 'Could not verify collection admin on-chain' },
      { status: 502 },
    )
  }
  await removeAuthorizedCreator(collection, eoa)
  return NextResponse.json({ ok: true })
}
