import { NextRequest, NextResponse } from 'next/server'
import { getEthUsd } from '@/lib/ethPrice'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Chainlink ETH/USD spot for client-side conversion labels (the mint form's
// live "≈ $…" line under the price input). getEthUsd is Redis-cached for 60s,
// so this stays a cheap read; the edge cache below absorbs same-window bursts.
// `ethUsd: null` = feed unavailable or stale — clients hide their USD line
// instead of pricing with a frozen answer (the same honest-USD rule the
// earnings views follow).
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`eth-usd:${ip}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const ethUsd = await getEthUsd()

  return NextResponse.json(
    { ethUsd },
    {
      // Matches the server-side cache window: identical for every viewer and
      // refreshed at most once a minute, so a short shared cache is free.
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    },
  )
}
