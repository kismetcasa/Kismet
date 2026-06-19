import { redis } from './redis'
import { isAddress } from './address'

export interface SplitRecipient {
  address: string
  percentAllocation: number
}

interface StoredSplitsResult {
  hasSplits: boolean
  recipients: SplitRecipient[]
}

// SplitMain enforces a smaller cap in practice (gas-bound). 50 is a
// generous safety net that no legitimate UI hits. Exported so the mint
// UI caps recipient count against the exact same number it'll be validated
// against server-side.
export const MAX_SPLITS = 50

const splitsKey = (collection: string, tokenId: string) =>
  `kismetart:splits:${collection.toLowerCase()}:${tokenId}`

// Reverse index: recipient address → the split moments they're a payee on.
// Member encodes the recipient's allocation ("<collection>:<tokenId>:<pct>") so
// the pending roll-up needs a single SMEMBERS, never a per-moment getStoredSplits.
const recipientIndexKey = (address: string) =>
  `kismetart:splits:by-recipient:${address.toLowerCase()}`

// JSON values stay truthy so the distribute flow's `hasSplits` gate
// (a `redis.get` truthy check) keeps working alongside the legacy
// `'1'` flag from older mints.
export async function setStoredSplits(
  collection: string,
  tokenId: string,
  recipients: SplitRecipient[],
): Promise<void> {
  const payload = {
    recipients: recipients.map((r) => ({
      address: r.address.toLowerCase(),
      percentAllocation: r.percentAllocation,
    })),
  }
  await redis.set(splitsKey(collection, tokenId), JSON.stringify(payload))
  await indexRecipientSplits(collection, tokenId, recipients)
}

// Index each recipient → this split moment so an artist's undistributed balance
// can be rolled up from one SMEMBERS (see lib/pending.ts). Idempotent (SADD) and
// best-effort: called at mint (above) AND self-healed from the moment-splits read
// path, so moments minted before this index existed get covered as they're
// viewed. A bulk backfill is deliberately avoided — there's no safe enumerator
// (the global created-mints set hard-fails SMEMBERS past ~10 MB, the transfers
// feed carries no tokenId, and the codebase uses no SCAN).
export async function indexRecipientSplits(
  collection: string,
  tokenId: string,
  recipients: SplitRecipient[],
): Promise<void> {
  const c = collection.toLowerCase()
  await Promise.all(
    recipients
      .filter((r) => r.percentAllocation > 0)
      .map((r) =>
        redis
          .sadd(recipientIndexKey(r.address), `${c}:${tokenId}:${r.percentAllocation}`)
          .catch(() => {}),
      ),
  )
}

export interface RecipientSplit {
  collection: string
  tokenId: string
  /** This recipient's allocation on the moment, a whole-number percent 1–100. */
  pct: number
}

// The split moments an address is a payee on, decoded from the reverse index.
// Deduped per moment (splits are immutable post-mint; this guards against a
// stray second member with a different pct rather than double-counting).
export async function getRecipientSplits(address: string): Promise<RecipientSplit[]> {
  let members: string[]
  try {
    members = (await redis.smembers(recipientIndexKey(address))) as string[]
  } catch {
    return []
  }
  const byMoment = new Map<string, RecipientSplit>()
  for (const m of members) {
    const first = m.indexOf(':')
    const last = m.lastIndexOf(':')
    if (first <= 0 || last <= first) continue
    const collection = m.slice(0, first)
    const tokenId = m.slice(first + 1, last)
    const pct = Number(m.slice(last + 1))
    if (!isAddress(collection) || !tokenId || !Number.isFinite(pct) || pct <= 0) continue
    byMoment.set(`${collection}:${tokenId}`, { collection, tokenId, pct })
  }
  return [...byMoment.values()]
}

export async function getStoredSplits(
  collection: string,
  tokenId: string,
): Promise<StoredSplitsResult> {
  const raw = await redis.get<unknown>(splitsKey(collection, tokenId))
  return decodeStoredSplits(raw)
}

function decodeStoredSplits(raw: unknown): StoredSplitsResult {
  if (raw === null || raw === undefined) {
    return { hasSplits: false, recipients: [] }
  }
  if (typeof raw === 'string') {
    if (raw === '1') return { hasSplits: true, recipients: [] }
    try {
      const parsed = JSON.parse(raw) as { recipients?: unknown }
      return { hasSplits: true, recipients: validateRecipients(parsed?.recipients) }
    } catch {
      return { hasSplits: true, recipients: [] }
    }
  }
  if (typeof raw === 'object') {
    const obj = raw as { recipients?: unknown }
    return { hasSplits: true, recipients: validateRecipients(obj?.recipients) }
  }
  return { hasSplits: false, recipients: [] }
}

function validateRecipients(input: unknown): SplitRecipient[] {
  if (!Array.isArray(input)) return []
  const out: SplitRecipient[] = []
  for (const e of input) {
    if (!e || typeof e !== 'object') continue
    const obj = e as { address?: unknown; percentAllocation?: unknown }
    if (typeof obj.address !== 'string' || !isAddress(obj.address)) continue
    if (
      typeof obj.percentAllocation !== 'number' ||
      !Number.isFinite(obj.percentAllocation)
    ) {
      continue
    }
    out.push({
      address: obj.address.toLowerCase(),
      percentAllocation: obj.percentAllocation,
    })
  }
  return out
}

type ValidateSplitsResult =
  | { ok: true; splits: SplitRecipient[] }
  | { ok: false; error: string }

// Returns the normalized recipient array sorted ascending by address
// (SplitMain's required ordering) or an error on the first violation.
// Allocations must be integers 1-100 summing to exactly 100 — inprocess
// scales them to SplitMain's 1e6 base and rejects fractions.
export function validateSplitsArray(raw: unknown): ValidateSplitsResult {
  if (!Array.isArray(raw)) return { ok: false, error: 'splits must be an array' }
  if (raw.length < 2) return { ok: false, error: 'splits require at least 2 recipients' }
  if (raw.length > MAX_SPLITS) {
    return { ok: false, error: `splits cannot exceed ${MAX_SPLITS} recipients` }
  }

  const seen = new Set<string>()
  const normalized: SplitRecipient[] = []
  let sum = 0

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'invalid splits entry shape' }
    }
    const e = entry as { address?: unknown; percentAllocation?: unknown }
    if (typeof e.address !== 'string' || !isAddress(e.address)) {
      return { ok: false, error: 'invalid splits address' }
    }
    const pct = e.percentAllocation
    if (typeof pct !== 'number' || !Number.isInteger(pct) || pct < 1 || pct > 100) {
      return { ok: false, error: 'splits allocation must be a whole number 1–100' }
    }
    const lower = e.address.toLowerCase()
    if (seen.has(lower)) {
      return { ok: false, error: `duplicate splits address ${e.address}` }
    }
    seen.add(lower)
    sum += pct
    normalized.push({ address: e.address, percentAllocation: pct })
  }

  if (sum !== 100) {
    return { ok: false, error: `splits must sum to 100% (got ${sum})` }
  }

  normalized.sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  )
  return { ok: true, splits: normalized }
}
