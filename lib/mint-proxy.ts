import { after, type NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from './apiResponse'
import { INPROCESS_API } from './inprocess'
import { CREATE_REFERRAL } from './config'
import { trackWallet } from './profile'
import { checkRateLimit, getClientIp } from './ratelimit'
import { bestEffort } from './bestEffort'
import { fanoutToFollowers, setMomentMeta, writeNotification } from './notifications'
import { setMomentContent } from './momentContent'
import { checkSmartWalletAdmin } from './smartWalletPreflight'
import { markCreatedMint } from './kv'
import { setStoredSplits, validateSplitsArray, type SplitRecipient } from './splits'
import { hasGateAccess, isPlatformPausedFor } from './gate'
import { isBlacklisted } from './blacklist'
import { recordPlatformTx } from './pass-validity'
import { verifyIntent } from './intentAuth'
import type { IntentAction, IntentEnvelope, MintBody } from './intent'
import { consumeUserQuota } from './userQuota'

// Conservative ceiling on tokenContent (writing-moment body forwarded to
// inprocess + persisted in setMomentContent). The existing IP rate limit
// bounds call frequency; this bounds per-call payload so a single mint
// can't push tens of MB of garbage through INPROCESS_API_KEY and our KV.
const MAX_TOKEN_CONTENT_BYTES = 10 * 1024 * 1024

type SplitsValidation =
  | { kind: 'absent' }
  | { kind: 'ok'; splits: SplitRecipient[] }
  | { kind: 'error'; message: string }

// Wraps validateSplitsArray to distinguish "no splits provided" (pass
// through to inprocess unchanged) from "provided but invalid" (400).
function validateSplits(raw: unknown): SplitsValidation {
  if (raw == null) return { kind: 'absent' }
  if (Array.isArray(raw) && raw.length === 0) return { kind: 'absent' }
  const result = validateSplitsArray(raw)
  if (!result.ok) return { kind: 'error', message: result.error }
  return { kind: 'ok', splits: result.splits }
}

export async function proxyMintRequest(
  req: NextRequest,
  rateLimitKey: string,
  endpoint: string,
): Promise<Response> {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`${rateLimitKey}:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  // body.account is required: it's the address we verify against the
  // intent signature, run gate/blacklist/pause checks on, and forward to
  // inprocess as the smart-wallet target. Without it none of those layers
  // can decide who's actually minting, so a no-account request would
  // forward to inprocess without any platform-side authorization. Reject
  // upfront; legitimate clients (MintForm) always include it.
  if (typeof body?.account !== 'string' || !isAddress(body.account)) {
    return errorResponse(400, 'account is required and must be a valid address')
  }
  const account = body.account
  void trackWallet(account)

  const tokenObj = (body?.token as Record<string, unknown> | undefined) ?? {}
  const maxSupplyRaw = tokenObj.maxSupply ?? body?.maxSupply
  if (maxSupplyRaw !== undefined) {
    const ms = Number(maxSupplyRaw)
    if (!Number.isInteger(ms) || ms < 1) {
      return errorResponse(400, 'maxSupply must be a positive integer')
    }
  }

  // Per-call cap on the writing-moment body — bounds what we forward to
  // inprocess + persist in setMomentContent. Only the string form costs
  // real bytes; other tokenContent shapes (e.g. references) are unaffected.
  if (typeof tokenObj.tokenContent === 'string'
      && Buffer.byteLength(tokenObj.tokenContent) > MAX_TOKEN_CONTENT_BYTES) {
    return errorResponse(413, 'tokenContent too large')
  }

  // Validate splits up-front so a bad payload (duplicates, mis-summed,
  // unsorted, malformed addresses) returns a 400 with a clear message
  // instead of letting the request reach inprocess just to fail upstream
  // with a generic "execution reverted" from SplitMain.
  const splitsValidation = validateSplits(body?.splits)
  if (splitsValidation.kind === 'error') {
    return errorResponse(400, splitsValidation.message)
  }

  // Strict routing: the body must identify a collection, either by
  // `contract.address` (existing) or by `contract.name + contract.uri`
  // (auto-deploy + first mint, the documented inprocess pattern).
  // Catching malformed payloads here gives a clearer error than the
  // opaque "invalid contract" inprocess would return upstream.
  const contractField = body?.contract as Record<string, unknown> | undefined
  const hasAddress =
    typeof contractField?.address === 'string' && isAddress(contractField.address)
  const hasNameAndUri =
    typeof contractField?.name === 'string' && contractField.name.trim().length > 0 &&
    typeof contractField?.uri === 'string' && contractField.uri.trim().length > 0
  if (!hasAddress && !hasNameAndUri) {
    return errorResponse(
      400,
      'contract must include either an address (existing collection) or name+uri (deploy a new one)',
    )
  }

  // Verify the caller actually controls body.account before any downstream
  // policy decisions key off it. Without this, the gate/blacklist/pause
  // checks are bypassable by setting body.account = ADMIN_ADDRESS (which
  // admin-bypasses every check) — and inprocess derives the executing
  // smart wallet from this same field, so a successful spoof could mint
  // Pass tokens via admin's smart wallet without the EOA's consent. The
  // signature is verified against the same body-derived typed-data the
  // user signed, so any tampered field (price, splits, recipient,
  // tokenURI, …) between client and server invalidates the signature.
  const action: IntentAction = rateLimitKey === 'write' ? 'write' : 'mint'
  const intentResult = await verifyIntent(
    body.intent as IntentEnvelope | undefined,
    action,
    account,
    body as MintBody,
  )
  if (!intentResult.ok) {
    return errorResponse(intentResult.status, intentResult.error)
  }

  // Platform-policy gates — meaningful because body.account is signature-
  // bound above. Three independent reads in parallel. For new-deploy
  // (hasNameAndUri without address) we use a sentinel zero target so the
  // gate's pass-collection-target rejection branch doesn't fire there;
  // the check reduces to "does this caller have a valid Pass". Default-
  // disabled: gate.enabled defaults false → hasGateAccess returns true.
  const targetForGate =
    typeof contractField?.address === 'string'
      ? contractField.address
      : '0x0000000000000000000000000000000000000000'
  const [blocked, paused, gateOk] = await Promise.all([
    isBlacklisted(account),
    isPlatformPausedFor(account),
    hasGateAccess(targetForGate, account),
  ])
  if (blocked) {
    return errorResponse(403, 'Address is blocked from minting')
  }
  if (paused) {
    return errorResponse(503, 'Platform is temporarily paused')
  }
  if (!gateOk) {
    return errorResponse(403, 'Kismet Creator pass required to mint')
  }

  // Per-address daily/weekly cap on platform-paid mint/write operations.
  // Debited AFTER the gates so a blocked or pass-less caller doesn't burn
  // their bucket. Admin bypasses inside consumeUserQuota.
  const withinQuota = await consumeUserQuota(action, account, 1)
  if (!withinQuota) {
    return errorResponse(429, `Daily ${action} limit reached — try again tomorrow`)
  }

  // body.name is our private hint for moment-meta; never forward to InProcess.
  // For writing moments inprocess uses `title` at top level — fall back to
  // that so we still capture a display name even if `name` is omitted.
  // Replace splits with the normalized (sorted, deduped) version when present
  // so downstream gets a SplitMain-compatible array regardless of client state.
  // token.createReferral is server-overwritten with CREATE_REFERRAL — without
  // this, a Pass-holder bypassing the form could supply their own address
  // there and capture the Zora protocol mint-fee referral on every collect
  // of their moment. Always inject the platform's value server-side.
  // Strip `intent` along with the other private/normalized fields so the
  // signature envelope never reaches inprocess — it's a server-only auth
  // artifact and would be flagged as an unknown field upstream.
  const { name: bodyName, splits: _droppedSplits, intent: _droppedIntent, ...rest } = body
  const sanitizedToken = {
    ...(tokenObj as Record<string, unknown>),
    createReferral: CREATE_REFERRAL,
  }
  const forwardBody: Record<string, unknown> = {
    ...(splitsValidation.kind === 'ok' ? { ...rest, splits: splitsValidation.splits } : rest),
    token: sanitizedToken,
  }
  const bodyTitle = typeof body?.title === 'string' ? body.title : undefined
  const displayName =
    (typeof bodyName === 'string' && bodyName) ||
    bodyTitle ||
    (typeof tokenObj.name === 'string' && (tokenObj.name as string)) ||
    undefined

  // Pre-flight: confirm the artist's inprocess smart wallet has ADMIN
  // at tokenId 0 of the target collection. setupNewToken (the gas-
  // estimation entry point for /moment/create + /moment/create/writing)
  // requires collection-wide ADMIN — without it, the userOp inprocess
  // submits reverts at gas estimation with "useroperation reverted:
  // execution reverted" and a half-uploaded moment dies on the way
  // upstream. Catching it here returns a structured AUTHORIZE_REQUIRED
  // 403 so the client surfaces the actionable banner instead of a
  // generic "execution reverted" toast.
  //
  // RPC or smart-wallet-lookup failures fall through to inprocess —
  // a flaky read shouldn't deny a user whose state on chain is actually
  // fine. Inprocess remains the authoritative source on the call itself.
  const collectionAddress =
    typeof contractField?.address === 'string' ? (contractField.address as string) : undefined
  if (collectionAddress) {
    const preflight = await checkSmartWalletAdmin(account, collectionAddress, [0n])
    if (preflight.status === 'unauthorized') {
      return NextResponse.json(
        {
          code: 'AUTHORIZE_REQUIRED',
          error:
            "This collection hasn't authorized Kismet for minting. One-time onchain grant from your wallet.",
          collectionAddress,
          smartWallet: preflight.smartWallet,
          perms: preflight.perms,
        },
        { status: 403 },
      )
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = process.env.INPROCESS_API_KEY
  if (apiKey) headers['x-api-key'] = apiKey

  let upstream: Response
  try {
    upstream = await fetch(`${INPROCESS_API}/${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(forwardBody),
    })
  } catch (err) {
    // Network-level failure reaching inprocess. Surface as 502 with a
    // human-readable detail rather than letting it bubble to a bare 500.
    return NextResponse.json(
      {
        error: 'upstream unreachable',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    )
  }

  const text = await upstream.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    // Inprocess returned non-JSON (often an HTML error page from a 5xx).
    // Log the raw body so server-side debugging can see what actually
    // came back; surface a 502 with the snippet to the client.
    console.error(
      `[mint-proxy] upstream non-JSON response: status=${upstream.status} body=${text.slice(0, 500)}`,
    )
    return NextResponse.json(
      { error: 'upstream error', status: upstream.status, detail: text.slice(0, 200) },
      { status: 502 },
    )
  }

  // Always log non-OK upstream responses so we can diagnose on-chain
  // reverts (caller missing ADMIN on the collection, sale-config rejected,
  // splits contract failure, etc.). Request body is logged sans the
  // potentially-large tokenContent so writing-moments don't bloat the log.
  if (!upstream.ok) {
    const safeBody = { ...forwardBody }
    if (safeBody.token && typeof safeBody.token === 'object') {
      const t = safeBody.token as Record<string, unknown>
      if (typeof t.tokenContent === 'string' && t.tokenContent.length > 80) {
        safeBody.token = { ...t, tokenContent: `${t.tokenContent.slice(0, 80)}…` }
      }
    }
    console.error(
      `[mint-proxy] upstream ${upstream.status}: ${JSON.stringify(data).slice(0, 500)} | request: ${JSON.stringify(safeBody).slice(0, 500)}`,
    )
  }

  if (upstream.ok) {
    const r = data as { contractAddress?: string; tokenId?: string; hash?: string }
    const contractAddress = r.contractAddress
    const tokenId = r.tokenId
    const txHash = r.hash

    if (contractAddress && tokenId) {
      // Only writing moments carry tokenContent; media mints forward
      // tokenMetadataURI instead.
      const tokenContent =
        typeof tokenObj.tokenContent === 'string' ? tokenObj.tokenContent : undefined

      after(async () => {
        const tasks: Promise<unknown>[] = [
          markCreatedMint(contractAddress, tokenId).catch(bestEffort('mint-proxy.markCreatedMint', { contractAddress, tokenId })),
          setMomentMeta(contractAddress, tokenId, {
            creator: account,
            name: displayName,
            // Optional video duration probed client-side at mint time.
            // Validated as a finite positive number here; the helper
            // drops anything else from the persisted record.
            ...(typeof body.durationSec === 'number' &&
              Number.isFinite(body.durationSec) &&
              body.durationSec > 0
              ? { durationSec: body.durationSec }
              : {}),
          }).catch(bestEffort('mint-proxy.setMomentMeta', { contractAddress, tokenId, account })),
          writeNotification({
            type: 'mint',
            recipient: account,
            tokenAddress: contractAddress,
            tokenId,
            tokenName: displayName,
          }),
          fanoutToFollowers(account, {
            type: 'mint',
            tokenAddress: contractAddress,
            tokenId,
            tokenName: displayName,
          }),
        ]
        if (tokenContent) {
          tasks.push(setMomentContent(contractAddress, tokenId, tokenContent).catch(bestEffort('mint-proxy.setMomentContent', { contractAddress, tokenId })))
        }
        if (splitsValidation.kind === 'ok' && splitsValidation.splits.length >= 2) {
          tasks.push(
            setStoredSplits(contractAddress, tokenId, splitsValidation.splits).catch(
              (err) => console.error('[mint-proxy] setStoredSplits failed', err),
            ),
          )
        }
        // Flag this tx as platform-originated so the Pass-transfer webhook
        // credits the recipient with validity when the Transfer event arrives.
        // No-op (writes an unused Redis flag) when the target isn't the
        // configured Pass collection — the webhook filters by passCollection.
        // Without this, admin minting Passes via /api/mint would silently
        // deny the recipient validity and force a manual /admin/pass grant.
        if (txHash) {
          tasks.push(
            recordPlatformTx(txHash).catch(
              bestEffort('mint-proxy.recordPlatformTx', { txHash }),
            ),
          )
        }
        await Promise.all(tasks)
      })
    }
  }

  return NextResponse.json(data, { status: upstream.status })
}
