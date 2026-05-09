import { NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { getTrackedCollections } from '@/lib/kv'
import { serverBaseClient } from '@/lib/rpc'
import { findMintableCollections } from '@/lib/findMintableCollections'

// GET /api/collections/mintable?address=0x… — returns the subset of
// our tracked collections where this address holds MINTER (or ADMIN)
// at the collection-wide row. Used by the Airdrop tab to surface
// moments authorized minters can airdrop into — inprocess's
// /timeline?airdroppable=… filter only matches per-token ADMIN
// delegations, missing collection-wide MINTER, which is the exact
// shape our "Authorize minters" panel produces.
//
// Public read — the underlying chain logs are public anyway. We
// scope to KV-tracked collections so a flood of unrelated contracts
// doesn't blow out the getLogs query. No server-side cache: a stale
// response would hide newly-granted authorizations from the user
// who just received them. MintTabs.fetchMoments has a 5s client-side
// coalescing window which is sufficient for the typical hover/click
// pattern.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')
  if (!address || !isAddress(address)) {
    return NextResponse.json(
      { error: 'address required' },
      { status: 400 },
    )
  }
  try {
    const tracked = await getTrackedCollections()
    if (tracked.length === 0) {
      return NextResponse.json({ collections: [] })
    }
    const client = serverBaseClient()
    const mintable = await findMintableCollections(
      client,
      tracked as Address[],
      address as Address,
    )
    return NextResponse.json({ collections: mintable })
  } catch (err) {
    console.error('[collections/mintable] error', {
      address,
      err: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ collections: [] }, { status: 200 })
  }
}
