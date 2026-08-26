import 'server-only'
import { type NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import { isAddress } from './address'
import { errorResponse } from './apiResponse'
import { getSessionAddress } from './session'
import { serverBaseClient } from './rpc'
import { expandToGateWallets } from './addressUnion'
import { holdsAny, holdsEdition } from './ownership'
import { hasDownloadGrace } from './collectorFile'
import { canEditMomentMetadata, readPermissions } from './permissions'
import {
  buildDownloadProofMessage,
  DOWNLOAD_PROOF_MAX_AGE_SECONDS,
} from './collectorFileMessage'

/**
 * The two-path collector gate + the artist-side management gate
 * (COLLECTOR_DOWNLOADS_DESIGN.md §5.1). Shared by the ticket, download and
 * management routes so the paths cannot drift.
 */

// ---------------------------------------------------------------------------
// Collector side
// ---------------------------------------------------------------------------

// The sibling union is the request's latency floor (4-6 dependent reads,
// REDIS_IMPLEMENTATION_REVIEW §"latency floor"), so cache the EXPANDED UNION
// per address — not just a verdict — briefly. Bounded map, oldest-out.
const UNION_CACHE_MS = 5 * 60 * 1000
const unionCache = new Map<string, { at: number; wallets: string[] }>()

async function viewerWallets(address: string): Promise<string[]> {
  const addr = address.toLowerCase()
  const hit = unionCache.get(addr)
  if (hit && Date.now() - hit.at < UNION_CACHE_MS) return hit.wallets
  // expandToGateWallets = caller-first FC-sibling union, deduped/lowercased,
  // capped at MAX_UNION_WALLETS, failing DEGRADED to [caller] — despite the
  // pass-flavored name it is exactly the bounded identity union (the
  // pass-specific blacklist logic lives in hasGateAccess, not here).
  const wallets = await expandToGateWallets(addr)
  unionCache.set(addr, { at: Date.now(), wallets })
  if (unionCache.size > 500) {
    const oldest = [...unionCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) unionCache.delete(oldest[0])
  }
  return wallets
}

export interface DownloadProofInput {
  address?: string
  issuedAt?: number
  signature?: string
}

export type CollectorGateResult =
  | { ok: true; address: string }
  | { ok: false; status: number; error: string }

/**
 * Path 2 — wallet proof: a freshness-bounded signed message verified with
 * verifyMessage (ERC-1271-aware, so smart-account holders work), then a live
 * balanceOf of the SIGNING wallet. Covers holders outside the FC-verification
 * union and web collectors with no session (the raffle-enter pattern,
 * app/api/raffle/enter/route.ts).
 */
export async function authorizeByProof(
  collection: string,
  tokenId: string,
  proof: DownloadProofInput,
): Promise<CollectorGateResult> {
  const address = proof.address?.toLowerCase()
  const { issuedAt, signature } = proof
  if (!address || !isAddress(address)) return { ok: false, status: 400, error: 'Invalid address' }
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    return { ok: false, status: 400, error: 'Invalid issuedAt' }
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { ok: false, status: 401, error: 'Invalid signature' }
  }
  const now = Math.floor(Date.now() / 1000)
  if (issuedAt > now + 120 || issuedAt < now - DOWNLOAD_PROOF_MAX_AGE_SECONDS) {
    return { ok: false, status: 401, error: 'Signature expired — please try again' }
  }
  // Rebuild the EXACT message from server-trusted fields so the signature
  // binds (collection, tokenId, address, issuedAt); any tamper flips it.
  const message = buildDownloadProofMessage({ collection, tokenId, address, issuedAt })
  let valid = false
  try {
    valid = await serverBaseClient().verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
  } catch {
    return { ok: false, status: 401, error: 'Signature verification failed' }
  }
  if (!valid) return { ok: false, status: 401, error: 'Signature does not match wallet' }
  if (!(await holdsEdition(collection, tokenId, address))) {
    return { ok: false, status: 403, error: 'This wallet does not hold the edition' }
  }
  return { ok: true, address }
}

/**
 * Path 1 (+3) — session identity: grace marker (the receipt-verified
 * freshness window) OR live balance across the bounded FC-sibling union.
 * The caller resolved `sessionAddress` via getSessionAddress (cookie or
 * Quick-Auth JWT) — cryptographically anchored upstream.
 */
export async function authorizeBySession(
  collection: string,
  tokenId: string,
  sessionAddress: string,
): Promise<CollectorGateResult> {
  const addr = sessionAddress.toLowerCase()
  // Grace first: it's one Redis read and covers the exact post-collect window
  // where the RPC read replica lags the receipt the platform already verified.
  if (await hasDownloadGrace(collection, tokenId, addr)) return { ok: true, address: addr }
  const wallets = await viewerWallets(addr)
  if (await holdsAny(collection, tokenId, wallets)) return { ok: true, address: addr }
  // holdsAny fails closed on RPC failure — indistinguishable here from a real
  // non-holder, so the copy stays "collect to download"-shaped and the client
  // offers the wallet-proof fallback (which will also fail on a dead RPC).
  return { ok: false, status: 403, error: 'No edition found for this account — verify with the holding wallet' }
}

// ---------------------------------------------------------------------------
// Artist side
// ---------------------------------------------------------------------------

export type ManageVerdict = 'yes' | 'no' | 'unknown'

/**
 * May `caller` manage this artwork's collector file? The exact on-chain
 * authorization update-uri uses (ADMIN|METADATA at the token, falling back to
 * collection-wide tokenId 0, via the shared canEditMomentMetadata predicate) —
 * with one deliberate difference: a readPermissions THROW returns 'unknown'
 * so the route answers 503, not the misleading 403 a swallowed RPC outage
 * would produce (readPermissions retries 4× then throws, lib/permissions.ts).
 */
export async function canManageCfile(
  collection: string,
  tokenId: string,
  caller: string,
): Promise<ManageVerdict> {
  try {
    const client = serverBaseClient()
    const tokenPerms = await readPermissions(client, collection as Address, BigInt(tokenId), caller as Address)
    if (canEditMomentMetadata(tokenPerms)) return 'yes'
    const collectionPerms = await readPermissions(client, collection as Address, 0n, caller as Address)
    return canEditMomentMetadata(collectionPerms) ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Route helpers (shared by the collector-file route family — route files may
// only export HTTP handlers, so these live here)
// ---------------------------------------------------------------------------

export interface CfileParams {
  collection: string
  tokenId: string
}

/** Parse + canonicalize ?collection=&tokenId= — minimal-decimal tokenId so
 *  "01" can't fork a second record or slip a per-artwork lock. */
export function parseCfileParams(req: NextRequest): CfileParams | null {
  const collection = req.nextUrl.searchParams.get('collection')?.toLowerCase()
  const rawTokenId = req.nextUrl.searchParams.get('tokenId')
  if (!collection || !isAddress(collection)) return null
  if (!rawTokenId || !/^\d+$/.test(rawTokenId)) return null
  return { collection, tokenId: BigInt(rawTokenId).toString() }
}

/** Session + on-chain ADMIN|METADATA gate for every management method.
 *  'unknown' (RPC outage) answers 503, never a misleading 403. */
export async function requireCfileManager(
  req: NextRequest,
  params: CfileParams,
): Promise<{ address: string } | NextResponse> {
  const address = await getSessionAddress(req)
  if (!address) return errorResponse(401, 'Sign in to continue')
  const verdict = await canManageCfile(params.collection, params.tokenId, address)
  if (verdict === 'unknown') {
    return errorResponse(503, 'Could not verify permissions — try again shortly')
  }
  if (verdict === 'no') return errorResponse(403, 'Not authorized to manage this artwork')
  return { address: address.toLowerCase() }
}
