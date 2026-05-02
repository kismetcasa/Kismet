import { NextRequest, NextResponse } from 'next/server'
import { isAddress, verifyMessage } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`airdrop:${ip}`, 5, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'INPROCESS_API_KEY not configured' }, { status: 500 })

  let body: {
    recipients?: { recipientAddress: string; tokenId: string }[]
    collectionAddress?: string
    callerAddress?: string
    signature?: string
    nonce?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.collectionAddress || !isAddress(body.collectionAddress)) {
    return NextResponse.json({ error: 'valid collectionAddress required' }, { status: 400 })
  }
  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return NextResponse.json({ error: 'recipients required' }, { status: 400 })
  }
  for (const r of body.recipients) {
    if (!isAddress(r.recipientAddress)) {
      return NextResponse.json({ error: `invalid recipientAddress: ${r.recipientAddress}` }, { status: 400 })
    }
  }

  // Verify the caller is the moment creator via wallet signature
  if (!body.callerAddress || !isAddress(body.callerAddress)) {
    return NextResponse.json({ error: 'callerAddress required' }, { status: 401 })
  }
  if (!body.signature || !body.nonce) {
    return NextResponse.json({ error: 'signature and nonce required' }, { status: 401 })
  }

  const nonceValid = await consumeNonce(body.callerAddress, body.nonce)
  if (!nonceValid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
  }

  const tokenId = body.recipients[0].tokenId
  const message = `Airdrop moment on Kismet Art\nCollection: ${body.collectionAddress.toLowerCase()}\nToken: ${tokenId}\nAddress: ${body.callerAddress.toLowerCase()}\nNonce: ${body.nonce}`

  let sigValid = false
  try {
    sigValid = await verifyMessage({
      address: body.callerAddress as `0x${string}`,
      message,
      signature: body.signature as `0x${string}`,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!sigValid) return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 })

  // Confirm callerAddress is the moment creator on InProcess
  try {
    const momentUrl = new URL(`${INPROCESS_API}/moment`)
    momentUrl.searchParams.set('collectionAddress', body.collectionAddress)
    momentUrl.searchParams.set('tokenId', tokenId)
    momentUrl.searchParams.set('chainId', '8453')
    const momentRes = await fetch(momentUrl.toString(), { headers: { Accept: 'application/json' } })
    if (!momentRes.ok) {
      return NextResponse.json({ error: 'Could not verify moment creator' }, { status: 403 })
    }
    const momentData = await momentRes.json() as { creator?: { address?: string }; admins?: { address: string }[] }
    const creatorAddr = momentData.creator?.address?.toLowerCase()
    const callerLower = body.callerAddress.toLowerCase()
    const isCreator = creatorAddr === callerLower
    const isAdmin = momentData.admins?.some((a) => a.address?.toLowerCase() === callerLower) ?? false
    if (!isCreator && !isAdmin) {
      return NextResponse.json({ error: 'Only the moment creator or an admin may airdrop' }, { status: 403 })
    }
  } catch {
    return NextResponse.json({ error: 'Could not verify moment creator' }, { status: 502 })
  }

  try {
    const res = await fetch(`${INPROCESS_API}/moment/airdrop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify({ recipients: body.recipients, collectionAddress: body.collectionAddress }),
    })
    const text = await res.text()
    try {
      return NextResponse.json(JSON.parse(text), { status: res.status })
    } catch {
      return NextResponse.json({ error: 'upstream error', detail: text.slice(0, 200) }, { status: 502 })
    }
  } catch {
    return NextResponse.json({ error: 'upstream unreachable' }, { status: 502 })
  }
}
