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
}

export async function getStoredSplits(
  collection: string,
  tokenId: string,
): Promise<StoredSplitsResult> {
  const raw = await redis.get<unknown>(splitsKey(collection, tokenId))
  return decodeStoredSplits(raw)
}

// Cheap truthy gate for the distribute flow — both the legacy `'1'`
// flag and the JSON recipient payload qualify a token for distribute.
// Avoids re-parsing recipients we don't need at the gate.
export async function hasRegisteredSplits(
  collection: string,
  tokenId: string,
): Promise<boolean> {
  const exists = await redis.exists(splitsKey(collection, tokenId)).catch(() => 0)
  return exists === 1
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
