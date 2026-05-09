import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { getStoredSplits, setStoredSplits } from '@/lib/splits'
import { resolveSplitRecipientsOnChain } from '@/lib/splitsResolver'
import { serverBaseClient } from '@/lib/rpc'
import { ZORA_CREATOR_REWARD_RECIPIENT_ABI } from '@/lib/zoraMint'

// Returns the splits state for a single moment.
//   { hasSplits, recipients }
// `hasSplits` gates the creator-only "distribute" UI in useMomentSplits.
// `recipients` is the per-recipient allocation list. Mints that pre-date
// recipient persistence (legacy `'1'` flag in KV) used to report empty
// recipients; we now auto-resolve them from the on-chain SplitMain log
// trail and write through to KV so subsequent calls hit the fast path.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')

  if (!collectionAddress || !tokenId) {
    return NextResponse.json({ error: 'collectionAddress and tokenId required' }, { status: 400 })
  }
  if (!isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!isValidTokenId(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }

  const stored = await getStoredSplits(collectionAddress, tokenId).catch(() => ({
    hasSplits: false,
    recipients: [],
  }))

  // Legacy moments stored as `'1'` (or written before recipient
  // persistence) report `hasSplits: true, recipients: []`. Try to
  // recover the recipient list from on-chain SplitMain logs and
  // write it back so the next visit doesn't re-pay the RPC cost.
  // Failure is silent — UI keeps showing nothing under "splits"
  // until either an admin backfills via /api/admin/splits or the
  // resolver succeeds on a later request.
  if (stored.hasSplits && stored.recipients.length === 0) {
    try {
      const client = serverBaseClient()
      const splitAddress = (await client.readContract({
        address: collectionAddress as Address,
        abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
        functionName: 'getCreatorRewardRecipient',
        args: [BigInt(tokenId)],
      })) as Address
      const resolved = await resolveSplitRecipientsOnChain(client, splitAddress)
      if (resolved && resolved.length >= 2) {
        await setStoredSplits(collectionAddress, tokenId, resolved).catch(() => {})
        stored.recipients = resolved
      }
    } catch (err) {
      console.error('[moment/splits] auto-resolve failed', {
        collectionAddress,
        tokenId,
        err: err instanceof Error ? err.message : err,
      })
    }
  }

  return NextResponse.json(stored)
}
