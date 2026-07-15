import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'
import { consumeUserQuota } from '@/lib/userQuota'
import { resolveArtistSplitJobs, invalidatePendingCache } from '@/lib/pending'
import { planDistributeAll, jobCurrencies, DISTRIBUTE_ALL_CAP } from '@/lib/distributePlan'
import { acquireDistributeSlot, releaseDistributeSlot } from '@/lib/distributeGovernor'
import { getEthUsd } from '@/lib/ethPrice'
import { redis } from '@/lib/redis'
import { USDC_BASE } from '@/lib/zoraMint'
import { errorResponse } from '@/lib/apiResponse'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// "Distribute all": settle the caller's undistributed split balances in one
// gesture. The caller signs ONCE; the server resolves the splits they're a
// payee on, selects the DISTRIBUTE_ALL_CAP most-valuable (by their $ share),
// and fans out to inprocess /distribute per split×currency. 40 moments → click
// once for the top 20, again for the next 20 (the drained ones drop out of the
// balance>0 filter). Distribution is permissionless on 0xSplits (it can only
// pay the split's fixed recipients, never redirect), so authorization here just
// scopes the fan-out to the caller's own splits and bounds platform-sponsored
// gas — via THREE independent limits: a per-artist single-flight lock (no
// concurrent double-distribute of the same split by one artist — inprocess
// /distribute is non-idempotent), the platform-wide in-flight governor (a burst
// of artists queues instead of flooding the single relay), and the per-user
// daily quota (consumed per call).

// Bounded-concurrency worker pool — small, because each unit is a sponsored
// on-chain tx via the shared relay; we don't want one artist's fan-out to
// monopolise it even within their governor slot.
const FANOUT_CONCURRENCY = 3

const perArtistLockKey = (addr: string) => `kismetart:distribute-all-lock:${addr.toLowerCase()}`
const LOCK_TTL_S = 90

async function distributeOne(
  apiKey: string,
  splitAddress: string,
  currency: 'eth' | 'usdc',
): Promise<boolean> {
  try {
    const res = await fetch(`${INPROCESS_API}/distribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        splitAddress,
        chainId: 8453,
        ...(currency === 'usdc' ? { tokenAddress: USDC_BASE } : {}),
      }),
      // Per inprocess docs /distribute is NOT idempotent, so a timeout is
      // INDETERMINATE — never auto-retry (the per-call balance-gate at plan
      // time already ensures we only ask for funded splits, and a genuinely
      // missed one is retried by the artist's next click, which re-reads
      // balances). Bounded so one slow split can't pin the whole fan-out.
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(
        `[distribute-all] upstream ${res.status} for ${splitAddress} (${currency}): ${body.slice(0, 200)}`,
      )
      return false
    }
    return true
  } catch (err) {
    console.error(
      `[distribute-all] upstream error for ${splitAddress} (${currency}): ${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`distribute-all:${ip}`, 6, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) return errorResponse(500, 'INPROCESS_API_KEY not configured')

  let body: { callerAddress?: string; signature?: string; nonce?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  const { callerAddress, signature, nonce } = body
  if (!callerAddress || !isAddress(callerAddress)) {
    return errorResponse(401, 'callerAddress required')
  }
  if (!signature || !nonce) return errorResponse(401, 'signature and nonce required')

  // Signature binds the caller + nonce to the batch. No per-split binding is
  // needed: the server resolves the caller's OWN splits, and distribution can
  // only pay their fixed recipients (permissionless), so there's nothing to
  // redirect. The nonce prevents replay.
  const message = `Distribute all Kismet splits\nAddress: ${callerAddress.toLowerCase()}\nNonce: ${nonce}`
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

  // Verify-then-consume: a failed sig leaves the nonce reusable.
  if (!(await consumeNonce(callerAddress, nonce))) {
    return errorResponse(401, 'Invalid or expired nonce')
  }

  // Per-artist single-flight lock: inprocess /distribute is non-idempotent, so
  // two overlapping distribute-all runs by the SAME artist could each fire a
  // distribute for the same still-funded split. The lock serialises them; the
  // second gets a clean "already running".
  const lockKey = perArtistLockKey(callerAddress)
  // Fail CLOSED: a Redis error resolves to null → 429, NOT proceed-without-lock.
  // The lock guards a non-idempotent, gas-spending fan-out; the safe failure is
  // "make them retry", never "run unguarded". NX-held also returns null here.
  const gotLock = await redis.set(lockKey, '1', { nx: true, ex: LOCK_TTL_S }).catch(() => null)
  if (gotLock !== 'OK') {
    return errorResponse(429, 'A distribution is already in progress — try again shortly')
  }

  // Platform-wide in-flight governor — a burst of artists queues rather than
  // flooding the single shared relay. Released in finally alongside the lock.
  if (!(await acquireDistributeSlot())) {
    await redis.del(lockKey).catch(() => {})
    return errorResponse(429, 'The network is busy settling payouts — try again shortly')
  }

  try {
    const jobs = await resolveArtistSplitJobs(callerAddress)
    const funded = jobs.filter((j) => j.ethWei > 0n || j.usdcBase > 0n)
    if (funded.length === 0) {
      return NextResponse.json({
        moments: 0,
        requested: 0,
        distributed: 0,
        failed: 0,
        quotaBlocked: 0,
        remaining: 0,
      })
    }

    const ethUsd = await getEthUsd()
    const selected = planDistributeAll(funded, ethUsd, DISTRIBUTE_ALL_CAP)
    // Expand selected splits into (split, currency) distribute units.
    const units = selected.flatMap((j) =>
      jobCurrencies(j).map((currency) => ({ splitAddress: j.splitAddress, currency })),
    )

    let distributed = 0
    let failed = 0
    let quotaBlocked = 0
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < units.length) {
        const u = units[next++]
        // Quota is consumed per sponsored tx (atomic INCR), bounding platform
        // gas per identity. Once exhausted, stop asking — remaining units are
        // reported so the artist knows to finish tomorrow / next click.
        if (!(await consumeUserQuota('distribute', callerAddress, 1))) {
          quotaBlocked++
          continue
        }
        const ok = await distributeOne(apiKey, u.splitAddress, u.currency)
        if (ok) distributed++
        else failed++
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(FANOUT_CONCURRENCY, units.length) }, worker),
    )

    // Drained balances → bust the 60s pending cache so the card refreshes.
    await invalidatePendingCache(callerAddress)

    return NextResponse.json({
      moments: selected.length,
      requested: units.length,
      distributed,
      failed,
      quotaBlocked,
      // Funded splits beyond this invocation's cap — the artist clicks again to
      // settle them (the drained ones will have dropped out by then).
      remaining: Math.max(0, funded.length - selected.length),
    })
  } catch (err) {
    console.error('[distribute-all] failed', err)
    return errorResponse(502, 'Could not resolve or distribute splits')
  } finally {
    await releaseDistributeSlot()
    await redis.del(lockKey).catch(() => {})
  }
}
