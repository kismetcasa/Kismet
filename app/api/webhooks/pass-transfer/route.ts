import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { errorResponse } from '@/lib/apiResponse'
import { getGateConfig } from '@/lib/gate'
import { processTransfer } from '@/lib/pass-validity'

export const runtime = 'nodejs'

const SIGNING_KEY = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY ?? ''

interface ActivityErc1155Metadata {
  tokenId?: string
  value?: string
}

interface Activity {
  fromAddress?: string
  toAddress?: string
  contractAddress?: string
  // ADDRESS_ACTIVITY uses `hash`; legacy NFT_ACTIVITY uses `transactionHash`
  hash?: string
  transactionHash?: string
  category?: string
  erc1155Metadata?: ActivityErc1155Metadata[]
  erc721TokenId?: string
  log?: { logIndex?: string }
}

// Alchemy webhook payload shapes:
//   ADDRESS_ACTIVITY (recommended for Base): { event: { activity: [...] } }
//   NFT_ACTIVITY (legacy):                   { events: [{ activity: {...} }] }
// We accept both so the runbook can choose either webhook type without
// breaking the indexer.
interface AlchemyWebhookPayload {
  event?: { activity?: Activity[] }
  events?: { activity?: Activity | Activity[] }[]
}

function verifySignature(rawBody: string, signature: string): boolean {
  if (!SIGNING_KEY || !signature) return false
  const expected = crypto.createHmac('sha256', SIGNING_KEY).update(rawBody).digest('hex')
  if (expected.length !== signature.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}

function hexToInt(hex: string | undefined): number {
  if (!hex) return 0
  return parseInt(hex, 16) || 0
}

function hexToBigIntString(hex: string | undefined): string {
  if (!hex) return '0'
  try {
    return BigInt(hex).toString()
  } catch {
    return '0'
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text()
  const signature = req.headers.get('x-alchemy-signature') ?? ''

  if (!verifySignature(rawBody, signature)) {
    return errorResponse(401, 'Invalid signature')
  }

  let payload: AlchemyWebhookPayload
  try {
    payload = JSON.parse(rawBody) as AlchemyWebhookPayload
  } catch {
    return errorResponse(400, 'Invalid JSON')
  }

  const config = await getGateConfig()
  if (!config.passCollection) {
    return NextResponse.json({ ok: true, ignored: 'no pass collection configured' })
  }

  const passContract = config.passCollection

  // Flatten activities from either Address Activity or NFT Activity payload shape.
  const activities: Activity[] = []
  if (Array.isArray(payload.event?.activity)) {
    activities.push(...payload.event.activity)
  } else if (Array.isArray(payload.events)) {
    for (const e of payload.events) {
      if (Array.isArray(e.activity)) activities.push(...e.activity)
      else if (e.activity) activities.push(e.activity)
    }
  }

  for (const activity of activities) {
    if (activity.contractAddress?.toLowerCase() !== passContract) continue

    const from = String(activity.fromAddress ?? '').toLowerCase()
    const to = String(activity.toAddress ?? '').toLowerCase()
    const txHash = String(activity.hash ?? activity.transactionHash ?? '')
    const logIndex = hexToInt(activity.log?.logIndex)
    if (!txHash) continue

    let transfers: { tokenId: string; amount: number }[] = []
    if (activity.category === 'erc1155' && Array.isArray(activity.erc1155Metadata)) {
      transfers = activity.erc1155Metadata.map((m) => ({
        tokenId: hexToBigIntString(m.tokenId),
        amount: hexToInt(m.value),
      }))
    } else if (activity.category === 'erc721') {
      transfers = [{ tokenId: hexToBigIntString(activity.erc721TokenId), amount: 1 }]
    }

    let idx = 0
    for (const t of transfers) {
      // Each transfer in a batched ERC1155 event gets its own subIndex so
      // the processed-key is unique even when many transfers share one
      // logIndex. Separate field instead of logIndex*1000+idx makes the
      // namespace collision-free regardless of logIndex magnitude.
      const subIndex = idx++
      if (t.amount <= 0) continue

      // Collection-as-gate: every tokenId in the configured collection counts.
      await processTransfer({
        collection: passContract,
        from,
        to,
        amount: t.amount,
        tokenId: t.tokenId,
        txHash,
        logIndex,
        subIndex,
      })
    }
  }

  return NextResponse.json({ ok: true })
}
