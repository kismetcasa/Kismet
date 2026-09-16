import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { POST as recordCollect } from '@/app/api/collect/route'
import { PATCH as recordListing } from '@/app/api/listings/[id]/route'

export const runtime = 'nodejs'

/**
 * The record step (SKILL.md step 5) as a GET, for the surfaces that can only
 * fetch a URL the user pasted back into the chat (Claude.ai / ChatGPT — Base
 * MCP's consumer-surface rung). Without it, a collect or buy the user approved
 * there is real on-chain but Kismet never learns of it: no "collected" notice
 * for the artist, no stats, and the listing stays visibly active until the
 * expiry sweep.
 *
 * A GET that writes is acceptable here, and only here, because the write
 * records a fact the chain already proves and nothing else: it delegates to
 * the SAME handlers the app posts to — /api/collect (verifies the TransferSingle
 * on the receipt; one record per tx) and PATCH /api/listings/{id} (verifies the
 * Seaport OrderFulfilled on the receipt; 409 once filled). A forged or replayed
 * URL can therefore only ever record a mint or sale that happened. The
 * delegation is an in-process call that forwards ONLY the client-IP headers
 * (so rate limits still key on the real client) — never cookies or bearer
 * tokens, so a navigation to this URL can never act on the user's session.
 *
 * Params — collect: collection, tokenId, account, txHash, amount?, currency?,
 * pricePerToken?, comment?; buy: listingId, txHash. Prepare envelopes carry the
 * exact URL as `record.getUrl` with the txHash placeholder to fill.
 */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const MAX_AMOUNT = 50
const IP_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'] as const

export async function GET(req: NextRequest) {
  const res = await handle(req)
  // Every answer — including validation errors — is uncacheable and unindexable.
  res.headers.set('Cache-Control', 'private, no-store')
  res.headers.set('X-Robots-Tag', 'noindex')
  return res
}

/** Next would auto-implement HEAD from GET, so a link-preview probe would run
 *  the record. Refuse it explicitly instead. */
export async function HEAD() {
  return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'private, no-store' } })
}

async function handle(req: NextRequest): Promise<Response> {
  if (!(await checkRateLimit(`agent-record:${getClientIp(req)}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const q = req.nextUrl.searchParams
  const verb = q.get('verb')
  // Canonical case: the record handlers key their verify cache and idempotency
  // lock on this string, so a case variant must not read as a new tx.
  const txHash = (q.get('txHash') ?? '').toLowerCase()
  if (!TX_HASH.test(txHash)) return errorResponse(400, 'txHash must be the confirmed 0x… transaction hash')

  if (verb === 'collect') {
    const collection = q.get('collection') ?? ''
    const tokenId = q.get('tokenId') ?? ''
    const account = q.get('account') ?? ''
    if (!isAddress(collection)) return errorResponse(400, 'Invalid collection address')
    if (!isValidTokenId(tokenId)) return errorResponse(400, 'Invalid tokenId')
    if (!isAddress(account)) return errorResponse(400, 'Invalid account address')
    const amountNum = Number(q.get('amount') ?? 1)
    if (!Number.isInteger(amountNum) || amountNum < 1 || amountNum > MAX_AMOUNT) {
      return errorResponse(400, `amount must be an integer 1–${MAX_AMOUNT}`)
    }
    // Optional fields are passed through as absent, never defaulted: the
    // handler treats a missing price as "unknown" and a "0" as "free".
    const currency = q.get('currency')
    if (currency !== null && currency !== 'eth' && currency !== 'usdc') return errorResponse(400, 'currency must be "eth" or "usdc"')
    const pricePerToken = q.get('pricePerToken')
    if (pricePerToken !== null && !/^[0-9]+$/.test(pricePerToken)) return errorResponse(400, 'pricePerToken must be base units (digits)')
    const comment = (q.get('comment') ?? '').slice(0, 1000)
    return delegate(req, recordCollect, '/api/collect', 'POST', {
      moment: { collectionAddress: collection, tokenId, chainId: 8453 },
      account,
      amount: amountNum,
      comment,
      ...(pricePerToken !== null ? { pricePerToken } : {}),
      ...(currency !== null ? { currency } : {}),
      txHash,
    })
  }

  if (verb === 'buy') {
    const listingId = q.get('listingId') ?? ''
    if (!listingId || listingId.length > 200) return errorResponse(400, 'listingId is required')
    return delegate(
      req,
      (r) => recordListing(r, { params: Promise.resolve({ id: listingId }) }),
      `/api/listings/${encodeURIComponent(listingId)}`,
      'PATCH',
      { status: 'filled', txHash },
    )
  }

  return errorResponse(400, 'verb must be "collect" or "buy"')
}

/** Invoke a record handler in-process with a request that carries only the
 *  caller's IP-attribution headers and the JSON body the app would post. */
async function delegate(
  req: NextRequest,
  handler: (r: NextRequest) => Promise<Response>,
  path: string,
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>,
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' })
  for (const h of IP_HEADERS) {
    const v = req.headers.get(h)
    if (v) headers.set(h, v)
  }
  const inner = new NextRequest(new URL(path, req.nextUrl.origin), { method, headers, body: JSON.stringify(body) })
  const res = await handler(inner)
  return new NextResponse(res.body, { status: res.status, headers: res.headers })
}
