import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage, type Hex } from 'viem'
import { isAddress } from '@/lib/address'
import { bestEffort } from '@/lib/bestEffort'
import { getGateConfig } from '@/lib/gate'
import { getListing, updateListingStatus } from '@/lib/listings'
import { creditValidityOnce, recordPlatformTx } from '@/lib/pass-validity'
import { consumeNonce } from '@/lib/profile'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { writeNotification } from '@/lib/notifications'
import { errorResponse } from '@/lib/apiResponse'
import { serverClient } from '@/lib/rpc'
import { BASE_CHAIN_ID } from '@/lib/chains'
import { findFulfillmentInLogs } from '@/lib/seaport'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`listings-patch:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const { id } = await params
  const body = await req.json() as {
    status: string
    signature?: string
    nonce?: string
    signer?: string
    // Required on 'filled' transitions — the Seaport fulfillment tx hash.
    // The handler decodes its OrderFulfilled event and rejects any PATCH
    // whose orderHash doesn't match this listing, closing the prior griefing
    // path where any non-seller could mark any active listing as sold.
    txHash?: string
  }

  if (body.status !== 'filled' && body.status !== 'cancelled') {
    return errorResponse(400, 'status must be filled or cancelled')
  }

  const listing = await getListing(id)
  if (!listing) {
    return errorResponse(404, 'Listing not found')
  }
  if (listing.status !== 'active') {
    return errorResponse(409, 'Listing is already inactive')
  }

  // Both branches require a signed message tied to the listing id + signer +
  // nonce. The cancel branch must be from the seller; the filled branch must
  // be from someone other than the seller (anti-self-mark, since legit buyers
  // can't be the seller per fulfillOrder semantics).
  const { signature, nonce, signer } = body
  if (!signature || !nonce || !signer || !isAddress(signer)) {
    return errorResponse(400, 'signature, nonce, and signer required')
  }

  if (body.status === 'cancelled') {
    if (signer.toLowerCase() !== listing.seller.toLowerCase()) {
      return errorResponse(403, 'Only the seller can cancel this listing')
    }
    const message = `Cancel Kismet listing\nListing: ${id}\nSeller: ${signer.toLowerCase()}\nNonce: ${nonce}`
    const verified = await verifyMessage({
      address: signer as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
    if (!verified) {
      return errorResponse(401, 'Signature verification failed')
    }
    const valid = await consumeNonce(signer, nonce)
    if (!valid) {
      return errorResponse(401, 'Invalid or expired nonce')
    }
  } else {
    // status === 'filled' — must be the buyer, AND there must be a real
    // Seaport fulfillment tx whose OrderFulfilled event names this signer
    // as the recipient. Signature alone was insufficient (any wallet that
    // isn't the seller could sign), so any third party could fabricate
    // sales — including pumping fake priority `sale` notifications into
    // the seller's bell. The on-chain receipt is the binding gate.
    if (signer.toLowerCase() === listing.seller.toLowerCase()) {
      return errorResponse(403, 'Seller cannot mark own listing filled')
    }
    if (!body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      return errorResponse(400, 'txHash required to mark filled')
    }
    const message = `Mark Kismet listing filled\nListing: ${id}\nBuyer: ${signer.toLowerCase()}\nNonce: ${nonce}`
    const verified = await verifyMessage({
      address: signer as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
    if (!verified) {
      return errorResponse(401, 'Signature verification failed')
    }

    // Receipt verification BEFORE nonce consumption — a verification-only
    // failure shouldn't burn a legitimate buyer's nonce. waitForTransactionReceipt
    // polls so a brief RPC propagation lag (buyer's client saw the receipt
    // milliseconds ago; the server-side RPC node may not have indexed yet)
    // doesn't reject a real sale. 10s upper bound on the wait.
    let onchainOk = false
    try {
      const receipt = await serverClient(listing.chainId ?? BASE_CHAIN_ID).waitForTransactionReceipt({
        hash: body.txHash as Hex,
        timeout: 10_000,
        pollingInterval: 500,
      })
      if (receipt.status === 'success') {
        const found = findFulfillmentInLogs(listing, receipt.logs)
        if (found && found.recipient.toLowerCase() === signer.toLowerCase()) {
          onchainOk = true
        }
      }
    } catch {
      // Timeout / decode / RPC error — fail-closed; client can retry the
      // PATCH if they hit a transient lag.
    }
    if (!onchainOk) {
      return errorResponse(403, 'Fulfillment not verified on-chain for this listing')
    }

    const valid = await consumeNonce(signer, nonce)
    if (!valid) {
      return errorResponse(401, 'Invalid or expired nonce')
    }
  }

  await updateListingStatus(id, body.status as 'filled' | 'cancelled')

  if (body.status === 'filled') {
    after(() =>
      writeNotification({
        type: 'sale',
        recipient: listing.seller,
        actor: signer.toLowerCase(),
        tokenAddress: listing.collectionAddress,
        tokenId: listing.tokenId,
        tokenName: listing.name,
        tokenImage: listing.image,
        price: listing.price,
        // Without currency, NotificationRow defaults to ETH formatting and
        // would render a USDC sale's price (in 6dp base units) as a tiny ETH
        // amount. Pass it through so $5 stays $5.
        currency: listing.currency,
        listingId: listing.id,
      }),
    )

    // Kismet secondary-sale validity transfer for the Pass collection.
    // The fill is on-chain-verified above (findFulfillmentInLogs matched
    // this listing's orderHash, recipient===signer, receipt success), so
    // the buyer is provably the on-chain recipient — safe to credit
    // synchronously instead of waiting on the webhook.
    //
    // Two parallel after() writes, both idempotent against later retries
    // or webhook delivery:
    //   1. recordPlatformTx flags the fill so when the webhook eventually
    //      delivers the Transfer event, processTransfer's to-credit path
    //      converges through the same creditValidityOnce key (no-op).
    //      Without the flag, the webhook would treat the sale as
    //      off-platform and skip crediting — leaving the buyer with no
    //      validity until live reconciliation rejects them too.
    //   2. creditValidityOnce credits the buyer now, so the new owner's
    //      gate check passes on their very next mint attempt (no
    //      30-second webhook wait, no Alchemy dependency).
    //
    // Seller decrement is handled automatically by the webhook's
    // unconditional `!isMint` from-decrement (see processTransfer); live
    // reconciliation in hasValidPass is a second-layer safety if the
    // webhook is delayed or missed.
    const txHash = body.txHash as string
    const buyer = signer.toLowerCase()
    const gateConfig = await getGateConfig()
    if (
      gateConfig.passCollection
      && listing.collectionAddress.toLowerCase() === gateConfig.passCollection
    ) {
      const passCollection = gateConfig.passCollection
      after(() => recordPlatformTx(txHash).catch(
        bestEffort('listings.filled.recordPlatformTx', { txHash, buyer }),
      ))
      after(() => creditValidityOnce({
        collection: passCollection,
        address: buyer,
        txHash,
        tokenId: listing.tokenId,
      }).catch(
        bestEffort('listings.filled.creditValidityOnce', { txHash, buyer, passCollection }),
      ))
    }
  }

  return NextResponse.json({ ok: true })
}
