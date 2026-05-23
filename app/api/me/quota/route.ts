import { NextRequest, NextResponse } from 'next/server'
import { getSessionAddress } from '@/lib/session'
import { getUserQuotaStatus, type QuotaKind } from '@/lib/userQuota'
import { errorResponse } from '@/lib/apiResponse'

const KINDS: QuotaKind[] = ['mint', 'write', 'upload-bytes', 'sign-calls']

// Read-only snapshot of the session user's remaining mint / write / upload
// / sign budget. Mirrors /api/airdrop/quota's role for the airdrop bucket.
// Cheap (per-kind: two GETs) and read-on-render is fine — no debit happens
// here. Returns 401 for unauthenticated callers so the UI can hide the
// per-quota row instead of showing zeros that look like a hit cap.
export async function GET(req: NextRequest) {
  const address = await getSessionAddress(req)
  if (!address) return errorResponse(401, 'Not authenticated')

  const quotas = await Promise.all(
    KINDS.map((kind) => getUserQuotaStatus(kind, address)),
  )
  return NextResponse.json(
    { address, quotas },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
