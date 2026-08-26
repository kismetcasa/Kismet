import { NextRequest, NextResponse } from 'next/server'
import { decodeEventLog, parseAbi, type Address, type Hex } from 'viem'
import { userOpEventsFromLogs } from '@/lib/userOps'
import { errorResponse } from '@/lib/apiResponse'
import { isBlacklisted } from '@/lib/blacklist'
import {
  campaignStatus,
  CLAIM_GRACE_MS,
  parseWei,
  payerForMint,
  progressPercent,
} from '@/lib/giftFund'
import {
  closeCampaign,
  getActiveCampaignId,
  getCampaign,
  listContributions,
  openCampaign,
  releaseMomentSlot,
} from '@/lib/giftFundStore'
import { isAddress } from '@/lib/address'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { getMomentMeta } from '@/lib/notifications'
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
  const mints: { collection: string; tokenId: string; recipient: string; logIndex: number }[] = []
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
        logIndex: log.logIndex,
      })
    } catch {
      continue
    }
  }
  const unique = new Set(mints.map((m) => `${m.collection}:${m.tokenId}:${m.recipient}`))
  if (mints.length === 0) return errorResponse(400, 'No mint found in transaction')
  if (unique.size > 1) return errorResponse(400, 'Ambiguous transaction (multiple mints)')
  const mint = mints[0]

  // Organizer, chain-derived. Plain EOA gift → the tx signer. 4337 gift —
  // including one a public bundler batched with STRANGERS' operations — →
  // the sender of the mint's OWN userOp, attributed by log order
  // (lib/giftFund.payerForMint: the EntryPoint emits each op's
  // UserOperationEvent after that op's logs, so the first event past the
  // mint log is its payer). A 4337 receipt whose event ordering doesn't
  // resolve is refused, never guessed at.
  const userOpEvents = userOpEventsFromLogs(receipt.logs)
  let organizer: string
  if (userOpEvents.length === 0) {
    organizer = receipt.from.toLowerCase()
  } else {
    const payer = payerForMint({ userOpEvents, mintLogIndex: mint.logIndex })
    if (!payer) return errorResponse(400, 'Could not attribute the mint to a payer')
    organizer = payer
  }

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
  // readSalePricePerToken returns the row's pricePerToken — which is 0n for
  // an ABSENT sale row (FPSS returns a zeroed struct), null only on RPC
  // failure. Both shapes refuse: without a live priced ETH sale the goal
  // would collapse to the mint fee and the bar would be meaningless. Same
  // guard as KismetGiftPool.create (saleEnd == 0 / goal == 0 revert).
  if (price === null || price <= 0n) {
    return errorResponse(400, 'No ETH sale for this artwork')
  }
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

  // Title snapshot for share copy — best-effort, the campaign works unnamed.
  const meta = await getMomentMeta(mint.collection, mint.tokenId).catch(() => null)

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
    tokenName: meta?.name ?? '',
    openedAtMs,
    closesAtMs: openedAtMs + durationDays * 24 * 60 * 60 * 1000,
  })
  if (!opened) return errorResponse(409, 'This artwork already has an active fund')

  return NextResponse.json({ ok: true, campaignId: giftTx.toLowerCase() })
}

/** PATCH — organizer's early close. Session-gated as the organizer (the
 *  same identity rule as open); benign by construction: it only moves the
 *  window's end to now, so no funds move, in-window transfers stay claimable
 *  through the claim grace, a send already in flight still lands within the
 *  transfer landing grace (lib/giftFund.TRANSFER_LANDING_GRACE_MS), and the
 *  panel flips to its closed state. */
export async function PATCH(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`gift-fund-close:${ip}`, 10, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const body = (await req.json().catch(() => null)) as {
    campaignId?: string
    action?: string
  } | null
  if (!body || body.action !== 'close') return errorResponse(400, 'Invalid body')
  const { campaignId } = body
  if (!campaignId || !/^0x[0-9a-fA-F]{64}$/.test(campaignId)) {
    return errorResponse(400, 'Invalid campaignId')
  }

  const campaign = await getCampaign(campaignId)
  if (!campaign) return errorResponse(404, 'No such campaign')
  const session = await getSessionAddress(req).catch(() => null)
  if (!session || session.toLowerCase() !== campaign.organizer.toLowerCase()) {
    return errorResponse(401, 'Only the organizer can close the fund')
  }
  if (Date.now() > campaign.closesAtMs) {
    return NextResponse.json({ ok: true, idempotent: true })
  }
  await closeCampaign(campaignId, Date.now())
  return NextResponse.json({ ok: true })
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
  if (!campaign) {
    // Zombie slot: the NX claim landed but the campaign hash write failed
    // (openCampaign is two writes). Self-heal here — the slot's only job is
    // pointing at a campaign that exists.
    await releaseMomentSlot(collection, tokenId)
    return NextResponse.json({ campaign: null })
  }

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
  // Panel renders 5 rows; each row costs an HGETALL, and this route runs per
  // Patron artwork view — fetch exactly what renders.
  const contributions = await listContributions(id, 5)
  return NextResponse.json({
    campaign: {
      ...campaign,
      status,
      progressPercent: progressPercent(raised, goal),
      contributions,
    },
  })
}
