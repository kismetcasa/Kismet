import { NextRequest, NextResponse } from 'next/server'
import { parseAbi } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { getChain, isSupportedChainId } from '@/lib/chains'
import { serverClient } from '@/lib/rpc'
import { ZORA_1155_TOKEN_INFO_ABI, ZORA_CREATOR_REWARD_RECIPIENT_ABI } from '@/lib/zoraMint'
import {
  SPLIT_MAIN_ABI,
  splitMainAddress,
  reconstructSplitParams,
  DISTRIBUTOR_FEE,
} from '@/lib/splitMain'
import { setStoredSplits, validateSplitsArray, type SplitRecipient } from '@/lib/splits'
import { setMomentMeta } from '@/lib/notifications'
import { isBlacklisted } from '@/lib/blacklist'
import { isPlatformPaused } from '@/lib/gate'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

const ERC1155_BALANCE_ABI = parseAbi([
  'function balanceOf(address account, uint256 id) view returns (uint256)',
])

/**
 * Records a USER-PAID mainnet mint into our KV — the off-chain half the
 * In Process relay performs for Base mints (which this route deliberately
 * rejects, so the two recording paths never overlap). The on-chain mint has
 * already happened client-side (hooks/useClientMint); this only writes
 * moment-meta + the stored split list, after verifying on-chain that the mint
 * is real. No transaction is submitted here.
 *
 * Trust model: nothing is taken on faith. We confirm the token exists and the
 * claimed creator holds the admin-minted copy, and we store splits only when
 * the on-chain creator-reward recipient matches the split derived from the
 * posted recipients. Blacklist + pause are enforced as the user-paid path's
 * only moderation point (we can't unmint a permissionless tx, but we can
 * refuse to surface it).
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`mint-record:${ip}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  let body: {
    collectionAddress?: string
    tokenId?: string
    chainId?: number
    creator?: string
    name?: string
    durationSec?: number
    splits?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const { collectionAddress, tokenId, creator } = body
  const chainId = Number(body.chainId)
  const name = typeof body.name === 'string' ? body.name.trim() : ''

  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'valid collectionAddress required')
  }
  if (!isValidTokenId(tokenId)) return errorResponse(400, 'valid tokenId required')
  if (!creator || !isAddress(creator)) return errorResponse(400, 'valid creator required')
  if (!name) return errorResponse(400, 'name required')
  if (!isSupportedChainId(chainId)) return errorResponse(400, 'unsupported chainId')
  // Base records itself via the relay; this route is user-paid chains only.
  if (getChain(chainId).sponsoredMint) {
    return errorResponse(400, 'this chain records via the sponsored relay')
  }

  if (await isBlacklisted(creator)) return errorResponse(403, 'Not authorized')
  if (await isPlatformPaused()) return errorResponse(403, 'Minting is paused')

  const client = serverClient(chainId)

  // Verify the mint is real on-chain: the token exists and the creator holds
  // the copy adminMint sent them. Blocks phantom / misattributed records.
  try {
    const [info, balance] = await Promise.all([
      client.readContract({
        address: collectionAddress,
        abi: ZORA_1155_TOKEN_INFO_ABI,
        functionName: 'getTokenInfo',
        args: [BigInt(tokenId)],
      }),
      client.readContract({
        address: collectionAddress,
        abi: ERC1155_BALANCE_ABI,
        functionName: 'balanceOf',
        args: [creator as `0x${string}`, BigInt(tokenId)],
      }),
    ])
    if (!(info as { uri?: string }).uri) return errorResponse(400, 'token does not exist on-chain')
    if ((balance as bigint) <= 0n) return errorResponse(403, 'creator does not hold this token')
  } catch {
    return errorResponse(502, 'Could not verify the mint on-chain')
  }

  // Splits (optional): store only if the on-chain creator-reward recipient
  // matches the split predicted from the posted recipients. distribute re-checks
  // this on-chain too, so this is defense-in-depth against a bogus list.
  let validSplits: SplitRecipient[] | null = null
  if (body.splits !== undefined) {
    const v = validateSplitsArray(body.splits)
    if (!v.ok) return errorResponse(400, `invalid splits: ${v.error}`)
    try {
      const { accounts, percentAllocations } = reconstructSplitParams(v.splits)
      const [predicted, onchain] = await Promise.all([
        client.readContract({
          address: splitMainAddress(chainId),
          abi: SPLIT_MAIN_ABI,
          functionName: 'predictImmutableSplitAddress',
          args: [accounts, percentAllocations, DISTRIBUTOR_FEE],
        }),
        client.readContract({
          address: collectionAddress,
          abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
          functionName: 'getCreatorRewardRecipient',
          args: [BigInt(tokenId)],
        }),
      ])
      if ((predicted as string).toLowerCase() !== (onchain as string).toLowerCase()) {
        return errorResponse(400, 'splits do not match the on-chain split')
      }
      validSplits = v.splits
    } catch {
      return errorResponse(502, 'Could not verify splits on-chain')
    }
  }

  const durationSec =
    typeof body.durationSec === 'number' && Number.isFinite(body.durationSec) && body.durationSec > 0
      ? body.durationSec
      : undefined

  await Promise.all([
    setMomentMeta(collectionAddress, tokenId as string, {
      creator,
      name,
      ...(durationSec ? { durationSec } : {}),
    }),
    ...(validSplits ? [setStoredSplits(collectionAddress, tokenId as string, validSplits)] : []),
  ])

  return NextResponse.json({ ok: true })
}
