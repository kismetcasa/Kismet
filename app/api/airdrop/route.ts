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
 * Reads ADMIN status of the inprocess operator smart wallet on the
 * target collection. This is the wallet inprocess routes user-relayed
 * admin-mint flows (notably airdrop) through under our shared
 * INPROCESS_API_KEY — see `OPERATOR_SMART_WALLET` env var docs and
 * lib/healthcheck.ts. ORs the per-token row with the collection-wide
 * row (tokenId 0) to mirror Zora's `_hasAnyPermission` check.
 *
 * Returns:
 *   - 'authorized'   — operator has ADMIN at one of the requested scopes
 *   - 'unauthorized' — operator is configured AND both reads succeeded AND
 *                      neither row holds ADMIN. Caller should AUTHORIZE_REQUIRED.
 *   - 'unknown'      — operator env is unset (dev / fork — no-op the check)
 *                      OR an RPC read failed (don't block on a flaky read).
 */
async function checkOperatorAuthorized(
  collectionAddress: string,
  tokenId: string,
): Promise<{ status: 'authorized' | 'unauthorized' | 'unknown'; operator?: string; perms?: bigint[] }> {
  const operator = process.env.OPERATOR_SMART_WALLET
  if (!operator || !isAddress(operator) || !isAddress(collectionAddress)) {
    return { status: 'unknown' }
  }
  try {
    const client = serverBaseClient()
    const [tokenScope, collectionWide] = await Promise.all([
      readPermissions(client, collectionAddress as Address, BigInt(tokenId), operator as Address),
      readPermissions(client, collectionAddress as Address, 0n, operator as Address),
    ])
    const effective = tokenScope | collectionWide
    return {
      status: hasAdminBit(effective) ? 'authorized' : 'unauthorized',
      operator,
      perms: [tokenScope, collectionWide],
    }
  } catch {
    return { status: 'unknown', operator }
  }
}

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
  // Capture inprocess's reported admin set so the upstream-error
  // branch below can surface it for diagnostics — comparing
  // momentAdmins (inprocess's view) against the on-chain ADMIN
  // grants tells us whether a rejection is indexer lag (operator
  // missing from the list, but on-chain ADMIN is set) or a wallet
  // mismatch (operator IS in the list but inprocess still rejects,
  // meaning they route through some other identity entirely).
  let inprocessMomentAdmins: string[] = []
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
      inprocessMomentAdmins = adminsLower
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
  // Track the preflight verdict outside the `if` so the upstream-error
  // path below can tell the difference between "chain genuinely has no
  // ADMIN" (real auth issue, prompt the user) and "chain has ADMIN but
  // inprocess hasn't indexed it yet" (lag, tell them to wait). Without
  // this distinction the client loops the user through repeated
  // authorize prompts whenever inprocess lags behind chain state.
  let preflightAuthorized = false
  // Last preflight diagnostic — so the upstream-error branch can surface
  // the smart wallet + perms it read in its 403 response (otherwise the
  // user only sees `code: 'INDEXER_LAG'` and we can't tell whether it's
  // genuinely lag, a wallet mismatch, or a wrong-bit grant).
  let preflightSnapshot: { smartWallet?: string; perms?: Array<{ tokenId: string; value: string | null }> } = {}
  if (!body.isRetry) {
    // The operator check is the one that matters for routing — that's
    // the wallet inprocess actually uses for relayed adminMint calls.
    // If it lacks ADMIN, the upstream call will revert with "admin
    // permission" no matter what the artist's smart wallet holds.
    // Surface AUTHORIZE_REQUIRED here so the client routes the user to
    // the operator-grant flow instead of looping them through the
    // (unrelated) artist-grant flow.
    //
    // If OPERATOR_SMART_WALLET is unset (dev / fork), this returns
    // 'unknown' and we fall through to the legacy artist-smart-wallet
    // preflight below. That path doesn't reflect what inprocess will
    // do but it's the best signal we have without the operator config.
    const operator = await checkOperatorAuthorized(body.collectionAddress, tokenId)
    console.log('[airdrop] operator-preflight', {
      caller: body.callerAddress,
      collection: body.collectionAddress,
      tokenId,
      ...operator,
      perms: operator.perms?.map((p) => p.toString()),
    })
    if (operator.status === 'unauthorized') {
      return NextResponse.json(
        {
          code: 'AUTHORIZE_REQUIRED',
          error:
            'Authorize Kismet platform on this collection so it can submit airdrops on your behalf.',
          collectionAddress: body.collectionAddress,
          // The grantee the client needs to addPermission ADMIN to.
          // The client-side authorize flow targets this address, NOT
          // the artist's smart wallet (granting that one doesn't help
          // because inprocess routes airdrops through the operator).
          grantee: operator.operator,
          scope: 'operator',
          perms: operator.perms?.map((p) => p.toString()),
        },
        { status: 403 },
      )
    }
    if (operator.status === 'authorized') {
      preflightAuthorized = true
      preflightSnapshot = {
        smartWallet: operator.operator,
        perms: [
          { tokenId, value: operator.perms?.[0]?.toString() ?? null },
          { tokenId: '0', value: operator.perms?.[1]?.toString() ?? null },
        ],
      }
    } else {
      // operator.status === 'unknown' — operator env unset or RPC
      // failed. Fall back to the legacy artist-wallet preflight so
      // the dev-mode flow still has *some* signal, even if it doesn't
      // reflect what inprocess actually routes through.
      const preflight = await checkSmartWalletAdmin(
        body.callerAddress,
        body.collectionAddress,
        [BigInt(tokenId), 0n],
      )
      console.log('[airdrop] artist-preflight (operator unknown)', {
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
            smartWallet: preflight.smartWallet,
            perms: preflight.perms,
          },
          { status: 403 },
        )
      }
      preflightAuthorized = preflight.status === 'authorized'
      preflightSnapshot = { smartWallet: preflight.smartWallet, perms: preflight.perms }
    }
  }

  // Consume nonce only after all auth + pre-flight checks pass — a
  // failure on any of those leaves the nonce reusable so the user
  // doesn't have to fetch a fresh one before the next attempt.
  const nonceValid = await consumeNonce(body.callerAddress, body.nonce)
  if (!nonceValid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
  }

  // api.inprocess.world wants the body wrapped in `moment: {…}`
  // (rejects the flat shape the public docs cURL on inprocess.world
  // shows — empirically the validator demands the envelope). Per-
  // recipient tokenIds stay on each recipient; the validator above
  // enforces uniformity so one signature can't fan out across tokens.
  //
  // `account` is undocumented on the airdrop endpoint but is the
  // same override mint-proxy sends to /moment/create (see
  // lib/mint-proxy.ts). Without it, inprocess routes the call through
  // whichever smart wallet the platform `INPROCESS_API_KEY` resolves
  // to — which is NOT the artist's smart wallet (the one that holds
  // ADMIN at deploy time via Kismet's setupActions). The chain check
  // passes, the upstream call rejects, and the user is stuck.
  // Forwarding the artist's EOA here lets inprocess re-derive the
  // artist's smart wallet and call as that identity — the same one
  // with ADMIN.
  const upstreamPayload = {
    moment: {
      collectionAddress: body.collectionAddress,
      tokenId,
      chainId: 8453,
    },
    recipients: body.recipients,
    account: body.callerAddress,
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
    // not have admin permission for this collection") we surface a
    // structured 403, but we need to distinguish two very different
    // situations:
    //
    //   - preflight passed (chain has ADMIN) OR caller is retrying after
    //     a successful authorize → inprocess's indexer simply hasn't
    //     caught up yet. Tag as INDEXER_LAG so the client shows a
    //     "wait + retry" toast instead of prompting another authorize
    //     that the user has already completed.
    //   - preflight verdict was 'unknown' (RPC blip) OR was skipped on
    //     a non-retry submit → we can't prove the chain is authorized,
    //     so be conservative and route them to the authorize flow.
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
      const treatAsIndexerLag = body.isRetry || preflightAuthorized
      // Pull every diagnostic field we have onto the response so the
      // browser console (which is all the user can see in a deployed
      // build) shows enough to tell whether the next iteration needs
      // a different override, per-artist API keys, or a co-grant.
      // `upstreamError` is inprocess's verbatim message; `upstreamSent`
      // is the exact payload they rejected (modulo our `account`
      // override above); `smartWallet` + `perms` come from the
      // preflight read so we can verify on-chain state matches what
      // inprocess thinks.
      const upstreamError = String(
        (parsed as Record<string, unknown>).error ??
          (parsed as Record<string, unknown>).message ??
          (parsed as Record<string, unknown>).detail ??
          '',
      )
      const upstreamSent = {
        collectionAddress: upstreamPayload.moment.collectionAddress,
        tokenId: upstreamPayload.moment.tokenId,
        recipientCount: upstreamPayload.recipients.length,
        account: upstreamPayload.account,
      }
      // Surface inprocess's own view of the collection's admin set so
      // the next failure tells us which scenario we're in:
      //
      //   1. operator NOT in inprocessMomentAdmins, but on-chain perms
      //      show ADMIN → real indexer lag. Inprocess just hasn't
      //      re-indexed since our addPermission tx landed. Wait + retry.
      //   2. operator IS in inprocessMomentAdmins, upstream STILL says
      //      "no admin" → inprocess sees the grant but routes airdrops
      //      through some OTHER wallet. The OPERATOR_SMART_WALLET we
      //      configured isn't actually the right grantee for airdrop;
      //      identify the real one and re-grant.
      //   3. operator NOT in inprocessMomentAdmins AND on-chain perms
      //      ALSO show no ADMIN → the addPermission tx never landed
      //      (user signed but it reverted, or wrong collection). Banner
      //      should re-show.
      const operatorLower = process.env.OPERATOR_SMART_WALLET?.toLowerCase()
      const operatorInInprocessAdmins = !!operatorLower && inprocessMomentAdmins.includes(operatorLower)
      return NextResponse.json(
        treatAsIndexerLag
          ? {
              code: 'INDEXER_LAG',
              error:
                "On-chain ADMIN is set but inprocess's indexer is still catching up. Wait a moment and retry.",
              collectionAddress: body.collectionAddress,
              upstreamError,
              upstreamSent,
              smartWallet: preflightSnapshot.smartWallet,
              perms: preflightSnapshot.perms,
              inprocessMomentAdmins,
              operatorInInprocessAdmins,
            }
          : {
              code: 'AUTHORIZE_REQUIRED',
              error:
                "This collection hasn't authorized Kismet for minting. One-time onchain grant from your wallet.",
              collectionAddress: body.collectionAddress,
              upstreamError,
              upstreamSent,
              smartWallet: preflightSnapshot.smartWallet,
              perms: preflightSnapshot.perms,
              inprocessMomentAdmins,
              operatorInInprocessAdmins,
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
