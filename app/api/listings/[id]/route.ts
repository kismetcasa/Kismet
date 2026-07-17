import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage, formatEther, formatUnits, type Hex } from 'viem'
import { isAddress } from '@/lib/address'
import { bestEffort } from '@/lib/bestEffort'
import { getGateConfig } from '@/lib/gate'
import { getListing, updateListingStatus } from '@/lib/listings'
import { clearKismetListed, creditValidityOnce, recordPlatformTx } from '@/lib/pass-validity'
import { consumeNonce } from '@/lib/profile'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { writeNotification } from '@/lib/notifications'
import { errorResponse } from '@/lib/apiResponse'
import { serverBaseClient } from '@/lib/rpc'
import { findFulfillmentInLogs } from '@/lib/seaport'
import { creditListingRoyalty, recordSecondaryVolume } from '@/lib/stats'
import { auditRoyaltyReceiver } from '@/lib/royaltyAudit'

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

  // Cancel is authorized by the seller's signed message (no on-chain artifact
  // exists for an off-chain cancel). Filled is authorized by the on-chain
  // Seaport fulfillment of THIS order — the receipt is the binding proof, so the
  // buyer signature is OPTIONAL: both the current BuyButton and the agent path
  // send txHash only and rely on the receipt (a single-approval buy); the signed
  // branch below is retained only for older web clients. The buyer is taken from
  // the OrderFulfilled event, which is unforgeable and authoritative.
  const { signature, nonce, signer } = body
  let buyer = ''
  // Creator royalty actually paid on this fill (human units), credited to the
  // artist's earnings after the status update. Null when the order carried none.
  let royalty: { amount: number; currency: 'eth' | 'usdc' } | null = null

  if (body.status === 'cancelled') {
    if (!signature || !nonce || !signer || !isAddress(signer)) {
      return errorResponse(400, 'signature, nonce, and signer required')
    }
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
    // status === 'filled'
    if (!body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
      return errorResponse(400, 'txHash required to mark filled')
    }

    // On-chain fulfillment of THIS listing is the binding gate.
    // findFulfillmentInLogs matches the listing's orderHash, so a txHash for any
    // other order won't pass — and a Seaport order can only be fulfilled once, so
    // no third party can fabricate this. waitForTransactionReceipt polls (10s) so
    // a brief RPC propagation lag after the buyer's client saw the receipt doesn't
    // reject a real sale. The buyer is the event recipient, not a self-claimed
    // address — so a marker can't redirect the sale (or Pass validity) to anyone.
    let onchainBuyer: string | null = null
    let fulfillment: ReturnType<typeof findFulfillmentInLogs> = null
    try {
      const receipt = await serverBaseClient().waitForTransactionReceipt({
        hash: body.txHash as Hex,
        timeout: 10_000,
        pollingInterval: 500,
      })
      if (receipt.status === 'success') {
        const found = findFulfillmentInLogs(listing, receipt.logs)
        if (found) {
          onchainBuyer = found.recipient.toLowerCase()
          fulfillment = found
        }
      }
    } catch {
      // Timeout / decode / RPC error — fail-closed; the client can retry.
    }
    if (!onchainBuyer) {
      return errorResponse(403, 'Fulfillment not verified on-chain for this listing')
    }
    if (onchainBuyer === listing.seller.toLowerCase()) {
      return errorResponse(403, 'Seller cannot mark own listing filled')
    }

    // Creator royalty for the earnings card. buildSellOrder always appends the
    // royalty item LAST (after seller proceeds [0] and the platform fee), so when
    // the order carries a royalty it's the final consideration item paying
    // royaltyReceiver. Take the amount ACTUALLY settled from the matched event
    // (same item order as the signed order) — never the informational stored
    // field. Indexing by the known position correctly excludes seller proceeds
    // even when the seller is also the royalty receiver (reselling own work).
    if (fulfillment) {
      const stored = listing.orderComponents.consideration
      const idx = stored.length - 1
      const evt = fulfillment.consideration[idx]
      const receiver = listing.royaltyReceiver.toLowerCase()
      if (
        idx > 0 &&
        stored[idx]?.recipient?.toLowerCase() === receiver &&
        evt?.recipient?.toLowerCase() === receiver
      ) {
        const human =
          listing.currency === 'usdc'
            ? Number(formatUnits(evt.amount, 6))
            : Number(formatEther(evt.amount))
        if (human > 0) royalty = { amount: human, currency: listing.currency }
      }
    }

    // Optional buyer signature. When the caller supplies one (web path), keep the
    // strict checks: it must come from the on-chain buyer, and it burns a
    // single-use nonce. The agent path omits it entirely — the receipt is proof.
    if (signature !== undefined || nonce !== undefined || signer !== undefined) {
      if (!signature || !nonce || !signer || !isAddress(signer)) {
        return errorResponse(400, 'signature, nonce, and signer required when signing')
      }
      if (signer.toLowerCase() !== onchainBuyer) {
        return errorResponse(403, 'signer must be the on-chain buyer')
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
      const valid = await consumeNonce(signer, nonce)
      if (!valid) {
        return errorResponse(401, 'Invalid or expired nonce')
      }
    }

    buyer = onchainBuyer
  }

  await updateListingStatus(id, body.status as 'filled' | 'cancelled')

  if (body.status === 'cancelled') {
    // Clear the Kismet-listed flag so processTransfer no longer shields this
    // token from taint. The seller may sell elsewhere (off-platform) after
    // cancelling; without this, the stale flag would prevent the taint that
    // protects the provenance chain until the TTL expires.
    after(() =>
      clearKismetListed(listing.collectionAddress, listing.tokenId, listing.seller).catch(
        bestEffort('listings.cancelled.clearKismetListed', { id }),
      ),
    )
  }

  if (body.status === 'filled') {
    // Credit the creator royalty to the artist's earnings. Synchronous (not
    // after()) for reliability — there's no webhook backstop for this stat — and
    // safe to await: creditListingRoyalty is idempotent per listing and swallows
    // its own errors, so it can never fail the sale response. collection/tokenId
    // let it decompose a 0xSplits royalty receiver into per-member credits so
    // split collaborators' cards see their share instead of a stranded contract.
    if (royalty) {
      const outcome = await creditListingRoyalty({
        listingId: listing.id,
        currency: royalty.currency,
        amount: royalty.amount,
        receiver: listing.royaltyReceiver,
        collection: listing.collectionAddress,
        tokenId: listing.tokenId,
      })
      // Instrumentation: record whether this royalty paid a wallet (itemizes
      // on the card directly) or a split contract, and for contracts what the
      // credit path ACTUALLY did (decomposed vs stranded) — the audit records
      // the outcome above rather than re-deriving it, so it can never
      // disagree with the mechanism it measures. Off the response path;
      // best-effort. A Seaport order fills once, so this runs at most once
      // per listing.
      after(() =>
        auditRoyaltyReceiver({
          listingId: listing.id,
          collection: listing.collectionAddress,
          tokenId: listing.tokenId,
          receiver: listing.royaltyReceiver,
          currency: royalty.currency,
          amount: royalty.amount,
          outcome,
        }),
      )
    }

    // Record the GROSS resale price into platform secondary volume. Runs for
    // EVERY fill (independent of `royalty` — a sale has volume even with no
    // creator royalty). Awaited like the royalty credit (no webhook backstop),
    // idempotent per listing, and never throws. `listing.price` is base units
    // for the listing's currency; convert to human units to match the
    // aggregate's denomination.
    const priceHuman =
      listing.currency === 'usdc'
        ? Number(formatUnits(BigInt(listing.price), 6))
        : Number(formatEther(BigInt(listing.price)))
    await recordSecondaryVolume({
      listingId: listing.id,
      currency: listing.currency,
      price: priceHuman,
    })

    after(() =>
      writeNotification({
        type: 'sale',
        recipient: listing.seller,
        actor: buyer,
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
    // this listing's orderHash, recipient is the on-chain buyer, receipt
    // success), so the buyer is provably the on-chain recipient.
    //
    // Credit the buyer SYNCHRONOUSLY (before the response) — mirrors the
    // fix in /api/collect/route.ts. The webhook fires immediately after
    // the tx mines; the buyer's PATCH call + our receipt poll take several
    // more seconds. Without synchronous credit here, the webhook would
    // race and claim the creditValidityOnce key with no-credit (if the
    // platform flag wasn't set yet). The Kismet-listed flag set at
    // listing-creation time prevents the webhook from false-tainting the
    // token, but we still credit synchronously so the buyer has access on
    // their very next mint attempt without waiting for the webhook.
    //
    // recordPlatformTx in after() remains as convergence backstop: when
    // the webhook eventually delivers the Transfer event, isPlatformTx=true
    // causes it to call creditValidityOnce, which hits the keyCredited NX
    // key we claimed here and is a no-op.
    //
    // Seller decrement is handled automatically by the webhook's unconditional
    // !isMint from-decrement (see processTransfer); live reconciliation in
    // hasValidPass is a second-layer safety if the webhook is delayed or missed.
    const txHash = body.txHash as string
    const gateConfig = await getGateConfig()
    if (
      gateConfig.passCollection
      && listing.collectionAddress.toLowerCase() === gateConfig.passCollection
    ) {
      const passCollection = gateConfig.passCollection
      try {
        await creditValidityOnce({
          collection: passCollection,
          address: buyer,
          txHash,
          tokenId: listing.tokenId,
        })
      } catch (err) {
        console.error('[listings] pass-validity direct-credit failed', {
          txHash,
          buyer,
          passCollection,
          err,
        })
      }
      after(() =>
        clearKismetListed(passCollection, listing.tokenId, listing.seller).catch(
          bestEffort('listings.filled.clearKismetListed', { txHash, passCollection }),
        ),
      )
      after(() =>
        recordPlatformTx(txHash, [buyer], listing.tokenId).catch(
          bestEffort('listings.filled.recordPlatformTx', { txHash, buyer }),
        ),
      )
    }
  }

  return NextResponse.json({ ok: true })
}
