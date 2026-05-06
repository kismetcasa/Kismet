import { type NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from './inprocess'
import { redis } from './redis'
import { trackWallet } from './profile'
import { checkRateLimit, getClientIp } from './ratelimit'
import { setMomentMeta, writeNotification } from './notifications'
import { getFollowers } from './follows'

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
    if (
      typeof e.percentAllocation !== 'number' ||
      !Number.isFinite(e.percentAllocation) ||
      e.percentAllocation <= 0 ||
      e.percentAllocation > 100
    ) {
      return { kind: 'error', message: 'splits allocation must be 0–100' }
    }
    const lower = e.address.toLowerCase()
    if (seen.has(lower)) {
      return { kind: 'error', message: `duplicate splits address ${e.address}` }
    }
    seen.add(lower)
    sum += e.percentAllocation
    normalized.push({ address: e.address, percentAllocation: e.percentAllocation })
  }

  // 0.001% tolerance — accommodates 4-decimal-place client-side rounding.
  if (Math.abs(sum - 100) > 0.001) {
    return {
      kind: 'error',
      message: `splits must sum to 100% (got ${sum.toFixed(4)}%)`,
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

  const body = (await req.json()) as Record<string, unknown>
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

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = process.env.INPROCESS_API_KEY
  if (apiKey) headers['x-api-key'] = apiKey

  const upstream = await fetch(`${INPROCESS_API}/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(forwardBody),
  })

  const text = await upstream.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return NextResponse.json(
      { error: 'upstream error', status: upstream.status, detail: text.slice(0, 200) },
      { status: 502 },
    )
  }

  if (upstream.ok) {
    const r = data as { contractAddress?: string; tokenId?: string }
    const contractAddress = r.contractAddress
    const tokenId = r.tokenId

    if (contractAddress && tokenId && account) {
      void setMomentMeta(contractAddress, tokenId, { creator: account, name: displayName }).catch(() => {})
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
