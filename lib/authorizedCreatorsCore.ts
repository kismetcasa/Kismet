/**
 * The creators panel's merge, PURE: no Redis, no RPC, no inprocess, so
 * scripts/verify-authorized-creators.ts drives every branch directly. The I/O
 * that feeds it lives in lib/authorizedCreators.ts.
 *
 * Three sources meet here:
 *   - recorded grants (KV), written when the panel's save lands;
 *   - started grants (KV), written before the wallet prompt and finished here
 *     once the chain shows their smart wallet holding ADMIN;
 *   - the chain: every address holding ADMIN at token 0. Those with no record
 *     come back as `unmapped` rows, so a grant made on etherscan, or one whose
 *     save never landed, is visible and revocable instead of invisible.
 */
import type { AuthorizedCreator, PendingAuthorizedCreator } from './kv'

export interface AuthorizedCreatorRow {
  /** The creator's EOA. Absent on an unmapped row whose one ADMIN address
   *  couldn't be paired with an EOA. */
  eoa?: string
  /** The on-chain ADMIN grantee: the creator's inprocess smart wallet (what
   *  MintForm relays through). On an unpaired unmapped row it is simply the
   *  address that holds ADMIN, EOA or contract. */
  smartWallet: string
  label?: string
  /** Admin who recorded the grant; '' on unmapped rows (no record). */
  grantedBy: string
  /** ms epoch of the record; 0 on unmapped rows. */
  grantedAt: number
  /** The smart wallet still holds ADMIN. False marks a recorded grant revoked
   *  outside the panel (rendered stale). A failed read counts as live, so an
   *  RPC blip never flashes every row stale. Always true on unmapped rows. */
  liveOnChain: boolean
  /** Holds ADMIN with no Kismet record: granted outside the panel, or the
   *  panel's save never landed. Revocable like any other row. */
  unmapped?: true
}

/** ADMIN at token 0: true / false from a successful read, undefined when the
 *  address wasn't read or its read failed. */
export type AdminLookup = (address: string) => boolean | undefined

/**
 * One record per EOA, the newest, newest first. Concurrent saves of the same
 * grant can briefly leave two members in the set (lib/kv dedupes on write,
 * best-effort); malformed legacy members are skipped. Addresses lowercased.
 */
export function latestPerEoa(records: readonly AuthorizedCreator[]): AuthorizedCreator[] {
  const best = new Map<string, AuthorizedCreator>()
  for (const r of records) {
    if (typeof r?.eoa !== 'string' || typeof r.smartWallet !== 'string') continue
    const eoa = r.eoa.toLowerCase()
    const grantedAt = typeof r.grantedAt === 'number' ? r.grantedAt : 0
    const cur = best.get(eoa)
    if (cur && cur.grantedAt >= grantedAt) continue
    best.set(eoa, {
      eoa,
      smartWallet: r.smartWallet.toLowerCase(),
      ...(r.label ? { label: r.label } : {}),
      grantedBy: typeof r.grantedBy === 'string' ? r.grantedBy.toLowerCase() : '',
      grantedAt,
    })
  }
  return [...best.values()].sort((a, b) => b.grantedAt - a.grantedAt)
}

export interface PendingPlan {
  /** The chain confirms the smart wallet holds ADMIN: record it now. */
  promote: PendingAuthorizedCreator[]
  /** Already recorded, or past the TTL without landing: delete. */
  drop: PendingAuthorizedCreator[]
}

/**
 * Decide what each started grant becomes. A grant whose EOA AND smart wallet
 * both hold ADMIN is recorded however old it is — the TTL exists to forget
 * grants that never landed, and a landed grant whose admin only returns after
 * a week is exactly the save this record is for. One that is neither promoted
 * nor dropped is left alone: its transaction may still be in flight.
 *
 * Promotion needs BOTH bits because the panel's grant sets both in one
 * transaction. Keying on the smart wallet alone recorded (and notified) a
 * grant the admin had CANCELLED whenever that wallet already held ADMIN —
 * the wallet prompt only asked for the EOA's bit, the admin rejected it, and
 * the next GET saw the smart wallet as ADMIN anyway.
 */
export function planPendingGrants(
  pending: readonly PendingAuthorizedCreator[],
  recordedEoas: ReadonlySet<string>,
  isAdmin: AdminLookup,
  now: number,
  ttlMs: number,
): PendingPlan {
  const plan: PendingPlan = { promote: [], drop: [] }
  for (const p of pending) {
    if (recordedEoas.has(p.eoa.toLowerCase())) plan.drop.push(p)
    else if (isAdmin(p.smartWallet) === true && isAdmin(p.eoa) === true) plan.promote.push(p)
    else if (now - p.createdAt > ttlMs) plan.drop.push(p)
  }
  return plan
}

/**
 * Addresses that hold ADMIN but belong to no row and aren't the collection's
 * own wallets (owner, its smart wallet, the platform operator). Lowercased,
 * deduped, sorted, so the rows come out in a stable order.
 */
export function unmappedHolders(
  holders: readonly string[],
  known: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): string[] {
  const out = new Set<string>()
  for (const h of holders) {
    const a = h.toLowerCase()
    if (!known.has(a) && !excluded.has(a)) out.add(a)
  }
  return [...out].sort()
}

export interface UnmappedGroups {
  pairs: { eoa: string; smartWallet: string }[]
  singles: string[]
}

/**
 * Pair an unmapped EOA with its unmapped smart wallet, the shape the panel's
 * own grant leaves on chain (ADMIN on both). `ownerOf` maps smart wallet →
 * EOA (inprocess's derivation). A pair needs BOTH addresses in `addresses`;
 * anything else stays a single row, so revoking it clears exactly the address
 * that holds ADMIN.
 */
export function pairUnmapped(
  addresses: readonly string[],
  ownerOf: ReadonlyMap<string, string>,
): UnmappedGroups {
  const pool = new Set(addresses.map((a) => a.toLowerCase()))
  const paired = new Set<string>()
  const pairs: UnmappedGroups['pairs'] = []
  for (const sw of [...pool].sort()) {
    const eoa = ownerOf.get(sw)?.toLowerCase()
    if (!eoa || eoa === sw || !pool.has(eoa)) continue
    if (paired.has(eoa) || paired.has(sw)) continue
    pairs.push({ eoa, smartWallet: sw })
    paired.add(eoa)
    paired.add(sw)
  }
  return { pairs, singles: [...pool].filter((a) => !paired.has(a)).sort() }
}

/** Recorded rows first (newest first), then unmapped pairs, then singles. */
export function buildCreatorRows(
  recorded: readonly AuthorizedCreator[],
  isAdmin: AdminLookup,
  unmapped: UnmappedGroups,
): AuthorizedCreatorRow[] {
  const rows: AuthorizedCreatorRow[] = latestPerEoa(recorded).map((r) => ({
    eoa: r.eoa,
    smartWallet: r.smartWallet,
    ...(r.label ? { label: r.label } : {}),
    grantedBy: r.grantedBy,
    grantedAt: r.grantedAt,
    liveOnChain: isAdmin(r.smartWallet) !== false,
  }))
  for (const p of unmapped.pairs) {
    rows.push({ eoa: p.eoa, smartWallet: p.smartWallet, grantedBy: '', grantedAt: 0, liveOnChain: true, unmapped: true })
  }
  for (const a of unmapped.singles) {
    rows.push({ smartWallet: a, grantedBy: '', grantedAt: 0, liveOnChain: true, unmapped: true })
  }
  return rows
}

/**
 * True for code that belongs to an externally owned account: none at all, or
 * an EIP-7702 delegation designator (0xef0100 ‖ 20-byte delegate — the shape a
 * delegated EOA like the Kismet treasury reports). Contracts, including the
 * ERC-1967 proxies inprocess deploys as smart wallets, are false. Used to keep
 * forward smart-wallet resolution to EOAs: resolving a contract would only
 * mint and cache a meaningless wallet for it.
 */
export function isEoaCode(code: string | undefined | null): boolean {
  if (!code || code === '0x') return true
  const c = code.toLowerCase()
  return c.startsWith('0xef0100') && c.length === 2 + 2 * 23
}
