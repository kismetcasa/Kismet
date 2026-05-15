import { after, type NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { INPROCESS_API } from './inprocess'
import { trackWallet } from './profile'
import { checkRateLimit, getClientIp } from './ratelimit'
import { fanoutToFollowers, setMomentMeta, writeNotification } from './notifications'
import { setMomentContent } from './momentContent'
import { checkSmartWalletAdmin } from './smartWalletPreflight'
import { markCreatedMint } from './kv'
import { setStoredSplits, validateSplitsArray, type SplitRecipient } from './splits'

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
  const allowed = await checkRateLimit(`${rateLimitKey}:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const account = typeof body?.account === 'string' ? body.account : undefined
  if (account) void trackWallet(account)

  const tokenObj = (body?.token as Record<string, unknown> | undefined) ?? {}
  const maxSupplyRaw = tokenObj.maxSupply ?? body?.maxSupply
  if (maxSupplyRaw !== undefined) {
    const ms = Number(maxSupplyRaw)
    if (!Number.isInteger(ms) || ms < 1) {
      return NextResponse.json({ error: 'maxSupply must be a positive integer' }, { status: 400 })
    }
  }

  // Validate splits up-front so a bad payload (duplicates, mis-summed,
  // unsorted, malformed addresses) returns a 400 with a clear message
  // instead of letting the request reach inprocess just to fail upstream
  // with a generic "execution reverted" from SplitMain.
  const splitsValidation = validateSplits(body?.splits)
  if (splitsValidation.kind === 'error') {
    return NextResponse.json({ error: splitsValidation.message }, { status: 400 })
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
    return NextResponse.json(
      {
        error:
          'contract must include either an address (existing collection) or name+uri (deploy a new one)',
      },
      { status: 400 },
    )
  }

  // body.name is our private hint for moment-meta; never forward to InProcess.
  // For writing moments inprocess uses `title` at top level — fall back to
  // that so we still capture a display name even if `name` is omitted.
  // Replace splits with the normalized (sorted, deduped) version when present
  // so downstream gets a SplitMain-compatible array regardless of client state.
  const { name: bodyName, splits: _droppedSplits, ...rest } = body
  const forwardBody: Record<string, unknown> =
    splitsValidation.kind === 'ok'
      ? { ...rest, splits: splitsValidation.splits }
      : rest
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
    typeof (body?.contract as Record<string, unknown> | undefined)?.address === 'string'
      ? ((body.contract as Record<string, unknown>).address as string)
      : undefined
  if (account && collectionAddress) {
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
    const r = data as { contractAddress?: string; tokenId?: string }
    const contractAddress = r.contractAddress
    const tokenId = r.tokenId

    if (contractAddress && tokenId && account) {
      // Only writing moments carry tokenContent; media mints forward
      // tokenMetadataURI instead.
      const tokenContent =
        typeof tokenObj.tokenContent === 'string' ? tokenObj.tokenContent : undefined

      after(async () => {
        const tasks: Promise<unknown>[] = [
          markCreatedMint(contractAddress, tokenId).catch(() => {}),
          setMomentMeta(contractAddress, tokenId, { creator: account, name: displayName }).catch(() => {}),
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
          tasks.push(setMomentContent(contractAddress, tokenId, tokenContent).catch(() => {}))
        }
        if (splitsValidation.kind === 'ok' && splitsValidation.splits.length >= 2) {
          tasks.push(
            setStoredSplits(contractAddress, tokenId, splitsValidation.splits).catch(
              (err) => console.error('[mint-proxy] setStoredSplits failed', err),
            ),
          )
        }
        await Promise.all(tasks)
      })
    }
  }

  return NextResponse.json(data, { status: upstream.status })
}
