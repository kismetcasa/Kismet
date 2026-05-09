import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'
import { hasRegisteredSplits } from '@/lib/splits'
import { USDC_BASE } from '@/lib/zoraMint'

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
  const allowed = await checkRateLimit(`distribute:${ip}`, 5, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'INPROCESS_API_KEY not configured' }, { status: 500 })
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
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { splitAddress, collectionAddress, tokenId, callerAddress, signature, nonce } = body
  const currency: 'eth' | 'usdc' = body.currency === 'usdc' ? 'usdc' : 'eth'

  if (!splitAddress || !isAddress(splitAddress)) {
    return NextResponse.json({ error: 'valid splitAddress required' }, { status: 400 })
  }
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'valid collectionAddress required' }, { status: 400 })
  }
  if (!isValidTokenId(tokenId)) {
    return NextResponse.json({ error: 'valid tokenId required' }, { status: 400 })
  }
  if (!callerAddress || !isAddress(callerAddress)) {
    return NextResponse.json({ error: 'callerAddress required' }, { status: 401 })
  }
  if (!signature || !nonce) {
    return NextResponse.json({ error: 'signature and nonce required' }, { status: 401 })
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
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!sigValid) return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 })

  // Verify-then-consume: failed sigs leave the nonce reusable.
  const nonceValid = await consumeNonce(callerAddress, nonce)
  if (!nonceValid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
  }

  // Token must have splits registered via our mint flow. Without this gate
  // anyone could trigger distribute on arbitrary contract addresses.
  if (!(await hasRegisteredSplits(collectionAddress, tokenId))) {
    return NextResponse.json({ error: 'No splits registered for this token' }, { status: 403 })
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
      return NextResponse.json({ error: 'Could not verify moment creator' }, { status: 403 })
    }
    const momentData = (await momentRes.json()) as { momentAdmins?: unknown }
    const callerLower = callerAddress.toLowerCase()
    const adminsLower = Array.isArray(momentData.momentAdmins)
      ? momentData.momentAdmins
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.toLowerCase())
      : []
    if (!adminsLower.includes(callerLower)) {
      return NextResponse.json({ error: 'Only the moment creator or an admin may distribute' }, { status: 403 })
    }
  } catch {
    return NextResponse.json({ error: 'Could not verify moment creator' }, { status: 502 })
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
  return NextResponse.json(data, { status: res.status })
}
