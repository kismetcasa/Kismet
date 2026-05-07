import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage, type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { serverBaseClient } from '@/lib/rpc'
import { checkSmartWalletAdmin } from '@/lib/smartWalletPreflight'

/**
 * Fallback admin check via on-chain `permissions` read. Inprocess's indexer
 * runs minutes behind a fresh mint, so a legit creator can transiently fail
 * the inprocess /moment lookup. The on-chain ADMIN bit is authoritative for
 * any token Zora minted, regardless of indexer state.
 *
 * Reads ARE OR'd (token-scope + collection-wide tokenId 0) to mirror Zora's
 * `_hasAnyPermission`. defaultAdmin lives in tokenId 0, so a creator who
 * never received per-token grants still passes via the collection-wide row.
 */
async function isOnChainAdmin(collectionAddress: string, tokenId: string, caller: string): Promise<boolean> {
  try {
    const client = serverBaseClient()
    const tokenScopedPerms = await readPermissions(
      client,
      collectionAddress as Address,
      BigInt(tokenId),
      caller as Address,
    )
    if (hasAdminBit(tokenScopedPerms)) return true
    // Collection-wide admin (tokenId 0) also counts — that's where defaultAdmin lives.
    const collectionWidePerms = await readPermissions(
      client,
      collectionAddress as Address,
      0n,
      caller as Address,
    )
    return hasAdminBit(collectionWidePerms)
  } catch {
    return false
  }
}

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
    // Set by the client when re-submitting after a successful on-chain
    // authorize. Bypasses the smart-wallet ADMIN preflight to avoid
    // looping the user through a redundant authorize when a public-RPC
    // node returns stale (pre-grant) state. Inprocess remains the
    // authoritative source — if the on-chain bit really is missing,
    // its gas-estimation will surface the actual revert.
    isRetry?: boolean
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
    // tokenId interpolated into the signed message and the moment-meta KV
    // key — restrict to digits to prevent any control-char shenanigans.
    if (!r.tokenId || !/^\d+$/.test(String(r.tokenId))) {
      return NextResponse.json({ error: `invalid tokenId: ${r.tokenId}` }, { status: 400 })
    }
  }

  // The signed message authorizes airdropping exactly ONE tokenId; if a
  // tampered client mixes tokenIds in the recipients array, only the first
  // is actually verified by the signature. Enforce uniformity here so a
  // single signature cannot fan out to airdrop different tokens.
  const tokenId = body.recipients[0].tokenId
  if (body.recipients.some((r) => r.tokenId !== tokenId)) {
    return NextResponse.json(
      { error: 'all recipients must share the same tokenId' },
      { status: 400 },
    )
  }

  // Verify the caller is the moment creator via wallet signature
  if (!body.callerAddress || !isAddress(body.callerAddress)) {
    return NextResponse.json({ error: 'callerAddress required' }, { status: 401 })
  }
  if (!body.signature || !body.nonce) {
    return NextResponse.json({ error: 'signature and nonce required' }, { status: 401 })
  }

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

  // Confirm caller is creator or admin. Inprocess's /moment endpoint
  // returns `momentAdmins: string[]` — an unordered list including
  // platform smart wallets, factory grants, and the actual minter. We
  // accept any caller in that list (creator OR delegated admin), so the
  // ordering doesn't matter here. On-chain ADMIN bit is the fallback for
  // fresh tokens the indexer hasn't picked up yet.
  const callerLower = body.callerAddress.toLowerCase()
  let authorized = false
  try {
    const momentUrl = new URL(`${INPROCESS_API}/moment`)
    momentUrl.searchParams.set('collectionAddress', body.collectionAddress)
    momentUrl.searchParams.set('tokenId', tokenId)
    momentUrl.searchParams.set('chainId', '8453')
    const momentRes = await fetch(momentUrl.toString(), { headers: { Accept: 'application/json' } })
    if (momentRes.ok) {
      const momentData = (await momentRes.json()) as { momentAdmins?: unknown }
      const adminsLower = Array.isArray(momentData.momentAdmins)
        ? momentData.momentAdmins
            .filter((a): a is string => typeof a === 'string')
            .map((a) => a.toLowerCase())
        : []
      authorized = adminsLower.includes(callerLower)
    }
  } catch {
    // Fall through to on-chain check.
  }
  if (!authorized) {
    authorized = await isOnChainAdmin(body.collectionAddress, tokenId, body.callerAddress)
  }
  if (!authorized) {
    return NextResponse.json({ error: 'Only the moment creator or an admin may airdrop' }, { status: 403 })
  }

  // Pre-flight: confirm the artist's inprocess smart wallet has ADMIN at
  // the moment's tokenId or collection-wide. Mirrors Zora's
  // _hasAnyPermission OR check that adminMint runs upstream — so a
  // pre-flight pass means inprocess's call should also pass (modulo
  // indexer lag). On RPC or smart-wallet-lookup failure, fall through
  // and let inprocess be the source of truth: a flaky read shouldn't
  // block a user whose state on chain is actually fine.
  //
  // Skipped on retries (`isRetry`): the client just landed an on-chain
  // authorize and is re-submitting. A preflight 'unauthorized' result
  // here almost always means RPC node staleness (one of Base's public
  // nodes hasn't synced the grant yet), not a real missing bit — so
  // bouncing the user back to authorize again would be a frustrating
  // dead-end. Let inprocess decide.
  if (!body.isRetry) {
    const preflight = await checkSmartWalletAdmin(
      body.callerAddress,
      body.collectionAddress,
      [BigInt(tokenId), 0n],
    )
    // Always log so production deployments leave a trail when users
    // hit AUTHORIZE_REQUIRED — without this, the only signal is the
    // 403 status code, which doesn't tell us *which* smart wallet was
    // checked or *what* perms it actually had. Both are needed to
    // diagnose the "I already authorized" reports.
    console.log('[airdrop] preflight', {
      caller: body.callerAddress,
      collection: body.collectionAddress,
      tokenId,
      ...preflight,
    })
    if (preflight.status === 'unauthorized') {
      return NextResponse.json(
        {
          code: 'AUTHORIZE_REQUIRED',
          error:
            "This collection hasn't authorized Kismet for minting. One-time onchain grant from your wallet.",
          collectionAddress: body.collectionAddress,
          // Surface the smart wallet + per-scope perms so the client
          // can show the user *which* address needs ADMIN and *what*
          // bits it currently holds. If the user thinks they
          // authorized a different address (or granted MINTER instead
          // of ADMIN), this is what makes the discrepancy visible.
          smartWallet: preflight.smartWallet,
          perms: preflight.perms,
        },
        { status: 403 },
      )
    }
  }

  // Consume nonce only after all auth + pre-flight checks pass — a
  // failure on any of those leaves the nonce reusable so the user
  // doesn't have to fetch a fresh one before the next attempt.
  const nonceValid = await consumeNonce(body.callerAddress, body.nonce)
  if (!nonceValid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
  }

  // Inprocess expects the same `moment: { collectionAddress, tokenId,
  // chainId }` envelope used by /moment/update-uri (their Zod validator
  // returns "Invalid input: moment Invalid input: expected object, received
  // undefined" when omitted). Recipients ride alongside as a flat array of
  // { recipientAddress, tokenId } so per-recipient tokenIds are still
  // permitted by the upstream schema.
  const upstreamPayload = {
    moment: {
      collectionAddress: body.collectionAddress,
      tokenId,
      chainId: 8453,
    },
    recipients: body.recipients,
  }

  try {
    const res = await fetch(`${INPROCESS_API}/moment/airdrop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify(upstreamPayload),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'upstream error', detail: text.slice(0, 200) }, { status: 502 })
    }

    // Log upstream rejections so we can debug from Vercel logs without
    // bothering the user. Includes the wire payload + status for context.
    if (!res.ok) {
      console.warn('[airdrop] inprocess rejected', {
        status: res.status,
        body: parsed,
        sent: upstreamPayload,
      })
    }

    // The artist's inprocess smart wallet must hold ADMIN on the target
    // collection for the upstream adminMint to land — same constraint
    // /api/mint has. When inprocess says so verbatim ("The account does
    // not have admin permission for this collection"), surface a
    // structured 403 the client can detect and route the artist to the
    // Authorize banner on /collection/{address} (a one-click on-chain
    // grant from their own wallet, since they're defaultAdmin).
    if (
      !res.ok &&
      parsed &&
      typeof parsed === 'object' &&
      /admin permission/i.test(
        String(
          (parsed as Record<string, unknown>).error ??
            (parsed as Record<string, unknown>).message ??
            (parsed as Record<string, unknown>).detail ??
            '',
        ),
      )
    ) {
      return NextResponse.json(
        {
          code: 'AUTHORIZE_REQUIRED',
          error:
            "This collection hasn't authorized Kismet for minting. One-time onchain grant from your wallet.",
          collectionAddress: body.collectionAddress,
        },
        { status: 403 },
      )
    }

    // Fan-out: notify each airdrop recipient that they received a token from
    // the creator. Fire-and-forget — KV failures never undo the on-chain
    // airdrop. Mirrors the mint follower-fanout pattern in lib/mint-proxy.ts.
    if (res.ok) {
      void (async () => {
        try {
          const collectionLower = body.collectionAddress!.toLowerCase()
          const meta = await getMomentMeta(collectionLower, tokenId).catch(() => null)
          await Promise.all(
            body.recipients!
              .filter((r) => r.recipientAddress.toLowerCase() !== body.callerAddress!.toLowerCase())
              .map((r) =>
                writeNotification({
                  type: 'airdrop',
                  recipient: r.recipientAddress,
                  actor: body.callerAddress,
                  tokenAddress: collectionLower,
                  tokenId: r.tokenId,
                  tokenName: meta?.name,
                }),
              ),
          )
        } catch {
          // notifications are non-critical
        }
      })()
    }

    return NextResponse.json(parsed, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'upstream unreachable' }, { status: 502 })
  }
}
