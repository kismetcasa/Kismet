import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'
import { getStoredSplits, hasRegisteredSplits } from '@/lib/splits'
import { USDC_BASE } from '@/lib/zoraMint'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Triggers the inprocess split distribution for a token's accumulated proceeds.
 * Inprocess submits the on-chain tx and pays gas via the platform smart wallet
 * tied to our INPROCESS_API_KEY — meaning a leaked endpoint costs us, not the
 * caller. Three gates:
 *   1. Signed message tying caller to the specific (collection, tokenId, split)
 *   2. Caller is creator OR admin of that moment (verified via inprocess)
 *   3. Token has a registered split flag (kismetart:splits:<addr>:<id>) — only
 *      tokens minted through our /api/mint route with multiple splits qualify
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`distribute:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) {
    return errorResponse(500, 'INPROCESS_API_KEY not configured')
  }

  let body: {
    splitAddress?: string
    collectionAddress?: string
    tokenId?: string
    chainId?: number
    // 'eth' (default) or 'usdc'. Maps to the inprocess `tokenAddress` field
    // — required for USDC distributions per their docs (otherwise the call
    // defaults to native ETH and distributes nothing from a USDC splits
    // contract).
    currency?: 'eth' | 'usdc'
    callerAddress?: string
    signature?: string
    nonce?: string
  }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const { splitAddress, collectionAddress, tokenId, callerAddress, signature, nonce } = body
  const currency: 'eth' | 'usdc' = body.currency === 'usdc' ? 'usdc' : 'eth'

  if (!splitAddress || !isAddress(splitAddress)) {
    return errorResponse(400, 'valid splitAddress required')
  }
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'valid collectionAddress required')
  }
  if (!isValidTokenId(tokenId)) {
    return errorResponse(400, 'valid tokenId required')
  }
  if (!callerAddress || !isAddress(callerAddress)) {
    return errorResponse(401, 'callerAddress required')
  }
  if (!signature || !nonce) {
    return errorResponse(401, 'signature and nonce required')
  }

  // Currency is part of the signed message so an attacker can't substitute
  // a different distribution token after the fact (replay protection).
  const message = `Distribute Kismet Art split\nCollection: ${collectionAddress.toLowerCase()}\nToken: ${tokenId}\nSplit: ${splitAddress.toLowerCase()}\nCurrency: ${currency}\nAddress: ${callerAddress.toLowerCase()}\nNonce: ${nonce}`
  let sigValid = false
  try {
    sigValid = await verifyMessage({
      address: callerAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
  } catch {
    return errorResponse(401, 'Invalid signature')
  }
  if (!sigValid) return errorResponse(401, 'Signature verification failed')

  // Verify-then-consume: failed sigs leave the nonce reusable.
  const nonceValid = await consumeNonce(callerAddress, nonce)
  if (!nonceValid) {
    return errorResponse(401, 'Invalid or expired nonce')
  }

  // Token must have splits registered via our mint flow. Without this gate
  // anyone could trigger distribute on arbitrary contract addresses.
  if (!(await hasRegisteredSplits(collectionAddress, tokenId))) {
    return errorResponse(403, 'No splits registered for this token')
  }

  // Caller must be creator or admin of the moment per inprocess.
  // /moment returns `momentAdmins: string[]` — an unordered list. We
  // accept any caller in the list (creator OR delegated admin) via
  // .includes() below, so ordering doesn't matter here.
  try {
    const momentUrl = new URL(`${INPROCESS_API}/moment`)
    momentUrl.searchParams.set('collectionAddress', collectionAddress)
    momentUrl.searchParams.set('tokenId', tokenId)
    momentUrl.searchParams.set('chainId', '8453')
    const momentRes = await fetch(momentUrl.toString(), { headers: { Accept: 'application/json' } })
    if (!momentRes.ok) {
      return errorResponse(403, 'Could not verify moment creator')
    }
    const momentData = (await momentRes.json()) as { momentAdmins?: unknown }
    const callerLower = callerAddress.toLowerCase()
    const adminsLower = Array.isArray(momentData.momentAdmins)
      ? momentData.momentAdmins
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.toLowerCase())
      : []
    if (!adminsLower.includes(callerLower)) {
      return errorResponse(403, 'Only the moment creator or an admin may distribute')
    }
  } catch {
    return errorResponse(502, 'Could not verify moment creator')
  }

  // Forward only the specific fields inprocess expects — never relay arbitrary
  // body keys, which could ride along to undocumented upstream parameters.
  // Per inprocess docs (payments/distribute): tokenAddress is required for
  // ERC20 distributions (defaults to native ETH if omitted).
  const res = await fetch(`${INPROCESS_API}/distribute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      splitAddress,
      chainId: body.chainId ?? 8453,
      ...(currency === 'usdc' ? { tokenAddress: USDC_BASE } : {}),
    }),
  })

  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'upstream error', detail: text.slice(0, 200) }, { status: 502 })
  }

  // Fan-out payout notifications on inprocess 2xx (best-effort).
  // writeNotification's self-check filters caller-as-recipient.
  if (res.ok) {
    after(async () => {
      try {
        const stored = await getStoredSplits(collectionAddress, tokenId)
        if (!stored.recipients.length) return
        const meta = await getMomentMeta(collectionAddress, tokenId)
        await Promise.all(
          stored.recipients.map((r) =>
            writeNotification({
              type: 'payout',
              recipient: r.address,
              actor: callerAddress,
              tokenAddress: collectionAddress,
              tokenId,
              tokenName: meta?.name,
              currency,
            }),
          ),
        )
      } catch {}
    })
  }

  return NextResponse.json(data, { status: res.status })
}
