import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { serverBaseClient } from '@/lib/rpc'
import {
  buildRaffleEntryMessage,
  RAFFLE_ENTRY_MAX_AGE_SECONDS,
} from '@/lib/raffleMessage'
import {
  addEntry,
  entriesOpen,
  holdsEdition,
  isEntered,
  isRaffleEnabled,
} from '@/lib/raffle'

/**
 * Enter a moment's raffle. The collector signs a gas-less message (verified
 * here, ERC-1271-aware so smart wallets work) proving they control the wallet,
 * and the server re-verifies on-chain that they hold ≥1 edition before
 * recording the entry. Idempotent — a second entry is a no-op.
 *
 * The signature only proves wallet control; it moves nothing on-chain. The
 * authoritative eligibility check is the on-chain balanceOf below.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`raffle-enter:${ip}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const body = (await req.json().catch(() => null)) as {
    collection?: string
    tokenId?: string
    address?: string
    issuedAt?: number
    signature?: string
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const collection = body.collection?.toLowerCase()
  const tokenId = body.tokenId
  const address = body.address?.toLowerCase()
  const { issuedAt, signature } = body

  if (!collection || !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection')
  }
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    return errorResponse(400, 'Invalid issuedAt')
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return errorResponse(401, 'Invalid signature')
  }

  // Bound the signature's freshness (small future skew allowed for clock drift).
  const now = Math.floor(Date.now() / 1000)
  if (issuedAt > now + 120 || issuedAt < now - RAFFLE_ENTRY_MAX_AGE_SECONDS) {
    return errorResponse(401, 'Signature expired — please try again')
  }

  // Rebuild the EXACT message the client signed from server-trusted fields, so
  // the signature binds (collection, tokenId, address, issuedAt). Any tamper
  // flips the message and the verify fails.
  const message = buildRaffleEntryMessage({ collection, tokenId, address, issuedAt })
  let valid = false
  try {
    valid = await serverBaseClient().verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
  } catch {
    return errorResponse(401, 'Signature verification failed')
  }
  if (!valid) return errorResponse(401, 'Signature does not match wallet')

  // The raffle must be enabled for this specific moment AND still accepting
  // entries (not ended, and before the auto-close time). Gating here (not just
  // in the UI) stops a crafted request entering a moment with no/closed raffle.
  if (!(await isRaffleEnabled(collection, tokenId))) {
    return errorResponse(409, 'There is no raffle for this edition')
  }
  if (!(await entriesOpen(collection, tokenId))) {
    return errorResponse(409, 'Raffle entries are closed')
  }

  // Idempotent: already in → success without a redundant on-chain read.
  if (await isEntered(collection, tokenId, address)) {
    return NextResponse.json({ entered: true, already: true })
  }

  if (!(await holdsEdition(collection, tokenId, address))) {
    return errorResponse(403, 'You must hold an edition from this collection to enter')
  }

  await addEntry(collection, tokenId, address)
  return NextResponse.json({ entered: true })
}
