import { NextRequest, NextResponse } from 'next/server'
import { decodeEventLog, parseAbi, type Hex } from 'viem'
import { isAddress } from '@/lib/address'
import { recordAirdrop } from '@/lib/airdrops'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { serverBaseClient } from '@/lib/rpc'

/**
 * Admin recovery endpoint: re-records a missed airdrop for a sender whose
 * /api/airdrop/notify call failed silently (on-chain mint landed but the
 * Redis record was never written). Bypasses idempotency and quota — intended
 * for one-off support cases where the sender can provide their txHash.
 *
 * POST body: { txHash, sender, collectionAddress, tokenId }
 *
 * The endpoint verifies the tx on-chain (same TransferSingle logic as the
 * main notify route) before writing anything, so it can't be abused to forge
 * records for txns the sender wasn't the operator of.
 */

const ERC1155_TRANSFER_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
])

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export async function POST(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    txHash?: string
    sender?: string
    collectionAddress?: string
    tokenId?: string | number
  } | null

  if (!body) return errorResponse(400, 'Invalid body')

  const txHash = body.txHash
  const sender = body.sender?.toLowerCase()
  const collectionAddress = body.collectionAddress?.toLowerCase()
  const rawTokenId = body.tokenId !== undefined && body.tokenId !== null ? String(body.tokenId) : null

  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return errorResponse(400, 'Invalid txHash')
  }
  if (!sender || !isAddress(sender)) {
    return errorResponse(400, 'Invalid sender')
  }
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!rawTokenId || !/^\d+$/.test(rawTokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }
  const tokenId = BigInt(rawTokenId).toString()

  let receipt
  try {
    receipt = await serverBaseClient().getTransactionReceipt({ hash: txHash as Hex })
  } catch (err) {
    return errorResponse(502, `Failed to fetch receipt: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (receipt.status !== 'success') {
    return errorResponse(400, 'Transaction did not succeed on-chain')
  }

  const expectedTokenId = BigInt(tokenId)
  const recipients = new Set<string>()
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== collectionAddress) continue
    let decoded
    try {
      decoded = decodeEventLog({
        abi: ERC1155_TRANSFER_ABI,
        data: log.data,
        topics: log.topics,
      })
    } catch {
      continue
    }
    const { operator, from, to, id } = decoded.args
    if (operator.toLowerCase() !== sender) continue
    if (from !== ZERO_ADDRESS) continue
    if (id !== expectedTokenId) continue
    recipients.add(to.toLowerCase())
  }

  if (recipients.size === 0) {
    return errorResponse(400, 'No matching TransferSingle events found — verify sender, collection, and tokenId')
  }

  const timestamp = Date.now()
  const results = await Promise.all(
    Array.from(recipients).map(async (recipient) => {
      try {
        await recordAirdrop(sender, {
          collectionAddress,
          tokenId,
          recipient: { address: recipient },
          amount: 1,
          txHash,
          timestamp,
        })
        return { recipient, ok: true }
      } catch (err) {
        return { recipient, ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )

  const recorded = results.filter((r) => r.ok).length
  return NextResponse.json({ ok: true, recorded, total: recipients.size, results })
}
