import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress } from '@/lib/address'
import { follow, unfollow, isFollowing, getFollowing, getFollowers, getFollowerCount, getFollowingCount } from '@/lib/follows'
import { consumeNonce } from '@/lib/profile'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { writeNotification } from '@/lib/notifications'
import { errorResponse } from '@/lib/apiResponse'

type Params = { params: Promise<{ address: string }> }

// GET /api/follow/[address]?follower=0x...  → { following: bool }
// GET /api/follow/[address]?list=1          → { addresses: string[] }  (following)
// GET /api/follow/[address]?followers=1     → { addresses: string[] }  (followers)
// GET /api/follow/[address]?count=1         → { followingCount: number, followerCount: number }
export async function GET(req: NextRequest, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')

  const { searchParams } = new URL(req.url)

  if (searchParams.get('count')) {
    const [followingCount, followerCount] = await Promise.all([
      getFollowingCount(address),
      getFollowerCount(address),
    ])
    return NextResponse.json({ followingCount, followerCount })
  }

  if (searchParams.get('followers')) {
    const addresses = await getFollowers(address)
    return NextResponse.json({ addresses })
  }

  if (searchParams.get('list')) {
    const addresses = await getFollowing(address)
    return NextResponse.json({ addresses })
  }

  const follower = searchParams.get('follower')
  if (!follower || !isAddress(follower)) return NextResponse.json({ following: false })
  const result = await isFollowing(follower, address)
  return NextResponse.json({ following: result })
}

async function verifyFollowSignature(
  action: 'Follow' | 'Unfollow',
  target: string,
  body: { follower?: string; signature?: string; nonce?: string },
): Promise<{ error: string; status: number } | null> {
  if (!body.follower || !isAddress(body.follower) || !body.signature || !body.nonce) {
    return { error: 'follower, signature, and nonce required', status: 400 }
  }
  const message = `${action} ${target.toLowerCase()} on Kismet Art\nAddress: ${body.follower.toLowerCase()}\nNonce: ${body.nonce}`
  const verified = await verifyMessage({
    address: body.follower as `0x${string}`,
    message,
    signature: body.signature as `0x${string}`,
  })
  if (!verified) return { error: 'Signature verification failed', status: 401 }

  const valid = await consumeNonce(body.follower, body.nonce)
  if (!valid) return { error: 'Invalid or expired nonce', status: 401 }
  return null
}

// POST /api/follow/[address] — follow (requires wallet signature)
export async function POST(req: NextRequest, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')

  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`follow:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const body = await req.json() as { follower?: string; signature?: string; nonce?: string }
  const err = await verifyFollowSignature('Follow', address, body)
  if (err) return errorResponse(err.status, err.error)

  await follow(body.follower!, address)
  after(() =>
    writeNotification({ type: 'follow', recipient: address, actor: body.follower! }),
  )
  return NextResponse.json({ following: true })
}

// DELETE /api/follow/[address] — unfollow (requires wallet signature)
export async function DELETE(req: NextRequest, { params }: Params) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')

  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`follow:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const body = await req.json() as { follower?: string; signature?: string; nonce?: string }
  const err = await verifyFollowSignature('Unfollow', address, body)
  if (err) return errorResponse(err.status, err.error)

  await unfollow(body.follower!, address)
  return NextResponse.json({ following: false })
}
