import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { getStoredSplits, setStoredSplits } from '@/lib/splits'
import { resolveSplitRecipientsOnChain } from '@/lib/splitsResolver'
import { serverBaseClient } from '@/lib/rpc'
import { ZORA_CREATOR_REWARD_RECIPIENT_ABI } from '@/lib/zoraMint'

// Returns { hasSplits, recipients } for a single moment.
// `hasSplits` gates the creator-only distribute UI in useMomentSplits.
// Mints predating recipient persistence (legacy `'1'` flag) auto-resolve
// from on-chain SplitMain logs and write through to KV — first visit
// pays a couple of RPC calls, subsequent visits are cached.
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
