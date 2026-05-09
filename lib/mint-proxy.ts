import { type NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { INPROCESS_API } from './inprocess'
import { redis } from './redis'
import { trackWallet } from './profile'
import { checkRateLimit, getClientIp } from './ratelimit'
import { setMomentMeta, writeNotification } from './notifications'
import { setMomentContent } from './momentContent'
import { getFollowers } from './follows'
import { checkSmartWalletAdmin } from './smartWalletPreflight'
import { markCreatedMint } from './kv'

// 0xSplits' SplitMain caps usable recipients well below this in practice
// (gas-bound), but 50 is a generous safety net that no legitimate UI flow
// hits. Keeps a malformed body from blowing up the upstream call.
const MAX_SPLITS = 50

interface ValidatedSplit {
  address: string
  percentAllocation: number
}

type SplitsValidation =
  | { kind: 'absent' }
  | { kind: 'ok'; splits: ValidatedSplit[] }
  | { kind: 'error'; message: string }

/**
 * Validates and normalizes a splits array off the request body. Pre-empts
 * the on-chain SplitMain.createSplit revert (`InvalidSplit__*`) by catching
 * malformed input client-side and returning a clear 400. Returns the
 * normalized array sorted ascending by address — SplitMain requires that.
 */
function validateSplits(raw: unknown): SplitsValidation {
  if (raw === undefined || raw === null) return { kind: 'absent' }
  if (!Array.isArray(raw)) return { kind: 'error', message: 'splits must be an array' }
  if (raw.length === 0) return { kind: 'absent' }
  if (raw.length === 1) return { kind: 'error', message: 'splits require at least 2 recipients' }
  if (raw.length > MAX_SPLITS) {
    return { kind: 'error', message: `splits cannot exceed ${MAX_SPLITS} recipients` }
  }

  const seen = new Set<string>()
  const normalized: ValidatedSplit[] = []
  let sum = 0

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      return { kind: 'error', message: 'invalid splits entry shape' }
    }
    const e = entry as { address?: unknown; percentAllocation?: unknown }
    if (typeof e.address !== 'string' || !isAddress(e.address)) {
      return { kind: 'error', message: 'invalid splits address' }
    }
    // Inprocess docs require integer percentAllocation values summing to
    // exactly 100%. Rejecting decimals here pre-empts the on-chain
    // mis-parse that surfaced as a generic "execution reverted" upstream.
    if (
      typeof e.percentAllocation !== 'number' ||
      !Number.isInteger(e.percentAllocation) ||
      e.percentAllocation < 1 ||
      e.percentAllocation > 100
    ) {
      return { kind: 'error', message: 'splits allocation must be a whole number 1–100' }
    }
    const lower = e.address.toLowerCase()
    if (seen.has(lower)) {
      return { kind: 'error', message: `duplicate splits address ${e.address}` }
    }
    seen.add(lower)
    sum += e.percentAllocation
    normalized.push({ address: e.address, percentAllocation: e.percentAllocation })
  }

  // Strict 100 since allocations are now required to be integers — no
  // floating-point tolerance needed.
  if (sum !== 100) {
    return {
      kind: 'error',
      message: `splits must sum to exactly 100% (got ${sum}%)`,
    }
  }

  normalized.sort((a, b) => {
    const al = a.address.toLowerCase()
    const bl = b.address.toLowerCase()
    return al < bl ? -1 : al > bl ? 1 : 0
  })

  return { kind: 'ok', splits: normalized }
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
    console.log('[mint-proxy] preflight', {
      endpoint,
      caller: account,
      collection: collectionAddress,
      ...preflight,
    })
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
      // Positive tracking: every MintForm-mediated mint joins the
      // created-mints set so Mints feeds can filter strictly.
      void markCreatedMint(contractAddress, tokenId).catch(() => {})
      void setMomentMeta(contractAddress, tokenId, { creator: account, name: displayName }).catch(() => {})

      // Mirror the raw writing body to KV so the moment page can render
      // it during Arweave propagation lag — and as a permanent fallback
      // if the Turbo tx ID never settles to gateways. Only the writing
      // endpoint carries tokenContent; media mints forward
      // tokenMetadataURI instead, so the conditional naturally scopes
      // this to writes.
      const tokenContent =
        typeof tokenObj.tokenContent === 'string' ? tokenObj.tokenContent : undefined
      if (tokenContent) {
        void setMomentContent(contractAddress, tokenId, tokenContent).catch(() => {})
      }

      // Self-notification for the creator. No `actor` so NotificationRow
      // renders "your moment was created".
      void writeNotification({
        type: 'mint',
        recipient: account,
        tokenAddress: contractAddress,
        tokenId,
        tokenName: displayName,
      })

      // Fan-out to followers — anyone following the creator gets a "mint"
      // notification with `actor` set to the creator. NotificationRow keys
      // off `actor` to render "0xCREATOR minted "name"" for these.
      void (async () => {
        try {
          const followers = await getFollowers(account)
          await Promise.all(
            followers
              .filter((f) => f.toLowerCase() !== account.toLowerCase())
              .map((follower) =>
                writeNotification({
                  type: 'mint',
                  recipient: follower,
                  actor: account,
                  tokenAddress: contractAddress,
                  tokenId,
                  tokenName: displayName,
                }),
              ),
          )
        } catch {
          // notifications are non-critical
        }
      })()

      if (splitsValidation.kind === 'ok' && splitsValidation.splits.length >= 2) {
        void redis
          .set(`kismetart:splits:${contractAddress.toLowerCase()}:${tokenId}`, '1')
          .catch(() => {})
      }
    }
  }

  return NextResponse.json(data, { status: upstream.status })
}
