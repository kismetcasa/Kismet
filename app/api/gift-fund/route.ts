import { NextRequest, NextResponse } from 'next/server'
import { decodeEventLog, parseAbi, type Address, type Hex } from 'viem'
import { userOpSendersFromLogs } from '@/lib/userOps'
import { errorResponse } from '@/lib/apiResponse'
import { isBlacklisted } from '@/lib/blacklist'
import {
  campaignStatus,
  CLAIM_GRACE_MS,
  parseWei,
  progressPercent,
} from '@/lib/giftFund'
import {
  getActiveCampaignId,
  getCampaign,
  listContributions,
  openCampaign,
  releaseMomentSlot,
} from '@/lib/giftFundStore'
import { isAddress } from '@/lib/address'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { serverBaseClient } from '@/lib/rpc'
import { readSalePricePerToken } from '@/lib/saleConfig'
import { readMintFeeWithBound } from '@/lib/zoraMint'

/**
 * Gift Fund campaigns — reimbursement model (lib/giftFund).
 *
 * POST opens a campaign from a gift's txHash — caller must be SIWE-signed-in
 * AS the gift's payer (opening publishes a note in the organizer's name and
 * solicits money to their wallet; only claims are pure chain facts). All
 * campaign facts are derived from the chain, nothing from the body but the
 * hash itself and cosmetics:
 *   - collection / tokenId / recipient — from the receipt's single
 *     TransferSingle(0x0 → recipient) mint log,
 *   - organizer — the wallet that PAID: receipt.from for an EOA gift, the
 *     receipt's sole UserOperationEvent sender for a smart-wallet gift.
 *     Chain-derived like the claim route's backer, so organizership of
 *     someone else's gift cannot be claimed by any body field or session.
 *   - goal — the live ETH sale price + Zora mint fee, FROZEN here (sale
 *     prices are editable, lib/saleEdit; a re-read goal would move the bar).
 *
 * GET returns the artwork's active campaign with its contribution roll.
 */

const ERC1155_TRANSFER_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
])

const DEFAULT_DURATION_DAYS = 7
const MAX_DURATION_DAYS = 30
// A campaign must follow its gift promptly — a stale mint re-surfaced months
// later isn't "help me get reimbursed", it's a fundraiser wearing one.
const MAX_GIFT_AGE_MS = 7 * 24 * 60 * 60 * 1000

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`gift-fund-open:${ip}`, 10, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const body = (await req.json().catch(() => null)) as {
    giftTx?: string
    note?: string
    durationDays?: number
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const giftTx = body.giftTx
  if (!giftTx || !/^0x[0-9a-fA-F]{64}$/.test(giftTx)) {
    return errorResponse(400, 'Invalid giftTx')
  }
  const note = typeof body.note === 'string' ? body.note.slice(0, 280) : ''
  const durationDays =
    Number.isFinite(body.durationDays) && (body.durationDays as number) >= 1
      ? Math.min(Math.floor(body.durationDays as number), MAX_DURATION_DAYS)
      : DEFAULT_DURATION_DAYS

  const client = serverBaseClient()
  let receipt
  try {
    receipt = await client.getTransactionReceipt({ hash: giftTx as Hex })
  } catch {
    return errorResponse(404, 'Gift transaction not found')
  }
  if (receipt.status !== 'success') return errorResponse(400, 'Gift transaction reverted')

  // The single mint this gift performed. More than one distinct
  // (collection, tokenId, recipient) mint in the tx is ambiguous — refuse
  // rather than guess which one the fund is for.
  const mints: { collection: string; tokenId: string; recipient: string }[] = []
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: ERC1155_TRANSFER_ABI,
        data: log.data,
        topics: log.topics,
      })
      const { from, to, id } = decoded.args
      if (from !== '0x0000000000000000000000000000000000000000') continue
      mints.push({
        collection: log.address.toLowerCase(),
        tokenId: id.toString(),
        recipient: to.toLowerCase(),
      })
    } catch {
      continue
    }
  }
  const unique = new Set(mints.map((m) => `${m.collection}:${m.tokenId}:${m.recipient}`))
  if (mints.length === 0) return errorResponse(400, 'No mint found in transaction')
  if (unique.size > 1) return errorResponse(400, 'Ambiguous transaction (multiple mints)')
  const mint = mints[0]

  // Organizer, chain-derived. 4337 gift → the sole userOp sender; plain EOA
  // gift → the tx signer. Multiple userOp senders = shared bundle = refuse
  // (organizership must be unambiguous — it is where the money goes).
  const senders = Array.from(new Set(userOpSendersFromLogs(receipt.logs)))
  let organizer: string
  if (senders.length === 1) organizer = senders[0]
  else if (senders.length === 0) organizer = receipt.from.toLowerCase()
  else return errorResponse(400, 'Ambiguous transaction (multiple operations)')

  // A self-gift can't reach here (planMint collapses it to a collect and the
  // gift is a mint TO the recipient), but the invariant is cheap to hold:
  // a fund whose payer is its own beneficiary is not a gift fund.
  if (organizer === mint.recipient) {
    return errorResponse(400, 'Gift recipient cannot organize its own fund')
  }

  // Opening is an ORGANIZER act, unlike claiming (a pure chain fact): the
  // campaign publishes a note in the organizer's name and solicits money to
  // their wallet, so the caller must BE the organizer — otherwise any
  // stranger could hang an unwanted fund (with arbitrary copy) off someone
  // else's fresh gift. Session address covers both wallet shapes: for a 4337
  // gift the organizer IS the smart account, which is the connected address.
  const session = await getSessionAddress(req).catch(() => null)
  if (!session || session.toLowerCase() !== organizer) {
    return errorResponse(401, 'Sign in as the gift payer to open a fund')
  }

  // Same moderation posture as the gift itself: a blocked wallet doesn't get
  // platform surfaces for its actions.
  if (await isBlacklisted(organizer).catch(() => false)) {
    return errorResponse(403, 'Address is blocked from opening a fund')
  }

  // Freshness: the fund follows its gift, it doesn't resurrect one.
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  const giftAtMs = Number(block.timestamp) * 1000
  if (Date.now() - giftAtMs > MAX_GIFT_AGE_MS) {
    return errorResponse(400, 'Gift is too old to open a fund for')
  }

  // Goal = what this mint costs, frozen. ETH sales only — the whole design
  // is ETH-native (backers send ETH; the mint was paid in ETH).
  const price = await readSalePricePerToken(
    serverBaseClient(),
    mint.collection as Address,
    BigInt(mint.tokenId),
    'eth',
  )
  if (price === null) return errorResponse(400, 'No ETH sale for this artwork')
  let mintFee: bigint
  try {
    // serverBaseClient() is concretely typed to Base while readMintFeeWithBound
    // takes the wider PublicClient generic — same mismatch, same cast, same
    // reasoning as app/api/agent/prepare-collect (its comment has the details).
    mintFee = await readMintFeeWithBound(
      client as Parameters<typeof readMintFeeWithBound>[0],
      mint.collection as Address,
    )
  } catch {
    return errorResponse(502, 'Could not read mint fee')
  }

  const openedAtMs = Date.now()
  const opened = await openCampaign({
    giftTx: giftTx.toLowerCase(),
    collection: mint.collection,
    tokenId: mint.tokenId,
    organizer,
    recipient: mint.recipient,
    goalWei: (price + mintFee).toString(),
    raisedWei: '0',
    backers: 0,
    note,
    openedAtMs,
    closesAtMs: openedAtMs + durationDays * 24 * 60 * 60 * 1000,
  })
  if (!opened) return errorResponse(409, 'This artwork already has an active fund')

  return NextResponse.json({ ok: true, campaignId: giftTx.toLowerCase() })
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`gift-fund-read:${ip}`, 60, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const collection = req.nextUrl.searchParams.get('collection')?.toLowerCase()
  const tokenId = req.nextUrl.searchParams.get('tokenId')
  if (!collection || !isAddress(collection) || !tokenId || !/^\d+$/.test(tokenId)) {
    return errorResponse(400, 'Invalid collection or tokenId')
  }

  const id = await getActiveCampaignId(collection, tokenId)
  if (!id) return NextResponse.json({ campaign: null })
  const campaign = await getCampaign(id)
  if (!campaign) return NextResponse.json({ campaign: null })

  // Lazy resolution (the notification-TTL sweep pattern): once a campaign is
  // past its claim grace nothing more can change it — stop displaying it and
  // free the one-active-per-moment slot so a future gift can open a new
  // fund. The campaign hash remains as the durable record. Without this the
  // slot would block the artwork forever (the release has no other caller).
  if (Date.now() > campaign.closesAtMs + CLAIM_GRACE_MS) {
    await releaseMomentSlot(collection, tokenId)
    return NextResponse.json({ campaign: null })
  }

  const raised = parseWei(campaign.raisedWei)
  const goal = parseWei(campaign.goalWei)
  const status = campaignStatus({
    raisedWei: raised,
    goalWei: goal,
    closesAtMs: campaign.closesAtMs,
    nowMs: Date.now(),
  })
  const contributions = await listContributions(id)
  return NextResponse.json({
    campaign: {
      ...campaign,
      status,
      progressPercent: progressPercent(raised, goal),
      contributions,
    },
  })
}
