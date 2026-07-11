import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { ADMIN_ADDRESS, CURATOR_ADDRESSES } from '@/lib/config'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

export async function GET(req: NextRequest) {
  // Rate-limit this membership probe. It's an unauthenticated oracle: it only
  // confirms whether a SUPPLIED address is admin/curator (it can't reveal an
  // unknown admin — no enumerating 2^160), but a cap slows testing a KNOWN
  // candidate list (e.g. platform users) to identify the privileged set.
  if (!(await checkRateLimit(`admin-me:${getClientIp(req)}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')?.toLowerCase()
  if (!address || !isAddress(address)) {
    return NextResponse.json({ isAdmin: false, isCurator: false })
  }
  const isAdmin = !!ADMIN_ADDRESS && address === ADMIN_ADDRESS
  const isCurator = CURATOR_ADDRESSES.includes(address)
  return NextResponse.json({ isAdmin, isCurator })
}
