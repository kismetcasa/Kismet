import 'server-only'
import { after } from 'next/server'
import { parseAbi, parseAbiItem, type Address, type ContractFunctionParameters } from 'viem'
import { isAddress } from './address'
import { OPERATOR_SMART_WALLET } from './config'
import { inprocessUrl } from './inprocess'
import {
  addAuthorizedCreator,
  addPendingAuthorizedCreator,
  getCollectionMeta,
  getPendingAuthorizedCreator,
  getPendingAuthorizedCreators,
  readAuthorizedCreators,
  removeAuthorizedCreator,
  removePendingAuthorizedCreators,
  PENDING_AUTHORIZED_CREATOR_TTL_MS,
  type AuthorizedCreator,
  type PendingAuthorizedCreator,
} from './kv'
import { LRUCache } from './lruCache'
import { writeNotification } from './notifications'
import { hasAdminBit, readPermissions } from './permissions'
import { resolveSmartWallet } from './resolveSmartWallet'
import { serverBaseClient } from './rpc'
import { getSmartWalletOwners } from './smartWalletCache'
import { withTimeout } from './withTimeout'
import {
  buildCreatorRows,
  isEoaCode,
  latestPerEoa,
  pairUnmapped,
  planPendingGrants,
  unmappedHolders,
  type AdminLookup,
  type AuthorizedCreatorRow,
  type UnmappedGroups,
} from './authorizedCreatorsCore'

/**
 * The creators panel's server side (GET/POST/DELETE
 * /api/collection/authorized-creators). The merge itself is pure, in
 * lib/authorizedCreatorsCore.ts; this module feeds it and does the writes.
 *
 * ── Where the list comes from ──
 *
 * KV records name the creators the panel authorized. They are written after
 * the grant transaction, so on their own they miss every grant whose save
 * never landed and every grant made outside the panel — the 2026-11-17 Patron
 * grant to dwn2erth's two wallets is both invisible and unrevocable that way.
 * So the GET also asks the chain who holds ADMIN at token 0:
 *
 *   - candidates: the records and started grants, inprocess's admin list for
 *     the collection, and every user in its token-0 UpdatedPermissions logs.
 *     The log scan needs an RPC that serves eth_getLogs over the collection's
 *     whole history (the configured paid BASE_RPC_URL; Base's public endpoint
 *     refuses it). It is cached per process and, when refused, the inprocess
 *     list carries discovery alone.
 *   - one multicall reads owner() and permissions(0, candidate) for all of
 *     them. A holder with no record becomes an `unmapped` row, paired with its
 *     EOA when inprocess's derivation ties the two, so one revoke clears both.
 *   - the collection's own wallets (owner, the deployer the page names, their
 *     inprocess smart wallets, the platform operator) hold ADMIN from deploy
 *     and are never listed: revoking one breaks minting or airdrops.
 *
 * ── Why a save can't be lost ──
 *
 * The panel records a STARTED grant before the wallet prompt
 * (startCreatorGrant, with the EOA → smart wallet mapping verified then). When
 * the post-receipt save doesn't arrive, the next GET finds that grant's smart
 * wallet holding ADMIN and records it itself — notification included.
 */

const COLLECTION_READ_ABI = parseAbi([
  'function owner() view returns (address)',
  'function permissions(uint256 tokenId, address user) view returns (uint256)',
])

const UPDATED_PERMISSIONS = parseAbiItem(
  'event UpdatedPermissions(uint256 indexed tokenId, address indexed user, uint256 indexed permissions)',
)

/** A token-0 permissions change is rare (a grant through the panel is also
 *  recorded in KV), so the scan is cached; a refusal is cached shorter. */
const SCAN_TTL_MS = 10 * 60_000
const SCAN_REFUSED_TTL_MS = 5 * 60_000
const SCAN_TIMEOUT_MS = 4_000
const INPROCESS_TIMEOUT_MS = 6_000
/** Upper bound on addresses read per GET — a collection with more ADMIN
 *  candidates than this is far outside how the panel is used. */
const MAX_CANDIDATES = 100
/** Forward smart-wallet lookups per GET when pairing unexplained holders. */
const MAX_FORWARD_RESOLVES = 6

const scanCache = new LRUCache<string, { users: string[] | null; expiresAt: number }>(500)
const scanInFlight = new Map<string, Promise<string[] | null>>()
/** address → is an EOA (incl. EIP-7702-delegated). Code kind doesn't change. */
const eoaByAddress = new LRUCache<string, boolean>(2000)

/** viem's full error message embeds the request URL, i.e. the server-only RPC
 *  key — log the one-line summary instead. */
function briefError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { shortMessage?: unknown; message?: unknown }
    if (typeof e.shortMessage === 'string' && e.shortMessage) return e.shortMessage
    if (typeof e.message === 'string' && !/https?:\/\//.test(e.message)) return e.message.slice(0, 200)
  }
  return 'unknown error'
}

/**
 * Every user whose token-0 permissions ever changed on `collection`, from its
 * UpdatedPermissions logs (all three fields are indexed, so the filter is
 * exact). null when the RPC refuses the range or times out.
 */
async function scanTokenZeroPermissionUsers(collection: string): Promise<string[] | null> {
  const hit = scanCache.get(collection)
  if (hit && hit.expiresAt > Date.now()) return hit.users
  const running = scanInFlight.get(collection)
  if (running) return running
  const scan = (async (): Promise<string[] | null> => {
    try {
      const logs = await withTimeout(
        serverBaseClient().getLogs({
          address: collection as Address,
          event: UPDATED_PERMISSIONS,
          args: { tokenId: 0n },
          fromBlock: 0n,
          toBlock: 'latest',
        }),
        SCAN_TIMEOUT_MS,
        `UpdatedPermissions scan timed out after ${SCAN_TIMEOUT_MS}ms`,
      )
      const users = new Set<string>()
      for (const l of logs) if (l.args.user) users.add(l.args.user.toLowerCase())
      const out = [...users]
      scanCache.set(collection, { users: out, expiresAt: Date.now() + SCAN_TTL_MS })
      return out
    } catch (err) {
      console.warn('[authorized-creators] UpdatedPermissions scan unavailable; using the inprocess admin list', {
        collection,
        reason: briefError(err),
      })
      scanCache.set(collection, { users: null, expiresAt: Date.now() + SCAN_REFUSED_TTL_MS })
      return null
    } finally {
      scanInFlight.delete(collection)
    }
  })()
  scanInFlight.set(collection, scan)
  return scan
}

/**
 * inprocess's admin list for the collection (its indexer follows the same
 * UpdatedPermissions events). null when inprocess doesn't know the collection
 * (it answers 500) or can't be reached.
 */
async function fetchInprocessAdmins(collection: string): Promise<string[] | null> {
  try {
    const res = await fetch(inprocessUrl(`/collections/eip155:8453/erc1155:${collection}`), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(INPROCESS_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { admins?: unknown } | null
    if (!data || !Array.isArray(data.admins)) return null
    return data.admins
      .filter((a): a is string => typeof a === 'string' && isAddress(a))
      .map((a) => a.toLowerCase())
  } catch {
    return null
  }
}

interface ChainAdmins {
  /** owner() — undefined when that read failed. */
  owner: string | undefined
  /** ADMIN at token 0 for each candidate whose read succeeded. */
  admin: Map<string, boolean>
}

/** owner() and permissions(0, ·) for every candidate in one multicall. null
 *  when the RPC call itself fails. */
async function readChainAdmins(collection: string, candidates: string[]): Promise<ChainAdmins | null> {
  const address = collection as Address
  // Typed as the general shape on purpose: owner() and permissions() return
  // different types, and each result is narrowed at runtime below.
  const contracts: ContractFunctionParameters[] = [
    { address, abi: COLLECTION_READ_ABI, functionName: 'owner' },
    ...candidates.map((user) => ({
      address,
      abi: COLLECTION_READ_ABI,
      functionName: 'permissions',
      args: [0n, user as Address],
    })),
  ]
  try {
    const results = await serverBaseClient().multicall({ allowFailure: true, contracts })
    const [ownerRead, ...permReads] = results
    const owner =
      ownerRead?.status === 'success' && typeof ownerRead.result === 'string' && isAddress(ownerRead.result)
        ? ownerRead.result.toLowerCase()
        : undefined
    const admin = new Map<string, boolean>()
    candidates.forEach((user, i) => {
      const r = permReads[i]
      if (r?.status === 'success' && typeof r.result === 'bigint') admin.set(user, hasAdminBit(r.result))
    })
    return { owner, admin }
  } catch (err) {
    console.warn('[authorized-creators] permissions read failed', { collection, reason: briefError(err) })
    return null
  }
}

/**
 * The collection's own wallets, granted ADMIN at deploy and never a creator
 * to list or revoke: the on-chain owner and the deployer the page names (KV
 * meta `artist` — the panel's viewer), each one's inprocess smart wallet, and
 * the platform operator.
 */
async function collectionOwnWallets(owner: string, artist: string | undefined): Promise<Set<string>> {
  const principals = [...new Set([owner, ...(artist && isAddress(artist) ? [artist.toLowerCase()] : [])])]
  const own = new Set<string>(principals)
  if (OPERATOR_SMART_WALLET && isAddress(OPERATOR_SMART_WALLET)) own.add(OPERATOR_SMART_WALLET.toLowerCase())
  const wallets = await Promise.all(principals.map((p) => resolveSmartWallet(p).catch(() => null)))
  for (const w of wallets) if (w && 'address' in w) own.add(w.address.toLowerCase())
  return own
}

async function isEoaAddress(address: string): Promise<boolean | undefined> {
  const hit = eoaByAddress.get(address)
  if (hit !== undefined) return hit
  try {
    const eoa = isEoaCode(await serverBaseClient().getCode({ address: address as Address }))
    eoaByAddress.set(address, eoa)
    return eoa
  } catch {
    return undefined
  }
}

/**
 * smart wallet → owning EOA for the given holders. The reverse index
 * (lib/smartWalletCache, written by every live resolution — the panel resolves
 * a creator's wallet before every grant) explains most; for the rest, the
 * holders that are EOAs are resolved forward, bounded. Contracts are never
 * resolved forward: inprocess would derive a meaningless wallet for them and
 * the durable cache would keep it.
 */
async function smartWalletOwnersOf(addresses: string[]): Promise<Map<string, string>> {
  const ownerOf = new Map(await getSmartWalletOwners(addresses))
  const explained = new Set([...ownerOf.keys(), ...ownerOf.values()])
  const unexplained = addresses.filter((a) => !explained.has(a)).slice(0, MAX_FORWARD_RESOLVES * 2)
  // A pair needs two unexplained holders: an EOA and its wallet.
  if (unexplained.length < 2) return ownerOf
  const kinds = await Promise.all(unexplained.map((a) => isEoaAddress(a)))
  const eoas = unexplained.filter((_, i) => kinds[i] === true).slice(0, MAX_FORWARD_RESOLVES)
  const pool = new Set(unexplained)
  await Promise.all(
    eoas.map(async (eoa) => {
      const r = await resolveSmartWallet(eoa).catch(() => null)
      const sw = r && 'address' in r ? r.address.toLowerCase() : undefined
      if (sw && sw !== eoa && pool.has(sw)) ownerOf.set(sw, eoa)
    }),
  )
  return ownerOf
}

/** Deferred past the response. writeNotification's burst lock (type,
 *  recipient, actor, collection — 60s) collapses the same grant saved twice: a
 *  retried POST, or a POST racing the GET that finishes the grant. */
function notifyAuthorized(collection: string, eoa: string, actor: string): void {
  after(async () => {
    try {
      const meta = await getCollectionMeta(collection)
      await writeNotification({
        type: 'authorized',
        recipient: eoa,
        ...(actor ? { actor } : {}),
        tokenAddress: collection,
        tokenName: meta?.name,
      })
    } catch {}
  })
}

/** Record started grants the chain confirms. Returns the ones that landed. */
async function recordStartedGrants(
  collection: string,
  grants: PendingAuthorizedCreator[],
): Promise<AuthorizedCreator[]> {
  const recorded: AuthorizedCreator[] = []
  for (const p of grants) {
    const entry: AuthorizedCreator = {
      eoa: p.eoa,
      smartWallet: p.smartWallet,
      ...(p.label ? { label: p.label } : {}),
      grantedBy: p.grantedBy,
      grantedAt: p.createdAt > 0 ? p.createdAt : Date.now(),
    }
    if (!(await addAuthorizedCreator(collection, entry))) continue
    console.info('[authorized-creators] recorded a started grant the chain confirmed', { collection, eoa: p.eoa })
    recorded.push(entry)
    notifyAuthorized(collection, p.eoa, p.grantedBy)
  }
  return recorded
}

function capCandidates(collection: string, addresses: (string | undefined)[]): string[] {
  const out = new Set<string>()
  for (const a of addresses) {
    if (typeof a === 'string' && isAddress(a)) out.add(a.toLowerCase())
  }
  const all = [...out]
  if (all.length > MAX_CANDIDATES) {
    console.warn('[authorized-creators] candidate list truncated', { collection, count: all.length })
  }
  return all.slice(0, MAX_CANDIDATES)
}

/**
 * The panel's list: recorded grants (stale when the smart wallet lost ADMIN),
 * started grants the chain has confirmed (recorded on the way), and every
 * other token-0 ADMIN holder as an `unmapped` row. Throws when the records
 * can't be read (Redis down) — the route answers 503 rather than a list that
 * would relabel every recorded creator as unmapped.
 */
export async function listAuthorizedCreators(collection: string): Promise<AuthorizedCreatorRow[]> {
  const c = collection.toLowerCase()
  const [records, pending, meta, inprocessAdmins] = await Promise.all([
    readAuthorizedCreators(c),
    getPendingAuthorizedCreators(c),
    getCollectionMeta(c),
    fetchInprocessAdmins(c),
  ])
  let recorded = latestPerEoa(records)

  // Scan only collections that exist in Kismet's world — inprocess indexes
  // it, or Kismet registered it or wrote grants to it — so this public GET
  // can't be aimed at arbitrary addresses to spend log queries.
  const knownCollection = inprocessAdmins !== null || meta !== null || records.length > 0 || pending.length > 0
  const scanned = knownCollection ? await scanTokenZeroPermissionUsers(c) : null

  const candidates = capCandidates(c, [
    ...recorded.flatMap((r) => [r.eoa, r.smartWallet]),
    ...pending.flatMap((p) => [p.eoa, p.smartWallet]),
    ...(inprocessAdmins ?? []),
    ...(scanned ?? []),
  ])
  if (candidates.length === 0) return []

  const chain = await readChainAdmins(c, candidates)
  const isAdmin: AdminLookup = (a) => chain?.admin.get(a.toLowerCase())

  // Finish started grants the chain now confirms; forget the ones already
  // recorded or past their TTL. The rest wait (transaction in flight, or it
  // never landed — then they expire unseen).
  const plan = planPendingGrants(
    pending,
    new Set(recorded.map((r) => r.eoa)),
    isAdmin,
    Date.now(),
    PENDING_AUTHORIZED_CREATOR_TTL_MS,
  )
  const finished = await recordStartedGrants(c, plan.promote)
  const settled = [...plan.drop.map((p) => p.eoa), ...finished.map((f) => f.eoa)]
  if (settled.length > 0) await removePendingAuthorizedCreators(c, settled)
  recorded = latestPerEoa([...recorded, ...finished])

  // Chain-only rows need owner(): without it the collection's own wallets
  // can't be told from a creator's, and offering to revoke the owner's mint
  // wallet is worse than listing nothing extra.
  let unmapped: UnmappedGroups = { pairs: [], singles: [] }
  if (chain?.owner) {
    const own = await collectionOwnWallets(chain.owner, meta?.artist)
    const known = new Set(recorded.flatMap((r) => [r.eoa, r.smartWallet]))
    const loose = unmappedHolders(
      candidates.filter((a) => isAdmin(a) === true),
      known,
      own,
    )
    const ownerOf = await smartWalletOwnersOf(loose)
    // The reverse index also catches the collection's own smart wallets when
    // their forward lookup failed above.
    const creators = loose.filter((a) => !own.has(ownerOf.get(a) ?? ''))
    unmapped = pairUnmapped(creators, ownerOf)
  }

  return buildCreatorRows(recorded, isAdmin, unmapped)
}

// ── Writes (POST / DELETE) ──────────────────────────────────────────────

export interface GrantFailure {
  ok: false
  status: 400 | 403 | 502
  error: string
}
export type GrantResult<T> = { ok: true; value: T } | GrantFailure

export interface GrantInput {
  collection: string
  /** The EOA the admin authorized (typed, or an ENS name resolved client-side). */
  eoa: string
  /** Its inprocess smart wallet as the client resolved it — re-verified here. */
  smartWallet: string
  /** Optional ENS / display label captured at grant time. */
  label?: string
}

/** The caller must hold ADMIN at token 0 — the same gate Zora enforces on
 *  addPermission / removePermission. */
async function requireCollectionAdmin(
  collection: string,
  viewer: string,
  verb: 'authorize' | 'revoke',
): Promise<GrantFailure | null> {
  try {
    const perms = await readPermissions(serverBaseClient(), collection as Address, 0n, viewer as Address)
    if (hasAdminBit(perms)) return null
    return { ok: false, status: 403, error: `Only a collection admin can ${verb} creators` }
  } catch {
    return { ok: false, status: 502, error: 'Could not verify collection admin on-chain' }
  }
}

/** Re-resolve the EOA's smart wallet so a client can't plant a mapping. The
 *  three failure modes stay distinct so the admin gets an accurate reason (a
 *  transient outage is not a "mismatch", and "no account" is actionable). */
async function verifySmartWallet(eoa: string, smartWallet: string): Promise<GrantFailure | null> {
  const expected = await resolveSmartWallet(eoa)
  if (!expected) {
    return { ok: false, status: 502, error: 'Could not reach inprocess to verify the smart wallet — try again' }
  }
  if ('notFound' in expected) {
    return {
      ok: false,
      status: 400,
      error: 'This wallet has no inprocess account yet — it must mint once to set one up before it can be authorized',
    }
  }
  if (expected.address.toLowerCase() !== smartWallet.toLowerCase()) {
    return { ok: false, status: 400, error: 'eoa / smartWallet mismatch — re-resolve and retry' }
  }
  return null
}

/**
 * Record a grant BEFORE its transaction is sent. Every check a save makes
 * runs here, while nothing is on chain yet, so a failure costs the admin a
 * retry instead of an unrecorded grant.
 */
export async function startCreatorGrant(
  viewer: string,
  input: GrantInput,
): Promise<GrantResult<PendingAuthorizedCreator>> {
  const denied = await requireCollectionAdmin(input.collection, viewer, 'authorize')
  if (denied) return denied
  const mismatch = await verifySmartWallet(input.eoa, input.smartWallet)
  if (mismatch) return mismatch
  const pending: PendingAuthorizedCreator = {
    eoa: input.eoa.toLowerCase(),
    smartWallet: input.smartWallet.toLowerCase(),
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    grantedBy: viewer.toLowerCase(),
    createdAt: Date.now(),
  }
  if (!(await addPendingAuthorizedCreator(input.collection, pending))) {
    return { ok: false, status: 502, error: 'Could not prepare the grant — nothing was sent. Try again.' }
  }
  return { ok: true, value: pending }
}

/**
 * Record a grant: after its transaction confirms, when both bits were already
 * set, or from an unmapped row's "save". Trusts a started grant's mapping (it
 * was verified when the grant started), so the save doesn't depend on
 * inprocess being reachable a second time; anything else is re-verified.
 */
export async function saveCreatorGrant(
  viewer: string,
  input: GrantInput,
): Promise<GrantResult<AuthorizedCreator>> {
  const denied = await requireCollectionAdmin(input.collection, viewer, 'authorize')
  if (denied) return denied
  const eoa = input.eoa.toLowerCase()
  const smartWallet = input.smartWallet.toLowerCase()
  const started = await getPendingAuthorizedCreator(input.collection, eoa)
  if (started?.smartWallet !== smartWallet) {
    const mismatch = await verifySmartWallet(eoa, smartWallet)
    if (mismatch) return mismatch
  }
  const label = input.label?.trim() || started?.label
  const entry: AuthorizedCreator = {
    eoa,
    smartWallet,
    ...(label ? { label } : {}),
    grantedBy: viewer.toLowerCase(),
    grantedAt: Date.now(),
  }
  if (!(await addAuthorizedCreator(input.collection, entry))) {
    return { ok: false, status: 502, error: 'Failed to persist authorized-creator mapping; check server logs' }
  }
  if (started) await removePendingAuthorizedCreators(input.collection, [eoa])
  notifyAuthorized(input.collection.toLowerCase(), eoa, viewer.toLowerCase())
  return { ok: true, value: entry }
}

/** Forget a creator after a revoke: the record and any started grant. The
 *  chain is the source of truth for the permission itself; the admin's
 *  removePermission transaction already ran. */
export async function dropCreatorGrant(
  viewer: string,
  collection: string,
  eoa: string,
): Promise<GrantResult<null>> {
  const denied = await requireCollectionAdmin(collection, viewer, 'revoke')
  if (denied) return denied
  await removeAuthorizedCreator(collection, eoa)
  await removePendingAuthorizedCreators(collection, [eoa])
  return { ok: true, value: null }
}
