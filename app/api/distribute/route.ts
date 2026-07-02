import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API, inprocessUrl } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'
import { getStoredSplits } from '@/lib/splits'
import { ERC20_ABI, USDC_BASE, ZORA_CREATOR_REWARD_RECIPIENT_ABI } from '@/lib/zoraMint'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { errorResponse } from '@/lib/apiResponse'
import { consumeUserQuota } from '@/lib/userQuota'
import { serverBaseClient } from '@/lib/rpc'
import { ADMIN_ADDRESS } from '@/lib/config'

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
  const message = `Distribute Kismet split\nCollection: ${collectionAddress.toLowerCase()}\nToken: ${tokenId}\nSplit: ${splitAddress.toLowerCase()}\nCurrency: ${currency}\nAddress: ${callerAddress.toLowerCase()}\nNonce: ${nonce}`
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
  // anyone could trigger distribute on arbitrary contract addresses. The
  // stored recipient list is reused for authorization and the payout
  // notification fan-out below.
  const stored = await getStoredSplits(collectionAddress, tokenId)
  if (!stored.hasSplits) {
    return errorResponse(403, 'No splits registered for this token')
  }

  // Authorize the caller as creator, moment admin, recipient, OR the Kismet
  // platform admin. Distribution is permissionless on 0xSplits (it can only
  // pay the fixed recipients, never redirect funds), so widening the roster
  // is safe; platform-sponsored gas stays bounded by the per-user quota below
  // (the platform admin is quota-exempt, by design — it's a support lever).
  const callerLower = callerAddress.toLowerCase()
  const isRecipient = stored.recipients.some((r) => r.address.toLowerCase() === callerLower)

  // Platform admin (ADMIN_ADDRESS) — break-glass override so support can
  // unstick a payout a user reports as missing on any moment. The EOA-only
  // signature gate above already proved the caller holds this key.
  const isPlatformAdmin = !!ADMIN_ADDRESS && callerLower === ADMIN_ADDRESS

  // KV moment-meta creator — the EOA mint-proxy recorded at mint. Preferred
  // over inprocess's momentAdmins, which often lists the platform smart
  // wallet rather than the creator's EOA, locking the creator out otherwise.
  const meta = await getMomentMeta(collectionAddress, tokenId)
  const isKvCreator = meta?.creator?.toLowerCase() === callerLower

  let authorized = isRecipient || isKvCreator || isPlatformAdmin
  // Only consult inprocess's momentAdmins when the cheap KV/recipient signals
  // didn't already authorize — saves an upstream round-trip in the common case.
  // /moment returns `momentAdmins: string[]`, an unordered list; .includes()
  // accepts any entry (creator or delegated admin), so ordering doesn't matter.
  if (!authorized) {
    try {
      const momentUrl = inprocessUrl('/moment', { collectionAddress, tokenId, chainId: '8453' })
      const momentRes = await fetch(momentUrl, { headers: { Accept: 'application/json' } })
      if (!momentRes.ok) {
        return errorResponse(403, 'Could not verify moment creator')
      }
      const momentData = (await momentRes.json()) as { momentAdmins?: unknown }
      const adminsLower = Array.isArray(momentData.momentAdmins)
        ? momentData.momentAdmins
            .filter((a): a is string => typeof a === 'string')
            .map((a) => a.toLowerCase())
        : []
      authorized = adminsLower.includes(callerLower)
    } catch {
      return errorResponse(502, 'Could not verify moment creator')
    }
  }
  if (!authorized) {
    return errorResponse(403, 'Only the moment creator, an admin, or a split recipient may distribute')
  }

  // Bind splitAddress to the token: it must be the token's on-chain
  // creator-reward-recipient. Without this, being authorized on *one* moment
  // would let a caller pass any split contract's address and have the
  // platform sponsor its distribution (no theft — 0xSplits only pays the
  // fixed recipients — but gas griefing + bogus payout notifications).
  try {
    const onchainSplit = await serverBaseClient().readContract({
      address: collectionAddress as `0x${string}`,
      abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
      functionName: 'getCreatorRewardRecipient',
      args: [BigInt(tokenId)],
    })
    if (onchainSplit.toLowerCase() !== splitAddress.toLowerCase()) {
      return errorResponse(400, 'splitAddress does not match the token on-chain split')
    }
  } catch {
    return errorResponse(502, 'Could not verify split address')
  }

  // Bound platform-sponsored gas: an authorized owner could otherwise spam
  // distribute on their own token (each call is a sponsored on-chain tx).
  // Debited after the ownership check so a non-owner never touches the
  // bucket. Admin bypasses inside consumeUserQuota.
  const withinQuota = await consumeUserQuota('distribute', callerAddress, 1)
  if (!withinQuota) {
    return errorResponse(429, 'Daily distribute limit reached — try again tomorrow')
  }

  // Capture the split's undistributed balance before the tx so each payout
  // notification can show the recipient their share (balance × allocation).
  // Best-effort: on read failure we omit amounts rather than block the payout.
  let balanceBefore = 0n
  try {
    const client = serverBaseClient()
    balanceBefore =
      currency === 'usdc'
        ? await client.readContract({
            address: USDC_BASE,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [splitAddress as `0x${string}`],
          })
        : await client.getBalance({ address: splitAddress as `0x${string}` })
  } catch {
    balanceBefore = 0n
  }

  // Forward only the specific fields inprocess expects — never relay arbitrary
  // body keys, which could ride along to undocumented upstream parameters.
  // Per inprocess docs (payments/distribute): tokenAddress is required for
  // ERC20 distributions (defaults to native ETH if omitted).
  const upstreamBody = {
    splitAddress,
    chainId: 8453,
    ...(currency === 'usdc' ? { tokenAddress: USDC_BASE } : {}),
  }

  let res: Response
  try {
    res = await fetch(`${INPROCESS_API}/distribute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify(upstreamBody),
      // Generous timeout — distribution submits an on-chain tx, legitimately
      // slow. Per inprocess docs this call is NOT idempotent (re-sending
      // "will likely execute multiple distributions"), so a timeout is
      // INDETERMINATE: surface 502 and never auto-retry, or we risk paying out
      // twice.
      signal: AbortSignal.timeout(45_000),
    })
  } catch (err) {
    // Network-level failure reaching inprocess. Without this guard the throw
    // bubbles to a bare 500 with no body — indistinguishable from the
    // missing-key 500 above and impossible to diagnose from logs.
    console.error(
      `[distribute] upstream unreachable: ${err instanceof Error ? err.message : String(err)} | request: ${JSON.stringify(upstreamBody)}`,
    )
    // Detail is logged above, NOT returned — the raw message embeds the
    // inprocess URL/topology and reaches the client otherwise.
    return NextResponse.json({ error: 'upstream unreachable' }, { status: 502 })
  }

  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    console.error(
      `[distribute] upstream non-JSON: status=${res.status} body=${text.slice(0, 500)} | request: ${JSON.stringify(upstreamBody)}`,
    )
    return NextResponse.json(
      { error: 'upstream error', status: res.status, detail: text.slice(0, 200) },
      { status: 502 },
    )
  }

  // Log non-OK upstream responses so the actual inprocess error (bad request
  // shape, key rejected, smart-wallet not admin, on-chain revert) is visible
  // server-side — the only other signal is the client toast.
  if (!res.ok) {
    console.error(
      `[distribute] upstream ${res.status}: ${JSON.stringify(data).slice(0, 500)} | request: ${JSON.stringify(upstreamBody)}`,
    )
  }

  // Fan-out payout notifications on inprocess 2xx (best-effort). Reuses the
  // recipient list + moment meta already read for authorization, and stamps
  // each recipient's share of the pre-distribute balance so the notification
  // shows how much they received. writeNotification's self-check filters
  // caller-as-recipient.
  if (res.ok && stored.recipients.length) {
    after(async () => {
      try {
        await Promise.all(
          stored.recipients.map((r) => {
            const share =
              balanceBefore > 0n
                ? (balanceBefore * BigInt(r.percentAllocation)) / 100n
                : 0n
            return writeNotification({
              type: 'payout',
              recipient: r.address,
              actor: callerAddress,
              tokenAddress: collectionAddress,
              tokenId,
              tokenName: meta?.name,
              currency,
              ...(share > 0n ? { price: share.toString() } : {}),
            })
          }),
        )
      } catch {}
    })
  }

  return NextResponse.json(data, { status: res.status })
}
